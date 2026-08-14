export {
  compressConversation,
  type ConversationMessage,
  type MessageRole,
} from "./compress.js";

export const name = "dsh-compressor";

export function apply(_ctx: object): void {
  // Identity bundle: mount only. Later tickets hang compress-conversation here.
}
