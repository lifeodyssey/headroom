import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { crushByDetectedType, nativeAvailable } from "./native.js";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type ConversationMessage = {
  role: MessageRole;
  content: string;
  toolName?: string;
  compressed?: boolean;
};

export type CompressOptions = {
  storeDir?: string;
};

// Headroom coding-agent defaults: skip user turns; protect the live tail;
// skip messages under about 250 tokens.
const PROTECT_RECENT = 4;
const MIN_TOKENS_TO_COMPRESS = 250;
const CHARS_PER_TOKEN = 4;
const CHARS_PER_TOKEN_CJK = 1.5;
const RETRIEVE_HINT =
  "Call compressor_retrieve with this locator or its hash to restore the original. This is not a filesystem path.";

function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function resolveStoreDir(storeDir?: string): string {
  if (storeDir !== undefined && storeDir.length > 0) {
    return storeDir;
  }
  const home = process.env.DSH_HOME?.trim();
  const root = home !== undefined && home.length > 0 ? home : join(homedir(), ".dsh");
  return join(root, "dsh-compressor");
}

const DEFAULT_EXCLUDE_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "write",
  "edit",
  "websearch",
  "web_search",
  "webfetch",
  "web_fetch",
  "compressor_retrieve",
  "headroom_retrieve",
]);

const LOCATOR_PATTERN = /<<compressor:([0-9a-f]{64})>>/;
const BARE_HASH_PATTERN = /^[0-9a-f]{64}$/;

// Slim extractive log crush: errors/FAIL, last lines, collapse consecutive dups.
const MIN_LOG_LINES = 8;
const LOG_PATTERN_RATIO = 0.1;
const MAX_ERROR_LINES = 20;
const LAST_LOG_LINES = 8;
const MAX_LOG_LINES = 40;
// Slim SmartCrusher-style list crush: first/last items, counts, collapse dups.
const MIN_LIST_ITEMS = 8;
const FIRST_LIST_ITEMS = 3;
const LAST_LIST_ITEMS = 3;
const MAX_LIST_ITEMS = 15;
const LIST_SIMILARITY_RATIO = 0.5;
const LIST_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s/;
// Slim CJK-aware prose crush: extractive sentences/clauses, keep anchors.
// Hangul uses eojeol + syllable bigrams, not CJK unigrams or English words.
const MIN_PROSE_SEGMENTS = 6;
const PROSE_TARGET_RATIO = 0.35;
const CJK_SEGMENT_SOFT = 60;
const CJK_SEGMENT_HARD = 40;
const CJK_TERMINATORS = new Set(["。", "！", "？"]);
const ASCII_TERMINATORS = new Set([".", "!", "?"]);
const CJK_SECONDARY = new Set(["、", "，", "；", "：", "·", "…", ",", ";"]);
const ERROR_LIKE =
  /\b(?:error|exception|fail(?:ed|ure)?|fatal|critical|warning|traceback|assert|todo|fixme)\b|失败|错误|失敗|エラー|오류|실패/i;
const TITLE_MARK = /[《「『【][^》」』】]{1,40}[》」』】]/;
const LATIN_WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
const LOG_LINE_PATTERN =
  /\b(?:error|fail(?:ed)?|fatal|critical|warn(?:ing)?|info|debug|trace|passed|skipped)\b|^\s*\d{4}-\d{2}-\d{2}|^\s*\[\d{2}:\d{2}:\d{2}\]|^={3,}|^-{3,}|^npm ERR!|Traceback \(most recent call last\)/i;
const ERROR_OR_FAIL = /\b(?:error|fail(?:ed)?|fatal|critical)\b/i;

function isExcludedTool(toolName: string | undefined): boolean {
  return toolName !== undefined && DEFAULT_EXCLUDE_TOOLS.has(toolName.toLowerCase());
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df)
  );
}

function isLogShaped(text: string): boolean {
  const nonEmpty = text.split("\n").filter((line) => line.trim().length > 0);
  if (nonEmpty.length < MIN_LOG_LINES) {
    return false;
  }
  const matches = nonEmpty.filter((line) => LOG_LINE_PATTERN.test(line)).length;
  return matches / nonEmpty.length >= LOG_PATTERN_RATIO;
}

function collapseConsecutiveDuplicates(lines: readonly string[]): string[] {
  const collapsed: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    let count = 1;
    while (index + count < lines.length && lines[index + count] === line) {
      count += 1;
    }
    collapsed.push(count > 1 ? `${line} (×${count})` : line);
    index += count;
  }
  return collapsed;
}

function listTemplate(line: string): string {
  return line.trim().replace(/\d+/g, "#").replace(/\s+/g, " ");
}

function isStructuredList(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < MIN_LIST_ITEMS) {
    return false;
  }
  const prefixHits = lines.filter((line) => LIST_PREFIX.test(line)).length;
  if (prefixHits / lines.length >= LIST_SIMILARITY_RATIO) {
    return true;
  }
  const counts = new Map<string, number>();
  for (const line of lines) {
    const template = listTemplate(line);
    counts.set(template, (counts.get(template) ?? 0) + 1);
  }
  return Math.max(...counts.values()) / lines.length >= LIST_SIMILARITY_RATIO;
}

function tryParseJsonArray(text: string): unknown[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function formatListItem(item: unknown): string {
  return typeof item === "string" ? item : JSON.stringify(item);
}

function crushStructuredList(items: readonly unknown[]): string {
  const collapsed = collapseConsecutiveDuplicates(items.map(formatListItem));
  const header = `${items.length} items`;
  if (collapsed.length <= MAX_LIST_ITEMS) {
    return [header, ...collapsed].join("\n");
  }
  const omitted = collapsed.length - FIRST_LIST_ITEMS - LAST_LIST_ITEMS;
  return [
    header,
    ...collapsed.slice(0, FIRST_LIST_ITEMS),
    `… ${omitted} more …`,
    ...collapsed.slice(-LAST_LIST_ITEMS),
  ].join("\n");
}

function crushLog(text: string): string {
  const collapsed = collapseConsecutiveDuplicates(text.split("\n"));
  const keep = new Set<number>();
  let errors = 0;
  for (let i = 0; i < collapsed.length; i++) {
    if (errors < MAX_ERROR_LINES && ERROR_OR_FAIL.test(collapsed[i]!)) {
      keep.add(i);
      errors += 1;
    }
  }
  const tailStart = Math.max(0, collapsed.length - LAST_LOG_LINES);
  for (let i = tailStart; i < collapsed.length; i++) {
    keep.add(i);
  }
  return [...keep]
    .sort((a, b) => a - b)
    .slice(0, MAX_LOG_LINES)
    .map((i) => collapsed[i]!)
    .join("\n");
}

function isHangulCodePoint(codePoint: number): boolean {
  return codePoint >= 0xac00 && codePoint <= 0xd7af;
}

function isHanOrKanaCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df)
  );
}

function charHasCjk(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && isCjkCodePoint(codePoint);
}

function textHasCjk(text: string): boolean {
  for (const char of text) {
    if (charHasCjk(char)) {
      return true;
    }
  }
  return false;
}

function splitSentences(line: string): string[] {
  const segs: string[] = [];
  let current = "";
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    current += char;
    const next = chars[i + 1];
    const cjkTerm = CJK_TERMINATORS.has(char);
    const asciiTerm =
      ASCII_TERMINATORS.has(char) &&
      (next === undefined || /\s/.test(next) || charHasCjk(next));
    if (cjkTerm || asciiTerm) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        segs.push(trimmed);
      }
      current = "";
    }
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) {
    segs.push(trimmed);
  }
  return segs;
}

function applyCjkLengthFallback(segments: readonly string[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    const chars = [...segment];
    if (chars.length <= CJK_SEGMENT_SOFT || !textHasCjk(segment)) {
      out.push(segment);
      continue;
    }
    let piece = "";
    let pieceChars = 0;
    for (const char of chars) {
      piece += char;
      pieceChars += 1;
      const soft = /\s/.test(char) || CJK_SECONDARY.has(char);
      if ((soft && pieceChars >= CJK_SEGMENT_HARD / 2) || pieceChars >= CJK_SEGMENT_HARD) {
        const trimmed = piece.trim();
        if (trimmed.length > 0) {
          out.push(trimmed);
        }
        piece = "";
        pieceChars = 0;
      }
    }
    const trimmed = piece.trim();
    if (trimmed.length > 0) {
      out.push(trimmed);
    }
  }
  return out;
}

function splitProseSegments(text: string): string[] {
  const segs: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    segs.push(...splitSentences(trimmed));
  }
  return applyCjkLengthFallback(segs);
}

function scriptBigrams(
  text: string,
  pred: (codePoint: number) => boolean,
): string[] {
  const grams: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    for (let i = 0; i < run.length - 1; i++) {
      grams.push(`${run[i]!}${run[i + 1]!}`);
    }
    run = [];
  };
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && pred(codePoint)) {
      run.push(char);
    } else {
      flush();
    }
  }
  flush();
  return grams;
}

function documentFrequency(gramsPerSeg: readonly string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const grams of gramsPerSeg) {
    for (const gram of new Set(grams)) {
      df.set(gram, (df.get(gram) ?? 0) + 1);
    }
  }
  return df;
}

function hasLatinIdentifier(text: string): boolean {
  for (const match of text.matchAll(LATIN_WORD)) {
    const word = match[0];
    if (word.includes("_") || /[a-z][A-Z]/.test(word)) {
      return true;
    }
    const letters = word.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 2 && letters === letters.toUpperCase()) {
      return true;
    }
  }
  return false;
}

function strongAnchorScore(segment: string): number {
  let score = 0;
  if (segment.includes("://")) {
    score += 2;
  }
  if (ERROR_LIKE.test(segment)) {
    score += 2;
  }
  if (TITLE_MARK.test(segment)) {
    score += 2;
  }
  if (hasLatinIdentifier(segment)) {
    score += 1.5;
  }
  if (/(?:^|[\s])(?:\/|~\/)\S+/.test(segment) || /(?:^|[\s])--?[A-Za-z]/.test(segment)) {
    score += 1;
  }
  return score;
}

function proseTemplate(segment: string): string {
  return segment.replace(/\d+/g, "#").replace(/\s+/g, " ");
}

function crushProse(text: string): string {
  const segments = splitProseSegments(text);
  if (segments.length < MIN_PROSE_SEGMENTS) {
    return "";
  }

  const hangulGrams = segments.map((segment) =>
    scriptBigrams(segment, isHangulCodePoint),
  );
  const hanGrams = segments.map((segment) =>
    scriptBigrams(segment, isHanOrKanaCodePoint),
  );
  const hangulDf = documentFrequency(hangulGrams);
  const hanDf = documentFrequency(hanGrams);
  const n = segments.length;
  const scores = segments.map((segment, index) => {
    let rareHangul = 0;
    for (const gram of new Set(hangulGrams[index]!)) {
      if (hangulDf.get(gram) === 1) {
        rareHangul += 0.8;
      }
    }
    let rareHan = 0;
    for (const gram of new Set(hanGrams[index]!)) {
      if (hanDf.get(gram) === 1) {
        rareHan += 0.4;
      }
    }
    return (
      (index + 1) / n +
      strongAnchorScore(segment) +
      (/\d/.test(segment) ? 0.3 : 0) +
      rareHangul +
      rareHan
    );
  });

  const targetChars = Math.max(1, Math.floor(text.length * PROSE_TARGET_RATIO));
  const keep = new Set<number>();
  let keptChars = 0;
  for (let i = 0; i < n; i++) {
    if (strongAnchorScore(segments[i]!) > 0) {
      keep.add(i);
      keptChars += segments[i]!.length;
    }
  }

  const order = segments.map((_, index) => index).sort((a, b) => {
    const delta = scores[b]! - scores[a]!;
    return delta !== 0 ? delta : a - b;
  });
  const seenTemplates = new Set<string>();
  for (const i of keep) {
    seenTemplates.add(proseTemplate(segments[i]!));
  }
  for (const i of order) {
    if (keep.has(i) || keptChars >= targetChars) {
      continue;
    }
    const template = proseTemplate(segments[i]!);
    if (seenTemplates.has(template)) {
      continue;
    }
    keep.add(i);
    seenTemplates.add(template);
    keptChars += segments[i]!.length;
  }

  if (keep.size === 0) {
    return "";
  }
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => segments[i]!)
    .join("\n");
}

// Mixed messages: split sections, crush each, one locator for the whole original.
type SectionKind = "json" | "log" | "list" | "prose" | "other";

type ContentSection = {
  kind: SectionKind;
  content: string;
};

function scanJsonLine(
  line: string,
  inString: boolean,
  escaped: boolean,
): {
  bracket: number;
  brace: number;
  inString: boolean;
  escaped: boolean;
} {
  let bracket = 0;
  let brace = 0;
  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) {
        escaped = true;
      }
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "[") {
      bracket += 1;
    } else if (char === "]") {
      bracket -= 1;
    } else if (char === "{") {
      brace += 1;
    } else if (char === "}") {
      brace -= 1;
    }
  }
  return { bracket, brace, inString, escaped };
}

function extractJsonBlock(
  lines: readonly string[],
  start: number,
): { text: string; end: number } | undefined {
  let bracketCount = 0;
  let braceCount = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < lines.length; i++) {
    const step = scanJsonLine(lines[i]!, inString, escaped);
    bracketCount += step.bracket;
    braceCount += step.brace;
    inString = step.inString;
    escaped = step.escaped;
    if (bracketCount > 0 || braceCount > 0) {
      continue;
    }
    const text = lines.slice(start, i + 1).join("\n");
    try {
      JSON.parse(text);
      return { text, end: i };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function lineKind(line: string): SectionKind | "blank" {
  if (line.trim().length === 0) {
    return "blank";
  }
  if (LIST_PREFIX.test(line)) {
    return "list";
  }
  if (LOG_LINE_PATTERN.test(line)) {
    return "log";
  }
  if (textHasCjk(line)) {
    return "prose";
  }
  return "other";
}

function refineKind(content: string): SectionKind {
  const jsonItems = tryParseJsonArray(content);
  if (jsonItems !== undefined && jsonItems.length >= MIN_LIST_ITEMS) {
    return "json";
  }
  if (isLogShaped(content)) {
    return "log";
  }
  if (isStructuredList(content)) {
    return "list";
  }
  if (
    textHasCjk(content) &&
    splitProseSegments(content).length >= MIN_PROSE_SEGMENTS
  ) {
    return "prose";
  }
  return "other";
}

function crushSection(section: ContentSection): string {
  if (section.kind === "json") {
    const jsonItems = tryParseJsonArray(section.content);
    if (jsonItems !== undefined) {
      return crushStructuredList(jsonItems);
    }
  }
  if (section.kind === "log") {
    return crushLog(section.content);
  }
  if (section.kind === "list") {
    const lines = section.content
      .split("\n")
      .filter((line) => line.trim().length > 0);
    return crushStructuredList(lines);
  }
  if (section.kind === "prose") {
    return crushProse(section.content);
  }
  return section.content;
}

function splitTextRun(text: string): ContentSection[] {
  const groups: { kind: SectionKind; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    const kind = lineKind(line);
    const last = groups[groups.length - 1];
    if (kind === "blank") {
      if (last !== undefined) {
        last.lines.push(line);
      }
      continue;
    }
    if (last === undefined) {
      groups.push({ kind, lines: [line] });
      continue;
    }
    if (last.kind === "other" && kind !== "other") {
      last.kind = kind;
      last.lines.push(line);
      continue;
    }
    if (kind === "other" || kind === last.kind) {
      last.lines.push(line);
      continue;
    }
    groups.push({ kind, lines: [line] });
  }

  const sections: ContentSection[] = [];
  for (const group of groups) {
    const content = group.lines.join("\n").trim();
    if (content.length === 0) {
      continue;
    }
    sections.push({ kind: refineKind(content), content });
  }
  return sections;
}

function splitIntoSections(content: string): ContentSection[] {
  const lines = content.split("\n");
  const sections: ContentSection[] = [];
  let textStart = 0;
  let index = 0;

  const flushText = (end: number): void => {
    if (end <= textStart) {
      return;
    }
    const text = lines.slice(textStart, end).join("\n");
    if (text.trim().length === 0) {
      return;
    }
    sections.push(...splitTextRun(text));
  };

  while (index < lines.length) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const extracted = extractJsonBlock(lines, index);
      if (extracted !== undefined) {
        flushText(index);
        sections.push({
          kind: refineKind(extracted.text),
          content: extracted.text,
        });
        index = extracted.end + 1;
        textStart = index;
        continue;
      }
    }
    index += 1;
  }
  flushText(lines.length);
  return sections;
}

function crushSingle(original: string): string {
  const jsonItems = tryParseJsonArray(original);
  if (jsonItems !== undefined && jsonItems.length >= MIN_LIST_ITEMS) {
    return crushStructuredList(jsonItems);
  }
  if (isLogShaped(original)) {
    return crushLog(original);
  }
  if (isStructuredList(original)) {
    const lines = original.split("\n").filter((line) => line.trim().length > 0);
    return crushStructuredList(lines);
  }
  if (textHasCjk(original)) {
    return crushProse(original);
  }
  return "";
}

function lastUserQuery(
  messages: readonly ConversationMessage[],
  index: number,
): string {
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return messages[i]!.content;
    }
  }
  return "";
}

function visibleCrush(original: string, hash: string, query = ""): string {
  const locatorAndHint = `<<compressor:${hash}>>\n${RETRIEVE_HINT}`;
  if (nativeAvailable()) {
    const crushed = crushByDetectedType(original, query).compressed;
    if (crushed.length === 0) {
      return locatorAndHint;
    }
    if (crushed === original) {
      return original;
    }
    return `${crushed}\n${locatorAndHint}`;
  }
  const sections = splitIntoSections(original);
  const crushable = new Set(
    sections.map((section) => section.kind).filter((kind) => kind !== "other"),
  );
  const visible =
    crushable.size >= 2
      ? sections
          .map((section) => crushSection(section))
          .filter((part) => part.length > 0)
          .join("\n\n")
      : crushSingle(original);
  return visible.length > 0 ? `${visible}\n${locatorAndHint}` : locatorAndHint;
}

function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isCjkCodePoint(codePoint)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.max(1, Math.round(other / CHARS_PER_TOKEN + cjk / CHARS_PER_TOKEN_CJK));
}

export function retrieve(
  locatorOrHash: string | undefined,
  options?: CompressOptions,
): string {
  if (typeof locatorOrHash !== "string" || locatorOrHash.length === 0) {
    throw new Error("compressor_retrieve: missing or unknown hash");
  }
  const locatorMatch = locatorOrHash.match(LOCATOR_PATTERN);
  const hash =
    locatorMatch?.[1] ??
    (BARE_HASH_PATTERN.test(locatorOrHash) ? locatorOrHash : undefined);
  if (hash === undefined) {
    throw new Error("compressor_retrieve: missing or unknown hash");
  }
  try {
    return readFileSync(join(resolveStoreDir(options?.storeDir), hash), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`compressor_retrieve: unknown hash ${hash}`);
    }
    throw error;
  }
}

export function compressConversation(
  messages: readonly ConversationMessage[],
  options?: CompressOptions,
): ConversationMessage[] {
  return messages.map((message, index) => {
    if (message.role === "user") {
      return { ...message };
    }
    if (messages.length - index <= PROTECT_RECENT) {
      return { ...message };
    }
    if (isExcludedTool(message.toolName)) {
      return { ...message };
    }
    if (message.compressed === true) {
      return { ...message };
    }
    if (estimateTokens(message.content) < MIN_TOKENS_TO_COMPRESS) {
      return { ...message };
    }

    const hash = contentHash(message.content);
    const crushed = visibleCrush(
      message.content,
      hash,
      lastUserQuery(messages, index),
    );
    if (crushed.length >= message.content.length) {
      return { ...message };
    }

    const storeDir = resolveStoreDir(options?.storeDir);
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, hash), message.content, "utf8");

    return {
      ...message,
      compressed: true,
      content: crushed,
    };
  });
}
