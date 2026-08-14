import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  apply,
  compressConversation,
  inject,
  type ConversationMessage,
} from "./index.js";

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
const RETRIEVE_HINT =
  "Call compressor_retrieve with this locator or its hash to restore the original. This is not a filesystem path.";
const PROTECTED_TAIL: ConversationMessage[] = [
  { role: "assistant", content: "tail-1" },
  { role: "assistant", content: "tail-2" },
  { role: "assistant", content: "tail-3" },
  { role: "assistant", content: "tail-4" },
];

type Listener = (...args: unknown[]) => unknown;

type PromptSection = {
  name: string;
  order: number;
  text: string | ((context: unknown) => string);
};

type RetrieveTool = {
  name: string;
  execute: (args: { locator: string }) => unknown;
};

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "dsh-compressor-"));
  homes.push(home);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) {
      delete process.env.DSH_HOME;
    } else {
      process.env.DSH_HOME = previous;
    }
  }
}

function fakeCtx() {
  const listeners = new Map<string, Listener[]>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const provided: string[] = [];
  const sections: PromptSection[] = [];
  const tools: RetrieveTool[] = [];

  const ctx = {
    on(event: string, handler: Listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
    },
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
    },
    provide(key: string, _value: unknown) {
      provided.push(key);
    },
    tools: {
      register(tool: RetrieveTool) {
        tools.push(tool);
      },
    },
    systemPrompt: {
      section(section: PromptSection) {
        sections.push(section);
      },
    },
  };

  return { ctx, listeners, emitted, provided, sections, tools };
}

function handler(listeners: Map<string, Listener[]>, event: string): Listener {
  const registered = listeners.get(event);
  if (registered === undefined || registered[0] === undefined) {
    throw new Error(`missing listener for ${event}`);
  }
  return registered[0];
}

function textBlocks(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

describe("plugin surface", () => {
  it("does not replace official spill or take a Headroom proxy URL", () => {
    const { ctx, provided, listeners } = fakeCtx();

    apply(ctx);

    expect(provided).not.toContain("spillStore");
    expect(listeners.has("llm/stream")).toBe(false);
  });

  it("registers compressor_retrieve when ctx.tools.register exists", async () => {
    await withHome(async () => {
      compressConversation([
        { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
        ...PROTECTED_TAIL,
      ]);

      const { ctx, tools } = fakeCtx();
      apply(ctx);

      expect(inject).toEqual(["tools"]);
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("compressor_retrieve");
      await expect(tools[0]?.execute({ locator: LONG_LOCATOR })).resolves.toBe(
        LONG_ORIGINAL,
      );
      await expect(tools[0]?.execute({ locator: LONG_HASH })).resolves.toBe(
        LONG_ORIGINAL,
      );
    });
  });

  it("rewrites a fake agent/pre-step assembled bound and keeps skip policy", async () => {
    await withHome(async () => {
      const { ctx, listeners, emitted } = fakeCtx();
      apply(ctx);

      const assembled: ConversationMessage[] = [
        { role: "user", content: LONG_ORIGINAL },
        { role: "tool", content: LONG_ORIGINAL, toolName: "Read" },
        { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
        ...PROTECTED_TAIL,
      ];
      const preStep = handler(listeners, "agent/pre-step");
      const decision = await preStep(
        { messages: assembled },
        () => Promise.resolve({ kind: "enter", messages: assembled }),
      );

      expect(decision).toMatchObject({ kind: "enter" });
      const messages = (decision as { messages: ConversationMessage[] }).messages;
      expect(messages[0]).toEqual(assembled[0]);
      expect(messages[1]).toEqual(assembled[1]);
      expect(messages[2]).toMatchObject({
        role: "tool",
        toolName: "bash",
        compressed: true,
      });
      expect(messages[2]?.content).toContain(LONG_LOCATOR);
      expect(messages[2]?.content).toContain(RETRIEVE_HINT);
      expect(messages[2]?.content.length).toBeLessThan(LONG_ORIGINAL.length);
      expect(messages.slice(3)).toEqual(PROTECTED_TAIL);
      expect(emitted).toEqual([
        {
          event: "contextCompression/after",
          payload: {
            source: "agent/pre-step",
            messages,
          },
        },
      ]);
    });
  });

  it("crushes a fake inner tools/post-execute new tool result", async () => {
    await withHome(async () => {
      const { ctx, listeners, emitted } = fakeCtx();
      apply(ctx);

      const postExecute = handler(listeners, "tools/post-execute");
      const decision = await postExecute(
        { name: "bash" },
        { content: textBlocks(LONG_ORIGINAL), isError: false },
        () => Promise.resolve({ kind: "accept" }),
      );

      expect(decision).toMatchObject({
        kind: "accept",
        content: [
          {
            type: "text",
            text: expect.stringContaining(LONG_LOCATOR),
          },
        ],
      });
      const text = (decision as { content: Array<{ text: string }> }).content[0]
        ?.text;
      expect(text).toContain(RETRIEVE_HINT);
      expect(text?.length).toBeLessThan(LONG_ORIGINAL.length);
      expect(emitted).toEqual([
        {
          event: "contextCompression/after",
          payload: expect.objectContaining({
            source: "tools/post-execute",
          }),
        },
      ]);
    });
  });

  it("does not crush an excluded or short post-execute result and does not emit", async () => {
    await withHome(async () => {
      const { ctx, listeners, emitted } = fakeCtx();
      apply(ctx);

      const postExecute = handler(listeners, "tools/post-execute");
      const excluded = await postExecute(
        { name: "Read" },
        { content: textBlocks(LONG_ORIGINAL), isError: false },
        () => Promise.resolve({ kind: "accept" }),
      );
      const short = await postExecute(
        { name: "bash" },
        { content: textBlocks("ok"), isError: false },
        () => Promise.resolve({ kind: "accept" }),
      );

      expect(excluded).toEqual({ kind: "accept" });
      expect(short).toEqual({ kind: "accept" });
      expect(emitted).toEqual([]);
    });
  });

  it("contributes a prompt section that says locators are not filesystem paths", () => {
    const { ctx, sections } = fakeCtx();

    apply(ctx);

    expect(sections).toHaveLength(1);
    const text =
      typeof sections[0]?.text === "function"
        ? sections[0].text({})
        : sections[0]?.text;
    expect(text).toMatch(/locator/i);
    expect(text).toMatch(/not filesystem paths/i);
    expect(text).not.toMatch(/\/Users\/|~\/|\.\//);
  });
});
