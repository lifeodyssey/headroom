import {
  compressConversation,
  retrieve,
  type ConversationMessage,
} from "./compress.js";
import {
  rewriteSessionToolResults,
  type SurfaceSession,
} from "./session-rewrite.js";

export {
  compressConversation,
  retrieve,
  type CompressOptions,
  type ConversationMessage,
  type MessageRole,
} from "./compress.js";

export const name = "dsh-compressor";
export const inject = ["tools"];
export const CONTEXT_COMPRESSION_AFTER = "contextCompression/after";

const LOCATOR_PROMPT =
  "Compressor locators such as <<compressor:hash>> are retrieve handles, not filesystem paths. Do not Read them. Call compressor_retrieve with the locator or its hash.";

const POST_EXECUTE_TAIL: ConversationMessage[] = [
  { role: "assistant", content: "tail-1" },
  { role: "assistant", content: "tail-2" },
  { role: "assistant", content: "tail-3" },
  { role: "assistant", content: "tail-4" },
];

type RetrieveArgs = {
  locator: string;
};

type PluginContext = {
  on?: (event: string, handler: (...args: unknown[]) => unknown) => unknown;
  emit?: (event: string, payload?: unknown) => unknown;
  tools?: {
    register?: (definition: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      output: {
        schema: { type: "string" };
        render: (
          args: unknown,
          value: string,
        ) => Array<{ type: "text"; text: string }>;
      };
      execute: (args: RetrieveArgs) => Promise<string>;
    }) => unknown;
  };
  systemPrompt?: {
    section?: (section: {
      name: string;
      order: number;
      text: string;
    }) => unknown;
  };
};

function flattenText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") {
      return undefined;
    }
    const item = block as { type?: unknown; text?: unknown };
    if (item.type !== "text" || typeof item.text !== "string") {
      return undefined;
    }
    parts.push(item.text);
  }
  return parts.join("");
}

function sessionFromPayload(payload: unknown): SurfaceSession | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const agent = (payload as { agent?: { session?: unknown } }).agent;
  const session = agent?.session;
  if (session === null || typeof session !== "object") {
    return undefined;
  }
  return session as SurfaceSession;
}

function emitAfter(
  ctx: PluginContext,
  source: "agent/pre-step" | "tools/post-execute",
  messages: ConversationMessage[],
): void {
  ctx.emit?.(CONTEXT_COMPRESSION_AFTER, { source, messages });
}

function registerRetrieve(ctx: PluginContext): void {
  const register = ctx.tools?.register;
  if (typeof register !== "function") {
    return;
  }

  register({
    name: "compressor_retrieve",
    description:
      "Restore original conversation text for a compressor locator or content hash. The locator is not a filesystem path.",
    parameters: {
      type: "object",
      properties: {
        locator: {
          type: "string",
          description:
            "Full <<compressor:hash>> locator or the bare content hash.",
        },
      },
      required: ["locator"],
    },
    output: {
      schema: { type: "string" },
      render: (_args: unknown, value: string) => [{ type: "text", text: value }],
    },
    async execute(args: RetrieveArgs) {
      return retrieve(args?.locator);
    },
  });
}

function contributePrompt(ctx: PluginContext): void {
  ctx.systemPrompt?.section?.({
    name: "dsh-compressor:locators",
    order: 180,
    text: LOCATOR_PROMPT,
  });
}

async function onPreStep(
  ctx: PluginContext,
  payload: unknown,
  next: unknown,
): Promise<unknown> {
  const decision =
    typeof next === "function"
      ? await (next as () => Promise<unknown>)()
      : { kind: "enter", messages: [] };
  if (
    decision !== null &&
    typeof decision === "object" &&
    (decision as { kind?: unknown }).kind === "reject"
  ) {
    return decision;
  }

  const session = sessionFromPayload(payload);
  if (session === undefined) {
    return decision;
  }

  let result: { rewritten: ConversationMessage[]; replaced: number };
  try {
    result = rewriteSessionToolResults(session);
  } catch {
    return decision;
  }

  if (result.replaced > 0) {
    emitAfter(ctx, "agent/pre-step", result.rewritten);
  }
  return decision;
}

async function onPostExecute(
  ctx: PluginContext,
  exec: unknown,
  result: unknown,
  next: unknown,
): Promise<unknown> {
  const decision = (
    typeof next === "function"
      ? await (next as () => Promise<unknown>)()
      : { kind: "accept" }
  ) as {
    kind?: unknown;
    content?: unknown;
    value?: unknown;
    additionalContexts?: unknown;
  };

  if (decision.kind !== "accept" || Object.hasOwn(decision, "value")) {
    return decision;
  }

  const resultRecord =
    result !== null && typeof result === "object"
      ? (result as {
          content?: unknown;
          isError?: unknown;
          toolName?: unknown;
        })
      : undefined;
  if (resultRecord?.isError === true) {
    return decision;
  }

  const execRecord =
    exec !== null && typeof exec === "object"
      ? (exec as { name?: unknown })
      : undefined;
  const toolName =
    typeof execRecord?.name === "string"
      ? execRecord.name
      : typeof resultRecord?.toolName === "string"
        ? resultRecord.toolName
        : undefined;
  const rawContent = decision.content ?? resultRecord?.content;
  const text = flattenText(rawContent);
  if (text === undefined) {
    return decision;
  }

  const incoming: ConversationMessage = {
    role: "tool",
    content: text,
    ...(toolName === undefined ? {} : { toolName }),
  };

  let crushed: ConversationMessage;
  try {
    [crushed] = compressConversation([incoming, ...POST_EXECUTE_TAIL]);
  } catch {
    return decision;
  }

  if (crushed === undefined || crushed.content === text) {
    return decision;
  }

  emitAfter(ctx, "tools/post-execute", [crushed]);
  return {
    kind: "accept",
    content: [{ type: "text", text: crushed.content }],
    ...(Object.hasOwn(decision, "additionalContexts")
      ? { additionalContexts: decision.additionalContexts }
      : {}),
  };
}

function hangHooks(ctx: PluginContext): void {
  if (typeof ctx.on !== "function") {
    return;
  }

  ctx.on("agent/pre-step", (payload, next) => onPreStep(ctx, payload, next));
  ctx.on("tools/post-execute", (exec, result, next) =>
    onPostExecute(ctx, exec, result, next),
  );
}

export function apply(ctx: object): void {
  const plugin = ctx as PluginContext;
  registerRetrieve(plugin);
  contributePrompt(plugin);
  hangHooks(plugin);
}
