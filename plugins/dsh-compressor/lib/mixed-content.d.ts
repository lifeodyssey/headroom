export type MixedContentType = "json_array" | "source_code" | "search" | "text";
export type ContentSection = {
    content: string;
    contentType: MixedContentType;
    language: string | null;
    startLine: number;
    endLine: number;
    isCodeFence: boolean;
};
export type JsonScanCache = Map<string, [
    number,
    number,
    boolean,
    boolean
]>;
export declare function isMixedContent(content: string): boolean;
export declare function mixedContentIndicators(content: string): Record<string, boolean>;
export declare function splitIntoSections(content: string): ContentSection[];
export declare function extractJsonBlock(lines: readonly string[], start: number, cache?: JsonScanCache | null): [string | null, number];
