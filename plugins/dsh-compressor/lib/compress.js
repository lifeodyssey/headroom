import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMixedContent, splitIntoSections, } from "./mixed-content.js";
import { crushByDetectedType, detectContentType, nativeAvailable } from "./native.js";
// Official ContentRouter defaults (Kompress and code-aware stay off).
const PROTECT_RECENT_CODE = 4;
const MIN_TOKENS_TO_COMPRESS = 50;
const MIN_CHARS_FOR_BLOCK_COMPRESSION = 500;
const ERROR_PROTECTION_MAX_CHARS = 8000;
const CHARS_PER_TOKEN = 4;
const CHARS_PER_TOKEN_CJK = 1.5;
const ERROR_INDICATOR_KEYWORDS = [
    "error",
    "fail",
    "exception",
    "traceback",
    "fatal",
    "panic",
    "crash",
];
const ZERO_RESULT_PATTERN = /\b(?:0|no)\s+(?:errors?|fail(?:ed|ing|ures?)?)\b|\b(?:errors?|fail(?:ed|ing|ures?)?)\s*[:=]\s*0\b/gi;
const RETRIEVE_HINT = "Call compressor_retrieve with this locator or its hash to restore the original. This is not a filesystem path.";
function contentHash(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}
function resolveStoreDir(storeDir) {
    if (storeDir !== undefined && storeDir.length > 0) {
        return storeDir;
    }
    const home = process.env.DSH_HOME?.trim();
    const root = home !== undefined && home.length > 0 ? home : join(homedir(), ".dsh");
    return join(root, "dsh-compressor");
}
const DEFAULT_EXCLUDE_TOOLS = new Set([
    "read",
    "glob",
    "grep",
    "write",
    "edit",
    "websearch",
    "web_search",
    "webfetch",
    "web_fetch",
    "compressor_retrieve",
    "headroom_retrieve",
]);
const LOCATOR_PATTERN = /<<compressor:([0-9a-fA-F]{64})>>/;
const BARE_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;
const SPILL_STORED_AT = "Full formatted result stored at:";
const SPILL_RETRIEVE_HINT = /use read with offset\/limit, or grep this path/i;
function isOfficialSpillNotice(text) {
    return text.includes(SPILL_STORED_AT) && SPILL_RETRIEVE_HINT.test(text);
}
// Crush writes locators. Refuse until apply() actually registered retrieve.
let retrieveRegistered = false;
export function markRetrieveRegistered() {
    retrieveRegistered = true;
}
export function resetRetrieveRegistered() {
    retrieveRegistered = false;
}
function isExcludedTool(toolName) {
    return toolName !== undefined && DEFAULT_EXCLUDE_TOOLS.has(toolName.toLowerCase());
}
function contentHasStrongErrorIndicators(text) {
    const lowered = text.toLowerCase().replace(ZERO_RESULT_PATTERN, " ");
    let hits = 0;
    for (const keyword of ERROR_INDICATOR_KEYWORDS) {
        if (lowered.includes(keyword)) {
            hits += 1;
            if (hits >= 2) {
                return true;
            }
        }
    }
    return false;
}
function looksLikeProtectedError(text) {
    // Official ContentRouter: keyword path needs ≥2 distinct indicators.
    return contentHasStrongErrorIndicators(text);
}
function isProtectedErrorOutput(message) {
    if (message.role !== "tool") {
        return false;
    }
    if (message.content.length > ERROR_PROTECTION_MAX_CHARS) {
        return false;
    }
    if (message.isError === true) {
        return true;
    }
    return looksLikeProtectedError(message.content);
}
function isRecentSourceCode(content, messagesFromEnd) {
    if (messagesFromEnd > PROTECT_RECENT_CODE || !nativeAvailable()) {
        return false;
    }
    return detectContentType(content).contentType === "source_code";
}
function isCjkCodePoint(codePoint) {
    return ((codePoint >= 0x3000 && codePoint <= 0x303f) ||
        (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
        (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
        (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xff00 && codePoint <= 0xffef) ||
        (codePoint >= 0x20000 && codePoint <= 0x2a6df));
}
function lastUserQuery(messages, index) {
    for (let i = index - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
            return messages[i].content;
        }
    }
    return "";
}
let loggedMissingNative = false;
function warnMissingNative() {
    if (loggedMissingNative) {
        return;
    }
    loggedMissingNative = true;
    console.error(`dsh-compressor: native addon unavailable (${process.platform}-${process.arch}); leaving content unchanged`);
}
function crushSection(section, query) {
    // Code-aware is off; fence bodies stay verbatim.
    const crushed = section.contentType === "source_code"
        ? section.content
        : crushByDetectedType(section.content, query).compressed;
    if (section.isCodeFence && section.language) {
        return `\`\`\`${section.language}\n${crushed}\n\`\`\``;
    }
    return crushed;
}
function crushMixed(original, query) {
    const sections = splitIntoSections(original);
    if (sections.length === 0) {
        return crushByDetectedType(original, query).compressed;
    }
    return sections.map((section) => crushSection(section, query)).join("\n\n");
}
function hasCodeFenceSection(original) {
    return splitIntoSections(original).some((section) => section.isCodeFence);
}
function visibleCrush(original, hash, query = "") {
    if (!nativeAvailable()) {
        warnMissingNative();
        return original;
    }
    let crushed;
    if (isMixedContent(original)) {
        crushed = crushMixed(original, query);
        // A 2-line run_code JSON blob can fail to shrink after mixed join.
        // Whole-blob detect is only safe when there is no code fence to re-crush.
        if (crushed.length >= original.length && !hasCodeFenceSection(original)) {
            crushed = crushByDetectedType(original, query).compressed;
        }
    }
    else {
        crushed = crushByDetectedType(original, query).compressed;
    }
    const locatorAndHint = `<<compressor:${hash}>>\n${RETRIEVE_HINT}`;
    if (crushed.length === 0) {
        return locatorAndHint;
    }
    if (crushed === original) {
        return original;
    }
    return `${crushed}\n${locatorAndHint}`;
}
function estimateTokens(text) {
    if (text.length === 0) {
        return 0;
    }
    let cjk = 0;
    let other = 0;
    for (const char of text) {
        const codePoint = char.codePointAt(0);
        if (codePoint !== undefined && isCjkCodePoint(codePoint)) {
            cjk += 1;
        }
        else {
            other += 1;
        }
    }
    return Math.max(1, Math.round(other / CHARS_PER_TOKEN + cjk / CHARS_PER_TOKEN_CJK));
}
export function retrieve(locatorOrHash, options) {
    if (typeof locatorOrHash !== "string" || locatorOrHash.length === 0) {
        throw new Error("compressor_retrieve: missing or unknown hash");
    }
    const locatorMatch = locatorOrHash.match(LOCATOR_PATTERN);
    const extracted = locatorMatch?.[1] ??
        (BARE_HASH_PATTERN.test(locatorOrHash) ? locatorOrHash : undefined);
    if (extracted === undefined) {
        throw new Error("compressor_retrieve: missing or unknown hash");
    }
    const hash = extracted.toLowerCase();
    try {
        return readFileSync(join(resolveStoreDir(options?.storeDir), hash), "utf8");
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            throw new Error(`compressor_retrieve: unknown hash ${hash}`);
        }
        throw error;
    }
}
export function compressConversation(messages, options) {
    if (!retrieveRegistered) {
        return messages.map((message) => ({ ...message }));
    }
    return messages.map((message, index) => {
        if (message.role === "user" || message.role === "system" || message.role === "assistant") {
            return { ...message };
        }
        if (isExcludedTool(message.toolName)) {
            return { ...message };
        }
        if (message.compressed === true) {
            return { ...message };
        }
        // Already-marked content (official skip policy): a locator in the text
        // means this result was crushed on an earlier pass — pre-step re-derives
        // messages from the session surface without the in-memory `compressed`
        // flag, and recompressing would nest locators and bust the prefix cache.
        if (LOCATOR_PATTERN.test(message.content)) {
            return { ...message };
        }
        if (isOfficialSpillNotice(message.content)) {
            return { ...message };
        }
        if (estimateTokens(message.content) < MIN_TOKENS_TO_COMPRESS ||
            message.content.length < MIN_CHARS_FOR_BLOCK_COMPRESSION) {
            return { ...message };
        }
        if (isProtectedErrorOutput(message)) {
            return { ...message };
        }
        if (isRecentSourceCode(message.content, messages.length - index)) {
            return { ...message };
        }
        const hash = contentHash(message.content);
        const crushed = visibleCrush(message.content, hash, lastUserQuery(messages, index));
        if (crushed.length >= message.content.length) {
            return { ...message };
        }
        const storeDir = resolveStoreDir(options?.storeDir);
        mkdirSync(storeDir, { recursive: true });
        writeFileSync(join(storeDir, hash), message.content, "utf8");
        return {
            ...message,
            compressed: true,
            content: crushed,
        };
    });
}
//# sourceMappingURL=compress.js.map