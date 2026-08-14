import { type ConversationMessage } from "./compress.js";
export type SurfaceSession = {
    events: Array<{
        type?: unknown;
        seq?: unknown;
        data?: unknown;
    } | undefined>;
    surface?: {
        nodes?: readonly number[];
    };
    append?: (type: string, data: unknown, opts?: {
        surfaceOp?: {
            op: "replace";
            start: number;
            end: number;
        };
        sourceEventSeqs?: number[];
    }) => unknown;
};
export declare function rewriteSessionToolResults(session: SurfaceSession): {
    rewritten: ConversationMessage[];
    replaced: number;
};
