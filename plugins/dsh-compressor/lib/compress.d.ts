export type MessageRole = "user" | "assistant" | "system" | "tool";
export type ConversationMessage = {
    role: MessageRole;
    content: string;
    toolName?: string;
    compressed?: boolean;
};
export type CompressOptions = {
    storeDir?: string;
};
export declare function retrieve(locatorOrHash: string, options?: CompressOptions): string;
export declare function compressConversation(messages: readonly ConversationMessage[], options?: CompressOptions): ConversationMessage[];
