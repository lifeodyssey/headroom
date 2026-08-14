import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compressConversation,
  retrieve,
  type ConversationMessage,
} from "./compress.js";

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "headroom",
);

const PROTECTED_TAIL: ConversationMessage[] = [
  { role: "assistant", content: "tail-1" },
  { role: "assistant", content: "tail-2" },
  { role: "assistant", content: "tail-3" },
  { role: "assistant", content: "tail-4" },
];

type HeadroomFixture = {
  input?: unknown;
  output?: { compressed?: string; was_modified?: boolean };
};

function loadFixtures(kind: string): Array<{ name: string; data: HeadroomFixture }> {
  const dir = join(fixturesRoot, kind);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      data: JSON.parse(readFileSync(join(dir, name), "utf8")) as HeadroomFixture,
    }));
}

function fixtureInput(data: HeadroomFixture): string {
  const input = data.input;
  if (typeof input === "string") {
    return input;
  }
  if (input !== null && typeof input === "object" && "content" in input) {
    const content = (input as { content?: unknown }).content;
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  throw new Error("unrecognized Headroom fixture input");
}

function crush(text: string, toolName = "bash"): ConversationMessage {
  const [message] = compressConversation([
    { role: "tool", content: text, toolName },
    ...PROTECTED_TAIL,
  ]);
  if (message === undefined) {
    throw new Error("missing crushed message");
  }
  return message;
}

describe("Headroom compressor fixtures", () => {
  it("runs official log_compressor inputs through compress-conversation", () => {
    const fixtures = loadFixtures("log_compressor");
    expect(fixtures.length).toBeGreaterThan(0);

    for (const { name, data } of fixtures) {
      const original = fixtureInput(data);
      const crushed = crush(original);
      if (crushed.content.includes("<<compressor:")) {
        expect(retrieve(crushed.content), name).toBe(original);
      } else {
        expect(crushed.content, name).toBe(original);
      }
      if (original.includes("ERROR") || original.includes("FAILED")) {
        expect(crushed.content, name).toMatch(/ERROR|FAILED|Traceback/);
      }
      if (original.length > 2000) {
        expect(crushed.content.length, name).toBeLessThan(original.length);
      }
    }
  });

  it("runs official smart_crusher inputs through compress-conversation", () => {
    const fixtures = loadFixtures("smart_crusher");
    expect(fixtures.length).toBeGreaterThan(0);

    for (const { name, data } of fixtures) {
      const original = fixtureInput(data);
      const crushed = crush(original);
      if (crushed.content.includes("<<compressor:")) {
        expect(retrieve(crushed.content), name).toBe(original);
      } else {
        expect(crushed.content, name).toBe(original);
      }
      if (data.output?.was_modified === true && original.length > 500) {
        expect(crushed.content.length, name).toBeLessThan(original.length);
      }
    }
  });

  it("runs official text_crusher CJK/unicode inputs through compress-conversation", () => {
    const fixtures = loadFixtures("text_crusher");
    expect(fixtures.length).toBeGreaterThan(0);

    for (const { name, data } of fixtures) {
      const original = fixtureInput(data);
      const crushed = crush(original, "web_other");
      if (crushed.content.includes("<<compressor:")) {
        expect(retrieve(crushed.content), name).toBe(original);
      } else {
        expect(crushed.content, name).toBe(original);
      }
      if (original.includes("句子")) {
        expect(crushed.content, name).toMatch(/句子/);
      }
      if (crushed.content.includes("<<compressor:")) {
        expect(crushed.content.length, name).toBeLessThan(original.length);
      }
    }
  });
});
