import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  compressConversation,
  retrieve,
  type ConversationMessage,
} from "./compress.js";
import { apply } from "./index.js";
import { rewriteSessionToolResults } from "./session-rewrite.js";

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

const PROTECTED_TAIL: ConversationMessage[] = [
  { role: "assistant", content: "tail-1" },
  { role: "assistant", content: "tail-2" },
  { role: "assistant", content: "tail-3" },
  { role: "assistant", content: "tail-4" },
];

const stores: string[] = [];

afterEach(() => {
  for (const dir of stores.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("real DSH session payloads", () => {
  it("compresses a redacted DSH run_code tool result end to end", () => {
    const original = readFileSync(
      join(fixturesRoot, "dsh-tool-result-log.txt"),
      "utf8",
    );
    expect(original.length).toBeGreaterThan(10_000);

    const storeDir = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
    stores.push(storeDir);
    const [crushed] = compressConversation(
      [
        { role: "tool", content: original, toolName: "run_code" },
        ...PROTECTED_TAIL,
      ],
      { storeDir },
    );

    expect(crushed?.content.length).toBeLessThan(original.length);
    expect(crushed?.content).toMatch(/<<compressor:[0-9a-f]{64}>>/);
    expect(retrieve(crushed?.content, { storeDir })).toBe(original);
    expect(JSON.stringify(crushed)).not.toMatch(/\/Users\/lumimamini/);
  });

  it("compresses a redacted DSH shell-shaped tool result end to end", () => {
    const original = readFileSync(
      join(fixturesRoot, "dsh-tool-result-shell.json.txt"),
      "utf8",
    );
    expect(original.length).toBeGreaterThan(10_000);

    const storeDir = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
    stores.push(storeDir);
    const [crushed] = compressConversation(
      [
        { role: "tool", content: original, toolName: "bash" },
        ...PROTECTED_TAIL,
      ],
      { storeDir },
    );

    expect(crushed?.content.length).toBeLessThan(original.length);
    expect(retrieve(crushed?.content, { storeDir })).toBe(original);
  });

  it("rewrites that DSH tool result through the pre-step session surface", () => {
    const original = readFileSync(
      join(fixturesRoot, "dsh-tool-result-shell.json.txt"),
      "utf8",
    );
    const session = {
      events: [] as Array<{ type: string; seq: number; data: unknown }>,
      surface: { nodes: [2, 3, 4, 5, 6] },
      appended: [] as Array<{ type: string; opts?: { surfaceOp?: { op?: string } } }>,
      append(
        type: string,
        _data: unknown,
        opts?: { surfaceOp?: { op?: string } },
      ) {
        this.appended.push({ type, opts });
        return { seq: 99 };
      },
    };
    session.events[1] = {
      type: "tool/call",
      seq: 1,
      data: { callId: "call-bash", name: "bash" },
    };
    session.events[2] = {
      type: "tool/result",
      seq: 2,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "msg",
          role: "user",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-bash",
              content: [{ type: "text", text: original }],
            },
          ],
          source: { kind: "tool", callId: "call-bash" },
        },
      },
    };
    for (let seq = 3; seq <= 6; seq += 1) {
      session.events[seq] = {
        type: "assistant/message",
        seq,
        data: {
          message: {
            role: "assistant",
            content: [{ type: "text", text: `tail-${seq}` }],
          },
        },
      };
    }

    apply({ on() {}, emit() {}, tools: { register() {} } });
    const result = rewriteSessionToolResults(session);
    expect(result.replaced).toBe(1);
    expect(session.appended[0]?.opts?.surfaceOp?.op).toBe("replace");
  });
});
