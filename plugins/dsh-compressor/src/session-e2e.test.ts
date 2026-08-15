// Offline e2e at the one seam that matters: the official DSH Session.
//
// Fixtures are redacted real local sessions (scripts/make-session-fixtures.mjs).
// No network, no model, no live dsh. The plugin is applied exactly the way the
// agent loop drives it: hooks registered via ctx.on, pre-step invoked as a
// waterfall with the real Session in the payload.

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { Session } from "@deepseek-ai/dsh-session";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { retrieve } from "./compress.js";
import { apply } from "./index.js";
import { bootOfficialTools } from "./test-helpers.js";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/sessions/", import.meta.url));
const LOCATOR = /<<compressor:([0-9a-f]{64})>>/g;

type PreStepHandler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;

function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".jsonl.zstd"))
    .sort();
}

function loadFixtureSession(name: string): InstanceType<typeof Session> {
  const raw = zstdDecompressSync(readFileSync(join(FIXTURE_DIR, name))).toString("utf8");
  const [header, ...events] = raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
  return Session.create(header.id, events, header);
}

function applyPlugin() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const { ctx, tools } = bootOfficialTools();
  apply({
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    },
    emit: () => {},
    tools,
    systemPrompt: ctx.systemPrompt,
  });
  const preStep = handlers.get("agent/pre-step") as PreStepHandler | undefined;
  if (preStep === undefined) {
    throw new Error("plugin did not register agent/pre-step");
  }
  return { preStep, handlers, tools };
}

async function runPreStep(preStep: PreStepHandler, session: InstanceType<typeof Session>) {
  return preStep({ agent: { session } }, async () => ({ kind: "enter", messages: [] }));
}

beforeAll(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-compressor-e2e-"));
});

describe("offline e2e against official Session", () => {
  it("pre-step rewrite reaches Session.deriveMessages()", async () => {
    const session = loadFixtureSession(fixtureNames()[0]!);
    const before = JSON.stringify(session.deriveMessages());
    expect(before).not.toMatch(LOCATOR);

    const { preStep } = applyPlugin();
    await runPreStep(preStep, session);

    const after = JSON.stringify(session.deriveMessages());
    const locators = [...after.matchAll(LOCATOR)];
    expect(locators.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(before.length);
  });

  it("every locator retrieves the original bytes, never another locator", async () => {
    const session = loadFixtureSession(fixtureNames()[0]!);
    const before = JSON.stringify(session.deriveMessages());

    const { preStep } = applyPlugin();
    await runPreStep(preStep, session);

    const after = JSON.stringify(session.deriveMessages());
    const hashes = [...after.matchAll(LOCATOR)].map((m) => m[1]!);
    expect(hashes.length).toBeGreaterThan(0);
    for (const hash of hashes) {
      const original = await retrieve(hash);
      expect(original).not.toMatch(LOCATOR);
      // The restored text must be exactly what the model would have seen
      // before compression: present verbatim in the pre-rewrite derivation.
      expect(before).toContain(JSON.stringify(original).slice(1, -1));
    }
  });

  it("redeems every locator through official ToolRuntime.execute", async () => {
    const session = loadFixtureSession(fixtureNames()[0]!);
    const before = JSON.stringify(session.deriveMessages());

    const { preStep, tools } = applyPlugin();
    await runPreStep(preStep, session);

    const after = JSON.stringify(session.deriveMessages());
    const hashes = [...after.matchAll(LOCATOR)].map((m) => m[1]!);
    expect(hashes.length).toBeGreaterThan(0);

    expect(tools).toBeInstanceOf(ToolRuntime);
    expect(tools.schemas().map((schema) => schema.name)).toContain(
      "compressor_retrieve",
    );

    for (const hash of hashes) {
      const result = await tools.execute({
        callId: `e2e-${hash.slice(0, 12)}`,
        name: "compressor_retrieve",
        arguments: { locator: hash },
        signal: new AbortController().signal,
      });
      expect(result.isError, hash).toBe(false);
      if (result.isError) {
        continue;
      }
      expect(result.value).not.toMatch(LOCATOR);
      expect(before).toContain(JSON.stringify(result.value).slice(1, -1));
    }
  });

  it("a second pre-step pass is a no-op: derived prefix is byte-stable", async () => {
    const session = loadFixtureSession(fixtureNames()[0]!);
    const { preStep } = applyPlugin();

    await runPreStep(preStep, session);
    const first = JSON.stringify(session.deriveMessages());

    await runPreStep(preStep, session);
    const second = JSON.stringify(session.deriveMessages());

    // Prefix stability is the cache guarantee: once a compressed derivation is
    // sent, later steps must not rewrite it again or the provider prefix cache
    // is invalidated on every step.
    expect(second).toBe(first);
  });

  it("post-execute output fed back through pre-step never nests locators", async () => {
    const { handlers } = applyPlugin();
    const postExecute = handlers.get("tools/post-execute") as (
      exec: unknown,
      result: unknown,
      next: () => Promise<unknown>,
    ) => Promise<{ kind?: string; content?: Array<{ text?: string }> }>;
    expect(postExecute).toBeDefined();

    // Crush a big tool result the way the tool layer would. Do not use
    // deriveMessages() here: real sessions embed official spill footers,
    // and those stay verbatim (#23).
    const bigText =
      "build log line: compilation unit failed with diagnostics\n".repeat(80);
    const decision = await postExecute(
      { name: "run_code" },
      { content: [{ type: "text", text: bigText }], isError: false },
      async () => ({ kind: "accept" }),
    );
    const crushed = decision.content?.[0]?.text;
    expect(crushed).toBeDefined();
    expect(crushed).toMatch(LOCATOR);

    // The same content re-entering compression (as pre-step does after the
    // crushed text lands in the session) must pass through untouched.
    const { compressConversation } = await import("./compress.js");
    const [again] = compressConversation([{ role: "tool", content: crushed! }]);
    expect(again!.content).toBe(crushed);
    const hash = [...crushed!.matchAll(LOCATOR)][0]![1]!;
    expect(await retrieve(hash)).toBe(bigText);
  });

  it("growing session: new results get compressed, the sent prefix stays byte-identical", async () => {
    const session = loadFixtureSession(fixtureNames()[0]!);
    const { preStep } = applyPlugin();

    await runPreStep(preStep, session);
    const baseline = session.deriveMessages();

    // Append a fresh big tool result the way the tool layer persists one:
    // clone a real event's envelope, swap in new content and an unseen callId.
    const events = session.events as Array<{ type: string; data?: unknown }>;
    const template = events.find(
      (e) =>
        e.type === "tool/result" &&
        (e.data as { message?: { content?: Array<{ type?: string }> } })?.message
          ?.content?.[0]?.type === "tool-result",
    );
    expect(template).toBeDefined();
    const data = structuredClone(template!.data) as {
      message: { source?: { callId?: string }; content: Array<{ toolCallId?: string; content: unknown }> };
    };
    const freshLine = "[worker-7] request handled status=200 latency_ms=13\n";
    if (data.message.source?.callId !== undefined) data.message.source.callId = "call_e2e_growth";
    data.message.content[0]!.toolCallId = "call_e2e_growth";
    data.message.content[0]!.content = [{ type: "text", text: freshLine.repeat(200) }];
    session.append("tool/result", data, { surfaceOp: "append" });

    await runPreStep(preStep, session);
    const grown = session.deriveMessages();

    expect(grown.length).toBe(baseline.length + 1);
    // Cache guarantee: everything already sent to the model is untouched.
    expect(JSON.stringify(grown.slice(0, baseline.length))).toBe(JSON.stringify(baseline));
    // And the newcomer was compressed.
    expect(JSON.stringify(grown.at(-1))).toMatch(LOCATOR);
  });

  it("bulk: compresses every redacted real session with stable, retrievable results", { timeout: 60_000 }, async () => {
    const { preStep } = applyPlugin();
    const rows: Array<{ fixture: string; before: number; after: number; locators: number }> = [];

    for (const name of fixtureNames()) {
      const session = loadFixtureSession(name);
      const before = JSON.stringify(session.deriveMessages());

      await runPreStep(preStep, session);
      const after = JSON.stringify(session.deriveMessages());

      await runPreStep(preStep, session);
      expect(JSON.stringify(session.deriveMessages()), `${name}: unstable prefix`).toBe(after);

      const hashes = [...after.matchAll(LOCATOR)].map((m) => m[1]!);
      for (const hash of hashes) {
        const original = await retrieve(hash);
        expect(original, `${name}: nested locator`).not.toMatch(LOCATOR);
        expect(before, `${name}: retrieve is not the original`).toContain(
          JSON.stringify(original).slice(1, -1),
        );
      }
      rows.push({ fixture: name, before: before.length, after: after.length, locators: hashes.length });
    }

    const totalBefore = rows.reduce((s, r) => s + r.before, 0);
    const totalAfter = rows.reduce((s, r) => s + r.after, 0);
    for (const r of rows) {
      console.log(
        `${r.fixture}  ${r.before} -> ${r.after} bytes  (${((1 - r.after / r.before) * 100).toFixed(1)}% saved, ${r.locators} locators)`,
      );
    }
    console.log(
      `TOTAL  ${totalBefore} -> ${totalAfter} bytes  (${((1 - totalAfter / totalBefore) * 100).toFixed(1)}% saved over ${rows.length} sessions)`,
    );

    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.filter((r) => r.locators > 0).length).toBeGreaterThan(rows.length / 2);
    expect(totalAfter).toBeLessThan(totalBefore);
  });
});
