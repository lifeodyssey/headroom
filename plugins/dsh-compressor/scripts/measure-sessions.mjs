// Measure crush effect on the redacted real DSH session fixtures.
// Same seam as session-e2e: official Session.deriveMessages() after agent/pre-step.

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { Context } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { apply } from "../lib/index.js";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
const FIXTURE_DIR = join(ROOT, "fixtures", "sessions");
const LOCATOR = /<<compressor:([0-9a-f]{64})>>/g;

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-compressor-measure-"));

function loadSession(name) {
  const raw = zstdDecompressSync(readFileSync(join(FIXTURE_DIR, name))).toString("utf8");
  const [header, ...events] = raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  return Session.create(header.id, events, header);
}

function applyPlugin() {
  const handlers = new Map();
  const ctx = new Context();
  new SystemPrompt(ctx, { includeHarnessIdentity: false, persona: "" });
  const tools = new ToolRuntime(ctx, { mode: "native" });
  apply({
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    emit: () => {},
    tools,
    systemPrompt: ctx.systemPrompt,
  });
  const preStep = handlers.get("agent/pre-step");
  if (typeof preStep !== "function") {
    throw new Error("plugin did not register agent/pre-step");
  }
  return preStep;
}

const names = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(".jsonl.zstd"))
  .sort();
const preStep = applyPlugin();
const rows = [];

for (const name of names) {
  const session = loadSession(name);
  const before = JSON.stringify(session.deriveMessages());
  await preStep({ agent: { session } }, async () => ({ kind: "enter", messages: [] }));
  const after = JSON.stringify(session.deriveMessages());
  const locators = [...after.matchAll(LOCATOR)].length;
  const saved = before.length - after.length;
  const pct = before.length === 0 ? 0 : (saved / before.length) * 100;
  rows.push({
    fixture: name,
    beforeBytes: before.length,
    afterBytes: after.length,
    savedBytes: saved,
    pct,
    locators,
  });
  console.log(
    `${name}\t${before.length}\t${after.length}\t${pct.toFixed(1)}%\t${locators}`,
  );
}

const totalBefore = rows.reduce((sum, row) => sum + row.beforeBytes, 0);
const totalAfter = rows.reduce((sum, row) => sum + row.afterBytes, 0);
const totalLocators = rows.reduce((sum, row) => sum + row.locators, 0);
const crushedSessions = rows.filter((row) => row.locators > 0).length;

console.log("---");
console.log(
  JSON.stringify(
    {
      sessions: rows.length,
      crushedSessions,
      totalBeforeBytes: totalBefore,
      totalAfterBytes: totalAfter,
      savedBytes: totalBefore - totalAfter,
      pct: totalBefore === 0 ? 0 : ((totalBefore - totalAfter) / totalBefore) * 100,
      locators: totalLocators,
    },
    null,
    2,
  ),
);
