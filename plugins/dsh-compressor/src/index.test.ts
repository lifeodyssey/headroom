import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it } from "vitest";

import { resetRetrieveRegistered } from "./compress.js";
import { bootOfficialTools } from "./test-helpers.js";
import {
  apply,
  compressConversation,
  inject,
  type ConversationMessage,
} from "./index.js";

const homes: string[] = [];

afterEach(() => {
  resetRetrieveRegistered();
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

function fakeCtx(options?: {
  includeTools?: boolean;
  register?: (tool: RetrieveTool) => unknown;
}) {
  const listeners = new Map<string, Listener[]>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const provided: string[] = [];
  const sections: PromptSection[] = [];
  const tools: RetrieveTool[] = [];

  const ctx: {
    on(event: string, handler: Listener): void;
    emit(event: string, payload: unknown): void;
    provide(key: string, _value: unknown): void;
    tools?: { register(tool: RetrieveTool): unknown };
    systemPrompt: { section(section: PromptSection): void };
  } = {
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
    systemPrompt: {
      section(section: PromptSection) {
        sections.push(section);
      },
    },
  };

  if (options?.includeTools !== false) {
    ctx.tools = {
      register(tool: RetrieveTool) {
        if (options?.register !== undefined) {
          return options.register(tool);
        }
        tools.push(tool);
        return () => {};
      },
    };
  }

  return { ctx, listeners, emitted, provided, sections, tools };
}

async function executeRetrieve(
  tools: ToolRuntime,
  locator: string,
  callId: string,
) {
  return tools.execute({
    callId,
    name: "compressor_retrieve",
    arguments: { locator },
    signal: new AbortController().signal,
  });
}

function crushableToolTurn(): ConversationMessage[] {
  return [
    { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
    ...PROTECTED_TAIL,
  ];
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

type SessionEvent = {
  type: string;
  seq: number;
  data: unknown;
};

type AppendedEvent = {
  type: string;
  data: unknown;
  opts?: { surfaceOp?: unknown; sourceEventSeqs?: number[] };
};

function dshUserMessage(
  id: string,
  content: Array<{ type: string; text?: string }>,
) {
  return {
    id,
    role: "user" as const,
    content,
    source: { kind: "user" as const },
  };
}

function toolResultMessage(callId: string, text: string) {
  return {
    id: `msg-${callId}`,
    role: "user" as const,
    content: [
      {
        type: "tool-result",
        toolCallId: callId,
        content: textBlocks(text),
      },
    ],
    source: { kind: "tool" as const, callId },
  };
}

function userEvent(seq: number, text: string): SessionEvent {
  return {
    type: "user/message",
    seq,
    data: dshUserMessage(`user-${seq}`, textBlocks(text)),
  };
}

function assistantEvent(seq: number, text: string): SessionEvent {
  return {
    type: "assistant/message",
    seq,
    data: {
      message: {
        id: `asst-${seq}`,
        role: "assistant",
        content: textBlocks(text),
        source: { kind: "model", provider: "test", model: "test" },
      },
    },
  };
}

function toolCallEvent(seq: number, callId: string, name: string): SessionEvent {
  return {
    type: "tool/call",
    seq,
    data: { turn: 1, step: 1, callId, name, arguments: "{}" },
  };
}

function toolResultEvent(
  seq: number,
  callId: string,
  text: string,
): SessionEvent {
  return {
    type: "tool/result",
    seq,
    data: {
      turn: 1,
      step: 1,
      message: toolResultMessage(callId, text),
    },
  };
}

function fakeSession(log: SessionEvent[]) {
  const events: SessionEvent[] = [];
  for (const event of log) {
    events[event.seq] = event;
  }
  const appended: AppendedEvent[] = [];
  return {
    events,
    surface: {
      nodes: log
        .filter((event) =>
          ["user/message", "assistant/message", "tool/result"].includes(
            event.type,
          ),
        )
        .map((event) => event.seq),
    },
    appended,
    append(type: string, data: unknown, opts?: AppendedEvent["opts"]) {
      appended.push({ type, data, opts });
      return { seq: 1000 + appended.length };
    },
  };
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
      const { ctx, tools } = fakeCtx();
      apply(ctx);

      expect(inject).toEqual(["tools", "systemPrompt"]);
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("compressor_retrieve");

      compressConversation(crushableToolTurn());

      await expect(tools[0]?.execute({ locator: LONG_LOCATOR })).resolves.toBe(
        LONG_ORIGINAL,
      );
      await expect(tools[0]?.execute({ locator: LONG_HASH })).resolves.toBe(
        LONG_ORIGINAL,
      );
    });
  });

  it("replaces a long bash tool/result on the session surface and leaves enter.messages as DSH user rows", async () => {
    await withHome(async () => {
      const { ctx, listeners, emitted } = fakeCtx();
      apply(ctx);

      const session = fakeSession([
        userEvent(10, "do the work"),
        toolCallEvent(11, "call-read", "Read"),
        toolResultEvent(12, "call-read", LONG_ORIGINAL),
        toolCallEvent(13, "call-bash", "bash"),
        toolResultEvent(14, "call-bash", LONG_ORIGINAL),
        ...[15, 16, 17, 18].map((seq) => assistantEvent(seq, `tail-${seq}`)),
      ]);
      const enterMessages = [
        dshUserMessage("do the work", [{ type: "text", text: "do the work" }]),
      ];
      const preStep = handler(listeners, "agent/pre-step");
      const decision = await preStep(
        { agent: { session }, messages: enterMessages },
        () => Promise.resolve({ kind: "enter", messages: enterMessages }),
      );

      expect(decision).toEqual({ kind: "enter", messages: enterMessages });
      expect(enterMessages[0]?.content).toEqual([
        { type: "text", text: "do the work" },
      ]);

      const replacements = session.appended.filter(
        (entry) =>
          entry.type === "tool/result" &&
          (entry.opts?.surfaceOp as { op?: string } | undefined)?.op ===
            "replace",
      );
      expect(replacements).toHaveLength(1);
      expect(replacements[0]?.opts).toEqual({
        surfaceOp: { op: "replace", start: 14, end: 14 },
        sourceEventSeqs: [14],
      });
      const crushedBlock = (
        replacements[0]?.data as {
          message: { content: Array<{ content: Array<{ text: string }> }> };
        }
      ).message.content[0]?.content[0];
      expect(crushedBlock?.text).toContain(LONG_LOCATOR);
      expect(crushedBlock?.text).toContain(RETRIEVE_HINT);
      expect(crushedBlock?.text.length).toBeLessThan(LONG_ORIGINAL.length);
      expect(emitted).toEqual([
        {
          event: "contextCompression/after",
          payload: expect.objectContaining({
            source: "agent/pre-step",
          }),
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

  it("does not skip post-execute isError when the text exceeds the 8000 character cap", async () => {
    await withHome(async () => {
      const { ctx, listeners, emitted } = fakeCtx();
      apply(ctx);

      const overCap =
        "Traceback (most recent call last):\nValueError: boom\n" +
        "INFO padding line for size gate\n".repeat(250);
      expect(overCap.length).toBeGreaterThan(8000);

      const postExecute = handler(listeners, "tools/post-execute");
      const decision = await postExecute(
        { name: "bash" },
        { content: textBlocks(overCap), isError: true },
        () => Promise.resolve({ kind: "accept" }),
      );

      expect((decision as { kind?: string }).kind).toBe("accept");
      const text = (decision as { content: Array<{ text: string }> }).content[0]
        ?.text;
      expect(text).toMatch(/<<compressor:[0-9a-f]{64}>>/);
      expect(text?.length).toBeLessThan(overCap.length);
      expect(emitted).toHaveLength(1);
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

describe("official ToolRuntime retrieve", () => {
  it("registers compressor_retrieve on a real ToolRuntime catalog", async () => {
    await withHome(async () => {
      const { tools } = bootOfficialTools();

      expect(tools).toBeInstanceOf(ToolRuntime);
      expect(tools.schemas).toBe(ToolRuntime.prototype.schemas);
      expect(tools.execute).toBe(ToolRuntime.prototype.execute);
      expect(tools.schemas().map((schema) => schema.name)).toContain(
        "compressor_retrieve",
      );
      const schema = tools.schemas().find(
        (entry) => entry.name === "compressor_retrieve",
      );
      expect(schema?.parameters).toMatchObject({
        type: "object",
        required: ["locator"],
        properties: {
          locator: { type: "string" },
        },
      });
    });
  });

  it("executes a locator or bare hash and returns the original disk bytes", async () => {
    await withHome(async () => {
      const { tools } = bootOfficialTools();
      compressConversation(crushableToolTurn());

      const byLocator = await executeRetrieve(tools, LONG_LOCATOR, "by-locator");
      const byHash = await executeRetrieve(tools, LONG_HASH, "by-hash");

      expect(byLocator).toMatchObject({
        isError: false,
        value: LONG_ORIGINAL,
      });
      expect(byHash).toMatchObject({
        isError: false,
        value: LONG_ORIGINAL,
      });
    });
  });

  it("looks up an uppercase hex hash against the lowercase store key", async () => {
    await withHome(async () => {
      const { tools } = bootOfficialTools();
      compressConversation(crushableToolTurn());

      const byBare = await executeRetrieve(
        tools,
        LONG_HASH.toUpperCase(),
        "upper-hash",
      );
      const byLocator = await executeRetrieve(
        tools,
        `<<compressor:${LONG_HASH.toUpperCase()}>>`,
        "upper-locator",
      );

      expect(byBare).toMatchObject({ isError: false, value: LONG_ORIGINAL });
      expect(byLocator).toMatchObject({ isError: false, value: LONG_ORIGINAL });
    });
  });

  it("fails clearly on a missing or unknown hash and invents no content", async () => {
    await withHome(async () => {
      const { tools } = bootOfficialTools();
      const missing =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

      const unknown = await executeRetrieve(tools, missing, "missing");
      const invalid = await executeRetrieve(
        tools,
        "not-a-locator-or-hash",
        "invalid",
      );

      expect(unknown.isError).toBe(true);
      expect(invalid.isError).toBe(true);
      if (unknown.isError) {
        expect(unknown.error.message).toBe(
          `compressor_retrieve: unknown hash ${missing}`,
        );
      }
      if (invalid.isError) {
        expect(invalid.error.message).toMatch(
          /compressor_retrieve: missing or unknown hash/,
        );
      }
      expect(JSON.stringify(unknown)).not.toContain(LONG_ORIGINAL);
      expect(JSON.stringify(invalid)).not.toContain(LONG_ORIGINAL);
    });
  });

  it("does not crush compressor_retrieve output into a new locator", async () => {
    await withHome(async () => {
      const { tools } = bootOfficialTools();
      compressConversation(crushableToolTurn());

      const result = await executeRetrieve(tools, LONG_LOCATOR, "no-recrush");
      expect(result.isError).toBe(false);
      if (result.isError) {
        return;
      }

      const [again] = compressConversation([
        {
          role: "tool",
          toolName: "compressor_retrieve",
          content: result.value,
        },
      ]);
      expect(again?.content).toBe(LONG_ORIGINAL);
      expect(again?.content).not.toMatch(/<<compressor:/);
    });
  });

  it("assembles the locator prompt section with the tool", async () => {
    await withHome(async () => {
      const { ctx, tools } = bootOfficialTools();
      const assembly = await ctx.systemPrompt.assemble();

      expect(tools.schemas().map((schema) => schema.name)).toContain(
        "compressor_retrieve",
      );
      expect(assembly.tools.map((schema) => schema.name)).toContain(
        "compressor_retrieve",
      );
      const locatorSection = assembly.sections.find(
        (section) => section.name === "dsh-compressor:locators",
      );
      expect(locatorSection?.text).toMatch(/locator/i);
      expect(locatorSection?.text).toMatch(/not filesystem paths/i);
    });
  });
});

describe("fail-closed crush", () => {
  it("does not crush when apply was never called", async () => {
    await withHome(async (home) => {
      const messages = crushableToolTurn();
      const compressed = compressConversation(messages);

      expect(compressed).toEqual(messages);
      expect(compressed[0]?.content).toBe(LONG_ORIGINAL);
      expect(compressed[0]?.content).not.toMatch(/<<compressor:/);
      const store = join(home, "dsh-compressor");
      expect(existsSync(store) ? readdirSync(store) : []).toEqual([]);
    });
  });

  it("does not crush when apply has no tools.register", async () => {
    await withHome(async () => {
      const { ctx, listeners, emitted, sections } = fakeCtx({
        includeTools: false,
      });
      apply(ctx);
      expect(sections).toEqual([]);

      const messages = crushableToolTurn();
      expect(compressConversation(messages)).toEqual(messages);

      const session = fakeSession([
        userEvent(10, "do the work"),
        toolCallEvent(11, "call-bash", "bash"),
        toolResultEvent(12, "call-bash", LONG_ORIGINAL),
        ...[13, 14, 15, 16].map((seq) => assistantEvent(seq, `tail-${seq}`)),
      ]);
      const preStep = handler(listeners, "agent/pre-step");
      const enter = await preStep(
        { agent: { session } },
        () => Promise.resolve({ kind: "enter", messages: [] }),
      );
      expect(enter).toEqual({ kind: "enter", messages: [] });
      expect(session.appended).toEqual([]);

      const postExecute = handler(listeners, "tools/post-execute");
      const decision = await postExecute(
        { name: "bash" },
        { content: textBlocks(LONG_ORIGINAL), isError: false },
        () => Promise.resolve({ kind: "accept" }),
      );
      expect(decision).toEqual({ kind: "accept" });
      expect(emitted).toEqual([]);
    });
  });

  it("does not crush when tools.register returns no disposer", async () => {
    await withHome(async () => {
      const { ctx, emitted, sections } = fakeCtx({
        register() {},
      });
      apply(ctx);

      const messages = crushableToolTurn();
      expect(compressConversation(messages)).toEqual(messages);
      expect(messages[0]?.content).not.toMatch(/<<compressor:/);
      expect(sections).toEqual([]);
      expect(emitted).toEqual([]);
    });
  });

  it("does not crush when tools.register succeeds but systemPrompt.section is missing", async () => {
    await withHome(async () => {
      apply({
        tools: {
          register() {
            return () => {};
          },
        },
      });
      const messages = crushableToolTurn();
      expect(compressConversation(messages)).toEqual(messages);
      expect(messages[0]?.content).not.toMatch(/<<compressor:/);
    });
  });

  it("does not crush when tools.register throws", async () => {
    await withHome(async () => {
      const { ctx, listeners, emitted } = fakeCtx({
        register() {
          throw new Error("register failed");
        },
      });
      expect(() => apply(ctx)).not.toThrow();

      const messages = crushableToolTurn();
      expect(compressConversation(messages)).toEqual(messages);

      const postExecute = handler(listeners, "tools/post-execute");
      const decision = await postExecute(
        { name: "bash" },
        { content: textBlocks(LONG_ORIGINAL), isError: false },
        () => Promise.resolve({ kind: "accept" }),
      );
      expect(decision).toEqual({ kind: "accept" });
      expect(emitted).toEqual([]);
    });
  });

  it("crushes after a successful register the same way as today", async () => {
    await withHome(async () => {
      const { ctx } = fakeCtx();
      apply(ctx);

      const compressed = compressConversation(crushableToolTurn());
      expect(compressed[0]?.content).toContain(LONG_LOCATOR);
      expect(compressed[0]?.content).toContain(RETRIEVE_HINT);
      expect(compressed[0]?.content.length).toBeLessThan(LONG_ORIGINAL.length);
    });
  });
});
