import { compressConversation, } from "./compress.js";
function flattenText(content) {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return undefined;
    }
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== "object") {
            return undefined;
        }
        const item = block;
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
function firstToolResultIsError(content) {
    if (!Array.isArray(content)) {
        return false;
    }
    const block = content[0];
    return block?.type === "tool-result" && block.isError === true;
}
function callNames(session) {
    const names = new Map();
    for (const event of session.events) {
        if (event?.type !== "tool/call" || event.data === null || typeof event.data !== "object") {
            continue;
        }
        const data = event.data;
        if (typeof data.callId === "string" && typeof data.name === "string") {
            names.set(data.callId, data.name);
        }
    }
    return names;
}
function toolNameForResult(event, names) {
    const data = event.data;
    const callId = data?.message?.content?.[0]?.toolCallId ?? data?.message?.source?.callId;
    return typeof callId === "string" ? names.get(callId) : undefined;
}
function eventToConversation(event, names) {
    if (event.type === "user/message") {
        const message = event.data;
        const text = flattenText(message?.content);
        if (text === undefined) {
            return undefined;
        }
        if (message.source?.kind === "tool") {
            const toolName = toolNameForResult(event, names);
            const isError = firstToolResultIsError(message.content);
            return {
                role: "tool",
                content: text,
                ...(toolName === undefined ? {} : { toolName }),
                ...(isError ? { isError: true } : {}),
            };
        }
        return { role: "user", content: text };
    }
    if (event.type === "assistant/message") {
        const wrapped = event.data;
        const text = flattenText(wrapped?.message?.content);
        if (text === undefined) {
            return undefined;
        }
        return { role: "assistant", content: text };
    }
    if (event.type === "tool/result") {
        const data = event.data;
        const block = data?.message?.content?.[0];
        const text = flattenText(block?.content ?? data?.message?.content);
        if (text === undefined) {
            return undefined;
        }
        const toolName = toolNameForResult(event, names);
        const isError = block?.isError === true;
        return {
            role: "tool",
            content: text,
            ...(toolName === undefined ? {} : { toolName }),
            ...(isError ? { isError: true } : {}),
        };
    }
    return undefined;
}
function replaceToolResult(session, seq, event, crushed) {
    const data = event.data;
    const original = data.message;
    const block = original?.content?.[0];
    if (original === undefined || block === undefined || typeof session.append !== "function") {
        return;
    }
    session.append("tool/result", {
        ...event.data,
        message: {
            ...original,
            content: [
                {
                    ...block,
                    content: [{ type: "text", text: crushed }],
                },
            ],
        },
    }, {
        surfaceOp: { op: "replace", start: seq, end: seq },
        sourceEventSeqs: [seq],
    });
}
export function rewriteSessionToolResults(session) {
    const names = callNames(session);
    const nodes = session.surface?.nodes ?? [];
    const bound = [];
    const origins = [];
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
        if (before === undefined ||
            origin === undefined ||
            after.content === before.content ||
            origin.event.type !== "tool/result") {
            continue;
        }
        replaceToolResult(session, origin.seq, origin.event, after.content);
        replaced += 1;
    }
    return { rewritten, replaced };
}
//# sourceMappingURL=session-rewrite.js.map