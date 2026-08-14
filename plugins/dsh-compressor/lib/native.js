import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
export function nativeFileName(platform = process.platform, arch = process.arch) {
    if (platform === "darwin" && arch === "arm64") {
        return "dsh-compressor.darwin-arm64.node";
    }
    if (platform === "darwin" && arch === "x64") {
        return "dsh-compressor.darwin-x64.node";
    }
    if (platform === "linux" && arch === "x64") {
        return "dsh-compressor.linux-x64-gnu.node";
    }
    if (platform === "linux" && arch === "arm64") {
        return "dsh-compressor.linux-arm64-gnu.node";
    }
    return `dsh-compressor.${platform}-${arch}.node`;
}
function loadBinding() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, "..", "native", nativeFileName()),
        join(here, "..", "..", "native", nativeFileName()),
    ];
    for (const candidate of candidates) {
        try {
            return require(candidate);
        }
        catch {
            // try the next path
        }
    }
    return undefined;
}
const binding = loadBinding();
export function nativeAvailable() {
    return binding !== undefined;
}
function requireNative() {
    if (binding === undefined) {
        throw new Error(`dsh-compressor: native addon unavailable (${process.platform}-${process.arch}; expected ${nativeFileName()})`);
    }
    return binding;
}
export function crushLog(content, config, bias) {
    return requireNative().crushLog(content, config, bias);
}
export function crushSmart(content, query = "", bias = 1, config, withoutCompaction = true) {
    return requireNative().crushSmart(content, query, bias, config, withoutCompaction);
}
export function crushText(content, context = "", targetRatio) {
    return requireNative().crushText(content, context, targetRatio ?? null);
}
export function crushSearch(content, context = "", bias = 1, config) {
    return requireNative().crushSearch(content, context, bias, config);
}
export function crushDiff(content, context = "", config) {
    return requireNative().crushDiff(content, context, config);
}
export function detectContentType(content) {
    return requireNative().detectType(content);
}
export function crushByDetectedType(content, query = "") {
    const detected = detectContentType(content);
    switch (detected.contentType) {
        case "json_array":
            return crushSmart(content, query);
        case "search":
            return crushSearch(content, query);
        case "build": {
            const logged = crushLog(content);
            if (logged.wasModified) {
                return logged;
            }
            // Regex "build" false-positives on CJK/prose that mention ERROR.
            // Official LogCompressor also no-ops below min_lines; fall through
            // to TextCrusher so those payloads still crush.
            return crushText(content, query);
        }
        case "diff":
            return crushDiff(content, query);
        case "source_code":
            return {
                compressed: content,
                wasModified: false,
                strategy: "passthrough",
            };
        default:
            return crushText(content, query);
    }
}
//# sourceMappingURL=native.js.map