export type MessageRole = "user" | "assistant" | "system" | "tool";

export type ConversationMessage = {
  role: MessageRole;
  content: string;
  toolName?: string;
  compressed?: boolean;
};

export function compressConversation(
  messages: readonly ConversationMessage[],
): ConversationMessage[] {
  return messages.map((message) => ({ ...message }));
}
