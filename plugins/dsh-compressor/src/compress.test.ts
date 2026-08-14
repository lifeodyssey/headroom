import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  compressConversation,
  retrieve,
  type ConversationMessage,
} from "./compress.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "dsh-session-messages.json",
);

const stores: string[] = [];

afterEach(() => {
  for (const dir of stores.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-compressor-store-"));
  stores.push(dir);
  return dir;
}

const LONG_ORIGINAL =
  "build log line: compilation unit failed with diagnostics\n".repeat(80);
const LONG_HASH =
  "64d6e256de1ad9729bb570c78ec9c3ad7701b707dcc31f5d8d08a5ddd1c293af";
const LONG_LOCATOR = `<<compressor:${LONG_HASH}>>`;
const RETRIEVE_HINT =
  "Call compressor_retrieve with this locator or its hash to restore the original. This is not a filesystem path.";
const STUB_CRUSHED = `${LONG_LOCATOR}\n${RETRIEVE_HINT}`;

const PROTECTED_TAIL: ConversationMessage[] = [
  { role: "assistant", content: "tail-1" },
  { role: "assistant", content: "tail-2" },
  { role: "assistant", content: "tail-3" },
  { role: "assistant", content: "tail-4" },
];

function withProtectedTail(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return [...messages, ...PROTECTED_TAIL];
}

describe("compressConversation", () => {
  it("leaves every message unchanged", () => {
    const messages = [
      { role: "user" as const, content: "fix the login" },
      { role: "tool" as const, content: "ok", toolName: "bash" },
    ];

    expect(compressConversation(messages)).toEqual(messages);
  });

  it("loads a redacted DSH-derived fixture as a message list", () => {
    const fixture = JSON.parse(
      readFileSync(fixturePath, "utf8"),
    ) as ConversationMessage[];

    expect(fixture.length).toBeGreaterThan(1);
    expect(
      fixture.every(
        (message) =>
          typeof message.role === "string" &&
          typeof message.content === "string",
      ),
    ).toBe(true);
    expect(JSON.stringify(fixture)).not.toMatch(/\/Users\/|\/private\/var\//);
    expect(compressConversation(fixture)).toEqual(fixture);
  });

  it("writes one disk object and rewrites a long message to a locator plus retrieve hint", () => {
    const storeDir = tempStore();
    const messages = withProtectedTail([
      { role: "tool" as const, content: LONG_ORIGINAL, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });

    expect(compressed).toEqual([
      {
        role: "tool",
        toolName: "bash",
        compressed: true,
        content: STUB_CRUSHED,
      },
      ...PROTECTED_TAIL,
    ]);
    expect(readdirSync(storeDir)).toEqual([LONG_HASH]);
    expect(readFileSync(join(storeDir, LONG_HASH), "utf8")).toBe(LONG_ORIGINAL);
  });

  it("retrieves the original from the full locator", () => {
    const storeDir = tempStore();
    compressConversation(
      withProtectedTail([
        { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
      ]),
      { storeDir },
    );

    expect(retrieve(LONG_LOCATOR, { storeDir })).toBe(LONG_ORIGINAL);
  });

  it("retrieves the original from the bare content hash", () => {
    const storeDir = tempStore();
    compressConversation(
      withProtectedTail([
        { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
      ]),
      { storeDir },
    );

    expect(retrieve(LONG_HASH, { storeDir })).toBe(LONG_ORIGINAL);
  });

  it("retrieves after a simulated restart from disk only", () => {
    const storeDir = tempStore();
    writeFileSync(join(storeDir, LONG_HASH), LONG_ORIGINAL, "utf8");

    expect(retrieve(LONG_LOCATOR, { storeDir })).toBe(LONG_ORIGINAL);
  });

  it("fails clearly when the hash is missing or unknown", () => {
    const storeDir = tempStore();
    const missing =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(() => retrieve(missing, { storeDir })).toThrowError(
      `compressor_retrieve: unknown hash ${missing}`,
    );
    expect(() => retrieve("not-a-locator-or-hash", { storeDir })).toThrowError(
      /compressor_retrieve: missing or unknown hash/,
    );
  });

  it("does not turn a compressor_retrieve result into a new locator", () => {
    const storeDir = tempStore();
    const messages = [
      {
        role: "tool" as const,
        toolName: "compressor_retrieve",
        content: LONG_ORIGINAL,
      },
    ];

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("uses a locator that is obviously not a filesystem path", () => {
    const storeDir = tempStore();
    const [compressed] = compressConversation(
      withProtectedTail([
        { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
      ]),
      { storeDir },
    );

    expect(compressed.content).toBe(STUB_CRUSHED);
    expect(compressed.content).toMatch(/^<<compressor:[0-9a-f]{64}>>\n/);
    expect(compressed.content).not.toMatch(/[/\\]/);
    expect(compressed.content).not.toMatch(/(?:^|[\s])(?:~|\.{0,2}\/)/);
    expect(retrieve(compressed.content, { storeDir })).toBe(LONG_ORIGINAL);
  });

  it("stores originals under DSH home when no storeDir is given", () => {
    const home = tempStore();
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const compressed = compressConversation(
        withProtectedTail([
          { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
        ]),
      );

      expect(compressed[0]?.content).toBe(STUB_CRUSHED);
      expect(readFileSync(join(home, "dsh-compressor", LONG_HASH), "utf8")).toBe(
        LONG_ORIGINAL,
      );
      expect(retrieve(LONG_HASH)).toBe(LONG_ORIGINAL);
    } finally {
      if (previous === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = previous;
      }
    }
  });

  it("never compresses user messages", () => {
    const storeDir = tempStore();
    const messages = withProtectedTail([
      { role: "user", content: LONG_ORIGINAL },
    ]);

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("writes one disk object per content hash", () => {
    const storeDir = tempStore();
    const messages = withProtectedTail([
      { role: "tool" as const, content: LONG_ORIGINAL, toolName: "bash" },
      { role: "assistant" as const, content: LONG_ORIGINAL },
    ]);

    const compressed = compressConversation(messages, { storeDir });

    expect(compressed.map((message) => message.content)).toEqual([
      STUB_CRUSHED,
      STUB_CRUSHED,
      ...PROTECTED_TAIL.map((message) => message.content),
    ]);
    expect(readdirSync(storeDir)).toEqual([LONG_HASH]);
  });

  it("leaves messages under about 250 tokens as-is", () => {
    const storeDir = tempStore();
    const shortOriginal = "ok ".repeat(200);
    const messages = withProtectedTail([
      { role: "tool" as const, content: shortOriginal, toolName: "bash" },
    ]);

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("compresses an eligible message of about 250 tokens", () => {
    const storeDir = tempStore();
    const aroundMinTokens = "abcd".repeat(250);
    const messages = withProtectedTail([
      { role: "tool" as const, content: aroundMinTokens, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });

    expect(compressed[0]?.compressed).toBe(true);
    expect(compressed[0]?.content).toMatch(/^<<compressor:[0-9a-f]{64}>>\n/);
    expect(compressed[0]?.content.length).toBeLessThan(aroundMinTokens.length);
    expect(retrieve(compressed[0]?.content, { storeDir })).toBe(aroundMinTokens);
  });

  it("leaves excluded coding-tool and retrieve results verbatim", () => {
    const storeDir = tempStore();
    const excludedTools = [
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "WebSearch",
      "WebFetch",
      "compressor_retrieve",
      "headroom_retrieve",
      "read",
      "web_search",
      "web_fetch",
    ];
    const messages = withProtectedTail(
      excludedTools.map((toolName) => ({
        role: "tool" as const,
        toolName,
        content: LONG_ORIGINAL,
      })),
    );

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("compresses an eligible long system message", () => {
    const storeDir = tempStore();
    const messages = withProtectedTail([
      { role: "system" as const, content: LONG_ORIGINAL },
    ]);

    const compressed = compressConversation(messages, { storeDir });

    expect(compressed[0]).toEqual({
      role: "system",
      compressed: true,
      content: STUB_CRUSHED,
    });
    expect(retrieve(STUB_CRUSHED, { storeDir })).toBe(LONG_ORIGINAL);
  });

  it("does not nest an already-marked compressed message into another locator", () => {
    const storeDir = tempStore();
    const messages = withProtectedTail([
      {
        role: "tool" as const,
        toolName: "bash",
        compressed: true,
        content: LONG_ORIGINAL,
      },
    ]);

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("leaves a message as-is when a locator would not shrink it", () => {
    const storeDir = tempStore();
    const originals = withProtectedTail([
      { role: "tool" as const, content: LONG_ORIGINAL, toolName: "bash" },
      { role: "system" as const, content: "x".repeat(1000) },
    ]);

    const compressed = compressConversation(originals, { storeDir });

    for (const [index, message] of compressed.entries()) {
      expect(message.content.length).toBeLessThanOrEqual(
        originals[index]!.content.length,
      );
    }
    expect(compressed[0]?.content.length).toBeLessThan(LONG_ORIGINAL.length);
    expect(compressed[1]?.content.length).toBeLessThan(1000);
  });

  it("never compresses the last four messages", () => {
    const storeDir = tempStore();
    const messages = [
      { role: "tool" as const, content: LONG_ORIGINAL, toolName: "bash" },
      { role: "assistant" as const, content: LONG_ORIGINAL },
      { role: "system" as const, content: LONG_ORIGINAL },
      { role: "tool" as const, content: LONG_ORIGINAL, toolName: "bash" },
    ];

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });
});
