import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Headroom coding-agent defaults: skip user turns; protect the live tail;
// skip messages under about 250 tokens.
const PROTECT_RECENT = 4;
const MIN_TOKENS_TO_COMPRESS = 250;
const CHARS_PER_TOKEN = 4;
const CHARS_PER_TOKEN_CJK = 1.5;
const RETRIEVE_HINT = "Call compressor_retrieve with this locator or its hash to restore the original. This is not a filesystem path.";
function contentHash(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}
function resolveStoreDir(storeDir) {
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
const LOG_LINE_PATTERN = /\b(?:error|fail(?:ed)?|fatal|critical|warn(?:ing)?|info|debug|trace|passed|skipped)\b|^\s*\d{4}-\d{2}-\d{2}|^\s*\[\d{2}:\d{2}:\d{2}\]|^={3,}|^-{3,}|^npm ERR!|Traceback \(most recent call last\)/i;
const ERROR_OR_FAIL = /\b(?:error|fail(?:ed)?|fatal|critical)\b/i;
function isExcludedTool(toolName) {
    return toolName !== undefined && DEFAULT_EXCLUDE_TOOLS.has(toolName.toLowerCase());
}
function isCjkCodePoint(codePoint) {
    return ((codePoint >= 0x3000 && codePoint <= 0x303f) ||
        (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
        (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
        (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xff00 && codePoint <= 0xffef) ||
        (codePoint >= 0x20000 && codePoint <= 0x2a6df));
}
function isLogShaped(text) {
    const nonEmpty = text.split("\n").filter((line) => line.trim().length > 0);
    if (nonEmpty.length < MIN_LOG_LINES) {
        return false;
    }
    const matches = nonEmpty.filter((line) => LOG_LINE_PATTERN.test(line)).length;
    return matches / nonEmpty.length >= LOG_PATTERN_RATIO;
}
function collapseConsecutiveDuplicates(lines) {
    const collapsed = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        let count = 1;
        while (index + count < lines.length && lines[index + count] === line) {
            count += 1;
        }
        collapsed.push(count > 1 ? `${line} (×${count})` : line);
        index += count;
    }
    return collapsed;
}
function listTemplate(line) {
    return line.trim().replace(/\d+/g, "#").replace(/\s+/g, " ");
}
function isStructuredList(text) {
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length < MIN_LIST_ITEMS) {
        return false;
    }
    const prefixHits = lines.filter((line) => LIST_PREFIX.test(line)).length;
    if (prefixHits / lines.length >= LIST_SIMILARITY_RATIO) {
        return true;
    }
    const counts = new Map();
    for (const line of lines) {
        const template = listTemplate(line);
        counts.set(template, (counts.get(template) ?? 0) + 1);
    }
    return Math.max(...counts.values()) / lines.length >= LIST_SIMILARITY_RATIO;
}
function tryParseJsonArray(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("[")) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function formatListItem(item) {
    return typeof item === "string" ? item : JSON.stringify(item);
}
function crushStructuredList(items) {
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
function crushLog(text) {
    const collapsed = collapseConsecutiveDuplicates(text.split("\n"));
    const keep = new Set();
    let errors = 0;
    for (let i = 0; i < collapsed.length; i++) {
        if (errors < MAX_ERROR_LINES && ERROR_OR_FAIL.test(collapsed[i])) {
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
        .map((i) => collapsed[i])
        .join("\n");
}
function visibleCrush(original, hash) {
    const locatorAndHint = `<<compressor:${hash}>>\n${RETRIEVE_HINT}`;
    const jsonItems = tryParseJsonArray(original);
    if (jsonItems !== undefined && jsonItems.length >= MIN_LIST_ITEMS) {
        return `${crushStructuredList(jsonItems)}\n${locatorAndHint}`;
    }
    if (isLogShaped(original)) {
        return `${crushLog(original)}\n${locatorAndHint}`;
    }
    if (isStructuredList(original)) {
        const lines = original.split("\n").filter((line) => line.trim().length > 0);
        return `${crushStructuredList(lines)}\n${locatorAndHint}`;
    }
    return locatorAndHint;
}
function estimateTokens(text) {
    if (text.length === 0) {
        return 0;
    }
    let cjk = 0;
    let other = 0;
    for (const char of text) {
        const codePoint = char.codePointAt(0);
        if (codePoint !== undefined && isCjkCodePoint(codePoint)) {
            cjk += 1;
        }
        else {
            other += 1;
        }
    }
    return Math.max(1, Math.round(other / CHARS_PER_TOKEN + cjk / CHARS_PER_TOKEN_CJK));
}
export function retrieve(locatorOrHash, options) {
    if (typeof locatorOrHash !== "string" || locatorOrHash.length === 0) {
        throw new Error("compressor_retrieve: missing or unknown hash");
    }
    const locatorMatch = locatorOrHash.match(LOCATOR_PATTERN);
    const hash = locatorMatch?.[1] ??
        (BARE_HASH_PATTERN.test(locatorOrHash) ? locatorOrHash : undefined);
    if (hash === undefined) {
        throw new Error("compressor_retrieve: missing or unknown hash");
    }
    try {
        return readFileSync(join(resolveStoreDir(options?.storeDir), hash), "utf8");
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            throw new Error(`compressor_retrieve: unknown hash ${hash}`);
        }
        throw error;
    }
}
export function compressConversation(messages, options) {
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
        const crushed = visibleCrush(message.content, hash);
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
//# sourceMappingURL=compress.js.map