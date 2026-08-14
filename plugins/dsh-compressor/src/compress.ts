import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
    const crushed = `<<compressor:${hash}>>\n${RETRIEVE_HINT}`;
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
