// Builds redacted real-session fixtures for the offline e2e suite.
//
// Reads local DSH session logs (~/.dsh/sessions/**/session.jsonl.zstd),
// keeps sessions that contain compressible tool/result payloads, redacts
// user-identifying strings, and re-validates every fixture by seeding an
// official Session before writing it to fixtures/sessions/.
//
// Usage: node scripts/make-session-fixtures.mjs [--max 20] [--min-blob 2000]

import { globSync } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { Session, decodeStorageRecord } from "@deepseek-ai/dsh-session";

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
}
const MAX_FIXTURES = flag("max", 20);
const MIN_BLOB_CHARS = flag("min-blob", 2000);
const MAX_EVENTS = flag("max-events", 20000);
const MAX_RAW_BYTES = flag("max-raw-bytes", 8 * 1024 * 1024);

const OUT_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "fixtures", "sessions");
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");

const USERNAME = basename(homedir());

// Personal terms (real name, handles, domains) live in a gitignored local
// file so the committed script never carries the identity list itself.
// Format: {"terms": ["..."], "forbidden": ["..."]} — terms are redacted to
// "user" case-insensitively and automatically added to the forbidden gate.
const LOCAL_TERMS_PATH = join(dirname(new URL(import.meta.url).pathname), "redact.local.json");
let localTerms = { terms: [], forbidden: [] };
try {
  localTerms = JSON.parse(readFileSync(LOCAL_TERMS_PATH, "utf8"));
} catch {
  console.warn(`no ${LOCAL_TERMS_PATH}; only generic redaction rules apply`);
}

// Redaction is a pure string->string function. Determinism matters: replace
// surface events must stay deep-equal to their shadowed events outside
// content[0].content, so identical inputs must redact identically.
const RULES = [
  [new RegExp(`/Users/${USERNAME}`, "g"), "/Users/user"],
  [new RegExp(`/home/${USERNAME}`, "g"), "/home/user"],
  [new RegExp(USERNAME, "g"), "user"],
  ...localTerms.terms.map((t) => [new RegExp(t, "gi"), "user"]),
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "redacted@example.com"],
  [/\b(sk|pk)-[A-Za-z0-9_-]{16,}/g, "sk-REDACTED"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "ghp_REDACTED"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "github_pat_REDACTED"],
  [/\bxox[a-z]-[A-Za-z0-9-]{10,}/g, "xoxb-REDACTED"],
  [/\bAKIA[A-Z0-9]{8,}\b/g, "AKIA_REDACTED"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "REDACTED.JWT.TOKEN"],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/g, "Bearer REDACTED"],
];

// Strings that must never appear in a written fixture.
const FORBIDDEN = [
  USERNAME,
  "@gmail.com",
  "@qq.com",
  "github_pat_1",
  "sk-proj",
  ...localTerms.terms,
  ...(localTerms.forbidden ?? []),
];

function redactString(s) {
  let out = s;
  for (const [re, sub] of RULES) out = out.replace(re, sub);
  return out;
}

function redactValue(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out;
  }
  return value;
}

function loadSessionLog(path) {
  // Session logs are multi-frame zstd (one frame per persisted write); node's
  // zstdDecompressSync stops after the first frame, so use the zstd CLI here.
  // Emitted fixtures are single-frame and readable with node:zlib.
  const raw = execFileSync("zstd", ["-dc", path], { maxBuffer: 1 << 28 }).toString("utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length < 2) return undefined;
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return undefined;
  }
  if (header?.type !== "session") return undefined;
  const events = [];
  for (const line of lines.slice(1)) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined; // torn tail or corrupt log: skip whole session
    }
    let decoded;
    try {
      decoded = decodeStorageRecord(parsed);
    } catch {
      return undefined;
    }
    for (const event of decoded) {
      if (event.seq !== events.length) return undefined; // seq gap
      events.push(event);
    }
  }
  return { header, events };
}

function flattenText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (b?.type === "text" && typeof b.text === "string") return b.text;
      if (b?.type === "tool-result") return flattenText(b.content);
      return "";
    })
    .join("");
}

function compressiblePayload(events) {
  let total = 0;
  for (const e of events) {
    if (e.type !== "tool/result") continue;
    const text = flattenText(e.data?.message?.content?.[0]?.content ?? e.data?.message?.content);
    if (text.length >= MIN_BLOB_CHARS) total += text.length;
  }
  return total;
}

function seedable(events) {
  try {
    Session.create("fixture-check", events);
    return true;
  } catch {
    return false;
  }
}

const logs = globSync(join(DSH_HOME, "sessions", "**", "*.jsonl.zstd"));
const candidates = [];
for (const path of logs) {
  const loaded = loadSessionLog(path);
  if (loaded === undefined) continue;
  if (loaded.events.length > MAX_EVENTS) continue;
  if (JSON.stringify(loaded.events).length > MAX_RAW_BYTES) continue;
  const payload = compressiblePayload(loaded.events);
  if (payload < MIN_BLOB_CHARS) continue;
  if (!seedable(loaded.events)) continue;
  candidates.push({ path, ...loaded, payload });
}
candidates.sort((a, b) => b.payload - a.payload);

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const manifest = [];
let written = 0;
for (const c of candidates) {
  if (written >= MAX_FIXTURES) break;
  const header = redactValue({ ...c.header, cwd: c.header.cwd ?? "" });
  const events = redactValue(c.events);
  if (!seedable(events)) {
    console.warn(`skip (redaction broke seed): ${c.path}`);
    continue;
  }
  const serialized = [header, ...events].map((v) => JSON.stringify(v)).join("\n") + "\n";
  const hit = FORBIDDEN.find((f) => serialized.includes(f));
  if (hit !== undefined) {
    console.warn(`skip (forbidden string "${hit}" survived redaction): ${c.path}`);
    continue;
  }
  const name = `session-${String(written).padStart(3, "0")}.jsonl.zstd`;
  writeFileSync(join(OUT_DIR, name), zstdCompressSync(Buffer.from(serialized)));
  manifest.push({
    name,
    sourceHash: createHash("sha256").update(c.path).digest("hex").slice(0, 12),
    events: events.length,
    compressiblePayloadChars: c.payload,
  });
  written += 1;
}

writeFileSync(
  join(OUT_DIR, "manifest.json"),
  JSON.stringify({ generatedFrom: "local ~/.dsh/sessions (redacted)", minBlobChars: MIN_BLOB_CHARS, fixtures: manifest }, null, 2) + "\n",
);
console.log(`scanned ${logs.length} logs, ${candidates.length} candidates, wrote ${written} fixtures to ${OUT_DIR}`);
