import { compressConversation, retrieve, } from "./compress.js";
export { compressConversation, retrieve, } from "./compress.js";
export const name = "dsh-compressor";
export const inject = ["tools"];
export const CONTEXT_COMPRESSION_AFTER = "contextCompression/after";
const LOCATOR_PROMPT = "Compressor locators such as <<compressor:hash>> are retrieve handles, not filesystem paths. Do not Read them. Call compressor_retrieve with the locator or its hash.";
const POST_EXECUTE_TAIL = [
    { role: "assistant", content: "tail-1" },
    { role: "assistant", content: "tail-2" },
    { role: "assistant", content: "tail-3" },
    { role: "assistant", content: "tail-4" },
];
const ROLES = new Set(["user", "assistant", "system", "tool"]);
function isConversationMessage(value) {
    if (value === null || typeof value !== "object") {
        return false;
    }
    const message = value;
    return (typeof message.role === "string" &&
        ROLES.has(message.role) &&
        typeof message.content === "string");
}
function asConversationMessages(value) {
    if (!Array.isArray(value) || !value.every(isConversationMessage)) {
        return undefined;
    }
    return value;
}
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
        if (item.type !== "text" || typeof item.text !== "string") {
            return undefined;
        }
        parts.push(item.text);
    }
    return parts.join("");
}
function pickAssembledBound(payload, decision) {
    const record = payload !== null && typeof payload === "object"
        ? payload
        : undefined;
    const decided = decision !== null && typeof decision === "object"
        ? decision
        : undefined;
    return (asConversationMessages(decided?.messages) ??
        asConversationMessages(record?.assembled) ??
        asConversationMessages(record?.messages));
}
function messagesChanged(before, after) {
    return after.some((message, index) => message.content !== before[index]?.content);
}
function emitAfter(ctx, source, messages) {
    ctx.emit?.(CONTEXT_COMPRESSION_AFTER, { source, messages });
}
function registerRetrieve(ctx) {
    const register = ctx.tools?.register;
    if (typeof register !== "function") {
        return;
    }
    register({
        name: "compressor_retrieve",
        description: "Restore original conversation text for a compressor locator or content hash. The locator is not a filesystem path.",
        parameters: {
            type: "object",
            properties: {
                locator: {
                    type: "string",
                    description: "Full <<compressor:hash>> locator or the bare content hash.",
                },
            },
            required: ["locator"],
        },
        output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
        },
        async execute(args) {
            return retrieve(args?.locator);
        },
    });
}
function contributePrompt(ctx) {
    ctx.systemPrompt?.section?.({
        name: "dsh-compressor:locators",
        order: 180,
        text: LOCATOR_PROMPT,
    });
}
async function onPreStep(ctx, payload, next) {
    const decision = typeof next === "function"
        ? await next()
        : {
            kind: "enter",
            messages: pickAssembledBound(payload, undefined) ?? [],
        };
    if (decision !== null &&
        typeof decision === "object" &&
        decision.kind === "reject") {
        return decision;
    }
    const bound = pickAssembledBound(payload, decision);
    if (bound === undefined) {
        return decision;
    }
    let rewritten;
    try {
        rewritten = compressConversation(bound);
    }
    catch {
        return decision;
    }
    if (messagesChanged(bound, rewritten)) {
        emitAfter(ctx, "agent/pre-step", rewritten);
    }
    if (decision !== null && typeof decision === "object") {
        return { ...decision, kind: "enter", messages: rewritten };
    }
    return { kind: "enter", messages: rewritten };
}
async function onPostExecute(ctx, exec, result, next) {
    const decision = (typeof next === "function"
        ? await next()
        : { kind: "accept" });
    if (decision.kind !== "accept" || Object.hasOwn(decision, "value")) {
        return decision;
    }
    const resultRecord = result !== null && typeof result === "object"
        ? result
        : undefined;
    if (resultRecord?.isError === true) {
        return decision;
    }
    const execRecord = exec !== null && typeof exec === "object"
        ? exec
        : undefined;
    const toolName = typeof execRecord?.name === "string"
        ? execRecord.name
        : typeof resultRecord?.toolName === "string"
            ? resultRecord.toolName
            : undefined;
    const rawContent = decision.content ?? resultRecord?.content;
    const text = flattenText(rawContent);
    if (text === undefined) {
        return decision;
    }
    const incoming = {
        role: "tool",
        content: text,
        ...(toolName === undefined ? {} : { toolName }),
    };
    let crushed;
    try {
        [crushed] = compressConversation([incoming, ...POST_EXECUTE_TAIL]);
    }
    catch {
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
function hangHooks(ctx) {
    if (typeof ctx.on !== "function") {
        return;
    }
    ctx.on("agent/pre-step", (payload, next) => onPreStep(ctx, payload, next));
    ctx.on("tools/post-execute", (exec, result, next) => onPostExecute(ctx, exec, result, next));
}
export function apply(ctx) {
    const plugin = ctx;
    registerRetrieve(plugin);
    contributePrompt(plugin);
    hangHooks(plugin);
}
//# sourceMappingURL=index.js.map