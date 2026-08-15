export { compressConversation, retrieve, type CompressOptions, type ConversationMessage, type MessageRole, } from "./compress.js";
export declare const name = "dsh-compressor";
export declare const inject: string[];
export declare const CONTEXT_COMPRESSION_AFTER = "contextCompression/after";
export declare function apply(ctx: object): void;
