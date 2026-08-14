import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compressConversation,
  type ConversationMessage,
} from "./compress.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "dsh-session-messages.json",
);

describe("compressConversation", () => {
  it("leaves every message unchanged", () => {
    const messages = [
      { role: "user" as const, content: "fix the login" },
      { role: "tool" as const, content: "ok", toolName: "bash" },
    ];

    expect(compressConversation(messages)).toEqual(messages);
  });

  it("loads a redacted DSH-derived fixture as a message list", () => {
    const fixture = JSON.parse(
      readFileSync(fixturePath, "utf8"),
    ) as ConversationMessage[];

    expect(fixture.length).toBeGreaterThan(1);
    expect(
      fixture.every(
        (message) =>
          typeof message.role === "string" &&
          typeof message.content === "string",
      ),
    ).toBe(true);
    expect(JSON.stringify(fixture)).not.toMatch(/\/Users\/|\/private\/var\//);
    expect(compressConversation(fixture)).toEqual(fixture);
  });
});
