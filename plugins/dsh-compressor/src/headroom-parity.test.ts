import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  crushDiff,
  crushLog,
  crushSmart,
  crushText,
  detectContentType,
  nativeAvailable,
} from "./native.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixturesRoot = join(repoRoot, "tests", "parity", "fixtures");

type Fixture = {
  name: string;
  input: unknown;
  output: Record<string, unknown>;
  config: Record<string, unknown> | null;
};

function loadFixtures(kind: string): Fixture[] {
  const dir = join(fixturesRoot, kind);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const data = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        input: unknown;
        output: Record<string, unknown>;
        config?: Record<string, unknown> | null;
      };
      return {
        name,
        input: data.input,
        output: data.output,
        config: data.config ?? null,
      };
    });
}

function fixtureStringInput(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  throw new Error("expected string fixture input");
}

describe("official Headroom parity fixtures (native)", () => {
  it("loads the official native addon on this platform", () => {
    expect(nativeAvailable()).toBe(true);
  });

  it("matches every log_compressor fixture byte-for-byte", () => {
    const fixtures = loadFixtures("log_compressor");
    expect(fixtures.length).toBe(20);
    for (const fixture of fixtures) {
      const actual = crushLog(
        fixtureStringInput(fixture.input),
        fixture.config ?? undefined,
      );
      expect(actual.compressed, fixture.name).toBe(fixture.output.compressed);
    }
  });

  it("matches every smart_crusher fixture byte-for-byte", () => {
    const fixtures = loadFixtures("smart_crusher");
    expect(fixtures.length).toBe(17);
    for (const fixture of fixtures) {
      const input = fixture.input as {
        content: string;
        query?: string;
        bias?: number;
      };
      const actual = crushSmart(
        input.content,
        input.query ?? "",
        input.bias ?? 1,
        fixture.config ?? undefined,
        true,
      );
      expect(actual.compressed, fixture.name).toBe(fixture.output.compressed);
      expect(actual.wasModified, fixture.name).toBe(fixture.output.was_modified);
      expect(actual.strategy, fixture.name).toBe(fixture.output.strategy);
    }
  });

  it("matches every text_crusher fixture byte-for-byte", () => {
    const fixtures = loadFixtures("text_crusher");
    expect(fixtures.length).toBe(6);
    for (const fixture of fixtures) {
      const input = fixture.input as {
        content: string;
        context?: string;
        target_ratio?: number | null;
      };
      const actual = crushText(
        input.content,
        input.context ?? "",
        input.target_ratio ?? undefined,
      );
      expect(actual.compressed, fixture.name).toBe(fixture.output.compressed);
      expect(actual.originalTokens, fixture.name).toBe(fixture.output.original_tokens);
      expect(actual.compressedTokens, fixture.name).toBe(fixture.output.compressed_tokens);
      expect(actual.keptSegments, fixture.name).toBe(fixture.output.kept_segments);
      expect(actual.totalSegments, fixture.name).toBe(fixture.output.total_segments);
      expect(actual.compressionRatio, fixture.name).toBeCloseTo(
        fixture.output.compression_ratio as number,
        9,
      );
    }
  });

  it("matches every content_detector fixture", () => {
    const fixtures = loadFixtures("content_detector");
    expect(fixtures.length).toBe(21);
    for (const fixture of fixtures) {
      const actual = detectContentType(fixtureStringInput(fixture.input));
      expect(actual.contentType, fixture.name).toBe(fixture.output.content_type);
      expect(actual.confidence, fixture.name).toBeCloseTo(
        fixture.output.confidence as number,
        10,
      );
      expect(JSON.parse(actual.metadataJson), fixture.name).toEqual(
        fixture.output.metadata ?? {},
      );
    }
  });

  it("matches every diff_compressor compressed field", () => {
    const fixtures = loadFixtures("diff_compressor");
    expect(fixtures.length).toBe(27);
    for (const fixture of fixtures) {
      const actual = crushDiff(
        fixtureStringInput(fixture.input),
        "",
        fixture.config ?? undefined,
      );
      expect(actual.compressed, fixture.name).toBe(fixture.output.compressed);
    }
  });
});
