import { retrieve } from "./compress.js";

export {
  compressConversation,
  retrieve,
  type CompressOptions,
  type ConversationMessage,
  type MessageRole,
} from "./compress.js";

export const name = "dsh-compressor";
export const inject = ["tools"];

type RetrieveArgs = {
  locator: string;
};

type ToolHost = {
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
};

export function apply(ctx: object): void {
  const register = (ctx as ToolHost).tools?.register;
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
