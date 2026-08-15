export type MessageRole = "user" | "assistant" | "system" | "tool";
export type ConversationMessage = {
    role: MessageRole;
    content: string;
    toolName?: string;
    compressed?: boolean;
    isError?: boolean;
};
export type CompressOptions = {
    storeDir?: string;
};
export declare function markRetrieveRegistered(): void;
export declare function resetRetrieveRegistered(): void;
export declare function retrieve(locatorOrHash: string | undefined, options?: CompressOptions): string;
export declare function compressConversation(messages: readonly ConversationMessage[], options?: CompressOptions): ConversationMessage[];
