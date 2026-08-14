import {
  compressConversation,
  type ConversationMessage,
  type MessageRole,
} from "./compress.js";

export type SurfaceSession = {
  events: Array<{ type?: unknown; seq?: unknown; data?: unknown } | undefined>;
  surface?: { nodes?: readonly number[] };
  append?: (
    type: string,
    data: unknown,
    opts?: {
      surfaceOp?: { op: "replace"; start: number; end: number };
      sourceEventSeqs?: number[];
    },
  ) => unknown;
};

type ToolResultBlock = {
  type?: unknown;
  toolCallId?: unknown;
  content?: unknown;
  isError?: unknown;
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
    const item = block as { type?: unknown; text?: unknown; content?: unknown };
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (item.type === "tool-result") {
      const inner = flattenText(item.content);
      if (inner === undefined) {
        return undefined;
      }
      parts.push(inner);
      continue;
    }
    return undefined;
  }
  return parts.join("");
}

function callNames(session: SurfaceSession): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of session.events) {
    if (event?.type !== "tool/call" || event.data === null || typeof event.data !== "object") {
      continue;
    }
    const data = event.data as { callId?: unknown; name?: unknown };
    if (typeof data.callId === "string" && typeof data.name === "string") {
      names.set(data.callId, data.name);
    }
  }
  return names;
}

function toolNameForResult(
  event: { data?: unknown },
  names: Map<string, string>,
): string | undefined {
  const data = event.data as
    | { message?: { content?: ToolResultBlock[]; source?: { callId?: unknown } } }
    | undefined;
  const callId =
    data?.message?.content?.[0]?.toolCallId ?? data?.message?.source?.callId;
  return typeof callId === "string" ? names.get(callId) : undefined;
}

function eventToConversation(
  event: { type?: unknown; data?: unknown },
  names: Map<string, string>,
): ConversationMessage | undefined {
  if (event.type === "user/message") {
    const message = event.data as {
      content?: unknown;
      source?: { kind?: unknown };
    };
    const text = flattenText(message?.content);
    if (text === undefined) {
      return undefined;
    }
    if (message.source?.kind === "tool") {
      const toolName = toolNameForResult(event, names);
      return {
        role: "tool",
        content: text,
        ...(toolName === undefined ? {} : { toolName }),
      };
    }
    return { role: "user", content: text };
  }

  if (event.type === "assistant/message") {
    const wrapped = event.data as { message?: { content?: unknown } };
    const text = flattenText(wrapped?.message?.content);
    if (text === undefined) {
      return undefined;
    }
    return { role: "assistant", content: text };
  }

  if (event.type === "tool/result") {
    const data = event.data as { message?: { content?: ToolResultBlock[] } };
    const block = data?.message?.content?.[0];
    const text = flattenText(block?.content ?? data?.message?.content);
    if (text === undefined) {
      return undefined;
    }
    const toolName = toolNameForResult(event, names);
    return {
      role: "tool" as MessageRole,
      content: text,
      ...(toolName === undefined ? {} : { toolName }),
    };
  }

  return undefined;
}

function replaceToolResult(
  session: SurfaceSession,
  seq: number,
  event: { data?: unknown },
  crushed: string,
): void {
  const data = event.data as {
    message?: { content?: ToolResultBlock[] };
  };
  const original = data.message;
  const block = original?.content?.[0];
  if (original === undefined || block === undefined || typeof session.append !== "function") {
    return;
  }
  session.append(
    "tool/result",
    {
      ...(event.data as object),
      message: {
        ...original,
        content: [
          {
            ...block,
            content: [{ type: "text", text: crushed }],
          },
        ],
      },
    },
    {
      surfaceOp: { op: "replace", start: seq, end: seq },
      sourceEventSeqs: [seq],
    },
  );
}

export function rewriteSessionToolResults(session: SurfaceSession): {
  rewritten: ConversationMessage[];
  replaced: number;
} {
  const names = callNames(session);
  const nodes = session.surface?.nodes ?? [];
  const bound: ConversationMessage[] = [];
  const origins: Array<{ seq: number; event: { type?: unknown; data?: unknown } }> =
    [];

  for (const seq of nodes) {
    const event = session.events[seq];
    if (event === undefined) {
      continue;
    }
    const message = eventToConversation(event, names);
    if (message === undefined) {
      continue;
    }
    bound.push(message);
    origins.push({ seq, event });
  }

  const rewritten = compressConversation(bound);
  let replaced = 0;
  for (const [index, after] of rewritten.entries()) {
    const before = bound[index];
    const origin = origins[index];
    if (
      before === undefined ||
      origin === undefined ||
      after.content === before.content ||
      origin.event.type !== "tool/result"
    ) {
      continue;
    }
    replaceToolResult(session, origin.seq, origin.event, after.content);
    replaced += 1;
  }

  return { rewritten, replaced };
}
