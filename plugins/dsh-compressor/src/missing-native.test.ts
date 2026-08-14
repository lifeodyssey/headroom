import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./native.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./native.js")>();
  return {
    ...actual,
    nativeAvailable: () => false,
  };
});

import { compressConversation, type ConversationMessage } from "./compress.js";
import { nativeAvailable } from "./native.js";

const LONG_ORIGINAL =
  "build log line: compilation unit failed with diagnostics\n".repeat(80);

const PROTECTED_TAIL: ConversationMessage[] = [
  { role: "assistant", content: "tail-1" },
  { role: "assistant", content: "tail-2" },
  { role: "assistant", content: "tail-3" },
  { role: "assistant", content: "tail-4" },
];

const stores: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of stores.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("compressConversation when native is unavailable", () => {
  it("leaves a long bash log unchanged and does not write a locator", () => {
    expect(nativeAvailable()).toBe(false);

    const storeDir = mkdtempSync(join(tmpdir(), "dsh-compressor-store-"));
    stores.push(storeDir);
    const messages: ConversationMessage[] = [
      { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
      ...PROTECTED_TAIL,
    ];

    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const compressed = compressConversation(messages, { storeDir });

    expect(compressed).toEqual(messages);
    expect(compressed[0]?.content).toBe(LONG_ORIGINAL);
    expect(compressed[0]?.content).not.toMatch(/<<compressor:/);
    expect(readdirSync(storeDir)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/native addon unavailable/);

    compressConversation(messages, { storeDir });
    expect(error).toHaveBeenCalledTimes(1);
  });
});
