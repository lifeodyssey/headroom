import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

type NativeBinding = {
  crushLog: (
    content: string,
    config?: Record<string, unknown> | null,
    bias?: number | null,
  ) => CrushOut;
  crushSmart: (
    content: string,
    query?: string | null,
    bias?: number | null,
    config?: Record<string, unknown> | null,
    withoutCompaction?: boolean | null,
  ) => CrushOut;
  crushText: (
    content: string,
    context?: string | null,
    targetRatio?: number | null,
  ) => CrushOut;
  crushSearch: (
    content: string,
    context?: string | null,
    bias?: number | null,
    config?: Record<string, unknown> | null,
  ) => CrushOut;
  crushDiff: (
    content: string,
    context?: string | null,
    config?: Record<string, unknown> | null,
  ) => CrushOut;
  detectType: (content: string) => DetectOut;
};

const require = createRequire(import.meta.url);

function nativeFileName(): string {
  const platform = process.platform;
  const arch = process.arch;
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

function loadBinding(): NativeBinding | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "native", nativeFileName()),
    join(here, "..", "..", "native", nativeFileName()),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate) as NativeBinding;
    } catch {
      // try the next path
    }
  }
  return undefined;
}

const binding = loadBinding();

export function nativeAvailable(): boolean {
  return binding !== undefined;
}

function requireNative(): NativeBinding {
  if (binding === undefined) {
    throw new Error(
      `dsh-compressor: native addon unavailable (${process.platform}-${process.arch}; expected ${nativeFileName()})`,
    );
  }
  return binding;
}

export function crushLog(
  content: string,
  config?: Record<string, unknown>,
  bias?: number,
): CrushOut {
  return requireNative().crushLog(content, config, bias);
}

export function crushSmart(
  content: string,
  query = "",
  bias = 1,
  config?: Record<string, unknown>,
  withoutCompaction = true,
): CrushOut {
  return requireNative().crushSmart(content, query, bias, config, withoutCompaction);
}

export function crushText(
  content: string,
  context = "",
  targetRatio?: number,
): CrushOut {
  return requireNative().crushText(content, context, targetRatio ?? null);
}

export function crushSearch(
  content: string,
  context = "",
  bias = 1,
  config?: Record<string, unknown>,
): CrushOut {
  return requireNative().crushSearch(content, context, bias, config);
}

export function crushDiff(
  content: string,
  context = "",
  config?: Record<string, unknown>,
): CrushOut {
  return requireNative().crushDiff(content, context, config);
}

export function detectContentType(content: string): DetectOut {
  return requireNative().detectType(content);
}

export function crushByDetectedType(content: string, query = ""): CrushOut {
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
