export type CrushOut = {
    compressed: string;
    wasModified: boolean;
    strategy: string;
    originalTokens?: number | null;
    compressedTokens?: number | null;
    compressionRatio?: number | null;
    keptSegments?: number | null;
    totalSegments?: number | null;
};
export type DetectOut = {
    contentType: string;
    confidence: number;
    metadataJson: string;
};
export declare function nativeFileName(platform?: string, arch?: string): string;
export declare function nativeAvailable(): boolean;
export declare function crushLog(content: string, config?: Record<string, unknown>, bias?: number): CrushOut;
export declare function crushSmart(content: string, query?: string, bias?: number, config?: Record<string, unknown>, withoutCompaction?: boolean): CrushOut;
export declare function crushText(content: string, context?: string, targetRatio?: number): CrushOut;
export declare function crushSearch(content: string, context?: string, bias?: number, config?: Record<string, unknown>): CrushOut;
export declare function crushDiff(content: string, context?: string, config?: Record<string, unknown>): CrushOut;
export declare function detectContentType(content: string): DetectOut;
export declare function crushByDetectedType(content: string, query?: string): CrushOut;
