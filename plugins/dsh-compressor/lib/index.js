import { defineTool } from "@deepseek-ai/dsh-tools";
import { compressConversation, markRetrieveRegistered, retrieve, } from "./compress.js";
import { rewriteSessionToolResults, } from "./session-rewrite.js";
export { compressConversation, retrieve, } from "./compress.js";
export const name = "dsh-compressor";
export const inject = ["tools", "systemPrompt"];
export const CONTEXT_COMPRESSION_AFTER = "contextCompression/after";
const LOCATOR_PROMPT = "Compressor locators such as <<compressor:hash>> are retrieve handles, not filesystem paths. Do not Read them. Call compressor_retrieve with the locator or its hash.";
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
function sessionFromPayload(payload) {
    if (payload === null || typeof payload !== "object") {
        return undefined;
    }
    const agent = payload.agent;
    const session = agent?.session;
    if (session === null || typeof session !== "object") {
        return undefined;
    }
    return session;
}
function emitAfter(ctx, source, messages) {
    ctx.emit?.(CONTEXT_COMPRESSION_AFTER, { source, messages });
}
function registerRetrieve(ctx) {
    if (typeof ctx.tools?.register !== "function") {
        return false;
    }
    try {
        const disposer = ctx.tools.register(defineTool({
            name: "compressor_retrieve",
            description: "Restore original conversation text for a compressor locator or content hash. The locator is not a filesystem path.",
            parameters: {
                locator: {
                    type: "string",
                    required: true,
                    description: "Full <<compressor:hash>> locator or the bare content hash.",
                },
            },
            output: {
                schema: { type: "string" },
                render: (_args, value) => [{ type: "text", text: value }],
            },
            async execute(args) {
                return retrieve(args.locator);
            },
        }));
        // Official ToolRuntime.register returns a disposer. A no-op register is not success.
        return typeof disposer === "function";
    }
    catch {
        return false;
    }
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
        : { kind: "enter", messages: [] };
    if (decision !== null &&
        typeof decision === "object" &&
        decision.kind === "reject") {
        return decision;
    }
    const session = sessionFromPayload(payload);
    if (session === undefined) {
        return decision;
    }
    let result;
    try {
        result = rewriteSessionToolResults(session);
    }
    catch {
        return decision;
    }
    if (result.replaced > 0) {
        emitAfter(ctx, "agent/pre-step", result.rewritten);
    }
    return decision;
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
        ...(resultRecord?.isError === true ? { isError: true } : {}),
    };
    let crushed;
    try {
        [crushed] = compressConversation([incoming]);
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
    if (registerRetrieve(plugin) &&
        typeof plugin.systemPrompt?.section === "function") {
        markRetrieveRegistered();
        contributePrompt(plugin);
    }
    hangHooks(plugin);
}
//# sourceMappingURL=index.js.map