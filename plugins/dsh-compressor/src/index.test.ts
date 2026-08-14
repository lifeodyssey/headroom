import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { apply, compressConversation, inject } from "./index.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

const LONG_ORIGINAL =
  "build log line: compilation unit failed with diagnostics\n".repeat(80);
const LONG_HASH =
  "64d6e256de1ad9729bb570c78ec9c3ad7701b707dcc31f5d8d08a5ddd1c293af";
const LONG_LOCATOR = `<<compressor:${LONG_HASH}>>`;

describe("plugin surface", () => {
  it("does not replace official spill or take a Headroom proxy URL", () => {
    const provided: string[] = [];
    const ctx = {
      provide(key: string, _value: unknown) {
        provided.push(key);
      },
    };

    apply(ctx);

    expect(provided).not.toContain("spillStore");
  });

  it("registers compressor_retrieve when ctx.tools.register exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-compressor-"));
    homes.push(home);
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = home;

    type RetrieveTool = {
      name: string;
      execute: (args: { locator: string }) => unknown;
    };
    const registered: RetrieveTool[] = [];

    try {
      compressConversation([
        { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
      ]);

      apply({
        tools: {
          register(tool: RetrieveTool) {
            registered.push(tool);
          },
        },
      });

      expect(inject).toEqual(["tools"]);
      expect(registered).toHaveLength(1);
      expect(registered[0]?.name).toBe("compressor_retrieve");
      await expect(registered[0]?.execute({ locator: LONG_LOCATOR })).resolves.toBe(
        LONG_ORIGINAL,
      );
      await expect(registered[0]?.execute({ locator: LONG_HASH })).resolves.toBe(
        LONG_ORIGINAL,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = previous;
      }
    }
  });
});
