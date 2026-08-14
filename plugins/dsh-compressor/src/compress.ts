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

// Stub length gate for #3. Official skip policy (tokens, last-4, user) is #4.
const MIN_ELIGIBLE_CHARS = 1024;
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

const LOCATOR_PATTERN = /<<compressor:([0-9a-f]{64})>>/;
const BARE_HASH_PATTERN = /^[0-9a-f]{64}$/;

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
  return messages.map((message) => {
    if (message.toolName === "compressor_retrieve") {
      return { ...message };
    }
    if (message.content.length < MIN_ELIGIBLE_CHARS) {
      return { ...message };
    }

    const hash = contentHash(message.content);
    const storeDir = resolveStoreDir(options?.storeDir);
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, hash), message.content, "utf8");

    return {
      ...message,
      compressed: true,
      content: `<<compressor:${hash}>>\n${RETRIEVE_HINT}`,
    };
  });
}
