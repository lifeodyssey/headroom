export type MessageRole = "user" | "assistant" | "system" | "tool";
export type ConversationMessage = {
    role: MessageRole;
    content: string;
    toolName?: string;
    compressed?: boolean;
};
export declare function compressConversation(messages: readonly ConversationMessage[]): ConversationMessage[];
