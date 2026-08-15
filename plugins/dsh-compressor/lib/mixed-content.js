const CODE_FENCE_PATTERN = /^```(\w*)\s*$/m;
const JSON_BLOCK_START = /^\s*[\[{]/m;
const SEARCH_RESULT_PATTERN = /^\S+:\d+:/m;
const PROSE_PATTERN = /[A-Z][a-z]+\s+\w+\s+\w+/g;
export function isMixedContent(content) {
    return (Object.values(mixedContentIndicators(content)).reduce((sum, hit) => sum + Number(hit), 0) >= 2);
}
export function mixedContentIndicators(content) {
    return {
        has_code_fences: CODE_FENCE_PATTERN.test(content),
        has_json_blocks: JSON_BLOCK_START.test(content),
        has_embedded_json_with_text: hasValidJsonBlockWithText(content),
        has_prose: (content.match(PROSE_PATTERN) ?? []).length > 5,
        has_search_results: SEARCH_RESULT_PATTERN.test(content),
    };
}
function anyNonblank(lines, start, stop) {
    for (let i = start; i < stop; i++) {
        if (lines[i]?.trim()) {
            return true;
        }
    }
    return false;
}
function hasValidJsonBlockWithText(content) {
    const lines = content.split("\n");
    let scanCache = null;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const stripped = line?.trim() ?? "";
        if (!stripped.startsWith("[") && !stripped.startsWith("{")) {
            continue;
        }
        const [jsonContent, endIndex] = extractJsonBlock(lines, index, scanCache);
        if (jsonContent === null) {
            if (scanCache === null) {
                scanCache = new Map();
            }
            continue;
        }
        try {
            JSON.parse(jsonContent);
        }
        catch {
            continue;
        }
        if (anyNonblank(lines, 0, index) ||
            anyNonblank(lines, endIndex + 1, lines.length)) {
            return true;
        }
    }
    return false;
}
export function splitIntoSections(content) {
    const sections = [];
    const lines = content.split("\n");
    let scanCache = null;
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? "";
        const fenceMatch = line.match(CODE_FENCE_PATTERN);
        if (fenceMatch) {
            const language = fenceMatch[1] || "unknown";
            const codeLines = [];
            const startLine = i;
            i += 1;
            while (i < lines.length && !lines[i].startsWith("```")) {
                codeLines.push(lines[i]);
                i += 1;
            }
            sections.push({
                content: codeLines.join("\n"),
                contentType: "source_code",
                language,
                startLine,
                endLine: i,
                isCodeFence: true,
            });
            i += 1;
            continue;
        }
        const stripped = line.trim();
        if (stripped.startsWith("[") || stripped.startsWith("{")) {
            const [jsonContent, endI] = extractJsonBlock(lines, i, scanCache);
            if (jsonContent === null && scanCache === null) {
                scanCache = new Map();
            }
            if (jsonContent) {
                sections.push({
                    content: jsonContent,
                    contentType: "json_array",
                    language: null,
                    startLine: i,
                    endLine: endI,
                    isCodeFence: false,
                });
                i = endI + 1;
                continue;
            }
        }
        if (SEARCH_RESULT_PATTERN.test(line)) {
            const searchLines = [];
            const startLine = i;
            while (i < lines.length && SEARCH_RESULT_PATTERN.test(lines[i] ?? "")) {
                searchLines.push(lines[i]);
                i += 1;
            }
            sections.push({
                content: searchLines.join("\n"),
                contentType: "search",
                language: null,
                startLine,
                endLine: i - 1,
                isCodeFence: false,
            });
            continue;
        }
        const textLines = [line];
        const startLine = i;
        i += 1;
        while (i < lines.length) {
            const nextLine = lines[i] ?? "";
            if (CODE_FENCE_PATTERN.test(nextLine) ||
                nextLine.trim().startsWith("[") ||
                nextLine.trim().startsWith("{") ||
                SEARCH_RESULT_PATTERN.test(nextLine)) {
                break;
            }
            textLines.push(nextLine);
            i += 1;
        }
        const textContent = textLines.join("\n");
        if (textContent.trim()) {
            sections.push({
                content: textContent,
                contentType: "text",
                language: null,
                startLine,
                endLine: i - 1,
                isCodeFence: false,
            });
        }
    }
    return sections;
}
function scanLine(line, inString, escaped) {
    let bracket = 0;
    let brace = 0;
    for (const ch of line) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            if (inString) {
                escaped = true;
            }
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (ch === "[") {
            bracket += 1;
        }
        else if (ch === "]") {
            bracket -= 1;
        }
        else if (ch === "{") {
            brace += 1;
        }
        else if (ch === "}") {
            brace -= 1;
        }
    }
    return [bracket, brace, inString, escaped];
}
function cacheKey(index, inString, escaped) {
    return `${index}:${inString ? 1 : 0}:${escaped ? 1 : 0}`;
}
export function extractJsonBlock(lines, start, cache) {
    let bracketCount = 0;
    let braceCount = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < lines.length; i++) {
        const key = cacheKey(i, inString, escaped);
        let step = cache?.get(key);
        if (step === undefined) {
            step = scanLine(lines[i] ?? "", inString, escaped);
            cache?.set(key, step);
        }
        const [dBracket, dBrace, nextInString, nextEscaped] = step;
        inString = nextInString;
        escaped = nextEscaped;
        bracketCount += dBracket;
        braceCount += dBrace;
        if (bracketCount <= 0 && braceCount <= 0) {
            return [lines.slice(start, i + 1).join("\n"), i];
        }
    }
    return [null, start];
}
//# sourceMappingURL=mixed-content.js.map