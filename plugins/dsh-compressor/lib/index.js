import { retrieve } from "./compress.js";
export { compressConversation, retrieve, } from "./compress.js";
export const name = "dsh-compressor";
export const inject = ["tools"];
export function apply(ctx) {
    const register = ctx.tools?.register;
    if (typeof register !== "function") {
        return;
    }
    register({
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
    });
}
//# sourceMappingURL=index.js.map