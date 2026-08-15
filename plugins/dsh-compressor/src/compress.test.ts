import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  compressConversation,
  retrieve,
  type ConversationMessage,
} from "./compress.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "dsh-session-messages.json",
);

const stores: string[] = [];

afterEach(() => {
  for (const dir of stores.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-compressor-store-"));
  stores.push(dir);
  return dir;
}

const LONG_ORIGINAL =
  "build log line: compilation unit failed with diagnostics\n".repeat(80);
const LONG_HASH =
  "64d6e256de1ad9729bb570c78ec9c3ad7701b707dcc31f5d8d08a5ddd1c293af";
const LONG_LOCATOR = `<<compressor:${LONG_HASH}>>`;
const RETRIEVE_HINT =
  "Call compressor_retrieve with this locator or its hash to restore the original. This is not a filesystem path.";

const PROTECTED_TAIL: ConversationMessage[] = [
  { role: "assistant", content: "tail-1" },
  { role: "assistant", content: "tail-2" },
  { role: "assistant", content: "tail-3" },
  { role: "assistant", content: "tail-4" },
];

function withProtectedTail(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return [...messages, ...PROTECTED_TAIL];
}

function sourceCodeBlob(): string {
  return Array.from(
    { length: 40 },
    (_, index) =>
      `function handleRequest${index}(req, res) {\n` +
      `  const uniqueBody${index} = computePayload${index}(req);\n` +
      `  res.end(JSON.stringify({ uniqueBody${index}, index: ${index} }));\n` +
      `  return uniqueBody${index};\n` +
      `}`,
  ).join("\n");
}

function underCharGateProse(): string {
  return Array.from(
    { length: 20 },
    (_, index) =>
      `第${index}号监控服务器的日志显示子系统今天运行平稳没有出现异常。`,
  )
    .join("")
    .slice(0, 400);
}

function midSizeInfoLog(): string {
  return Array.from(
    { length: 32 },
    (_, index) => `INFO compiling unit ${index} ok`,
  ).join("\n");
}

function errorTraceback(): string {
  return (
    "Traceback (most recent call last):\n" +
    Array.from(
      { length: 12 },
      (_, index) =>
        `  File "/app/services/worker_${index}.py", line ${index * 17}, in handle_request\n` +
        `    result = downstream.dispatch(payload, retries=${index})\n`,
    ).join("") +
    "ValueError: connection refused while dispatching payload to upstream " +
    "service after 3 retries; check that the worker pool is initialized " +
    "before the scheduler starts accepting jobs\n"
  );
}

function mixedLogListCjk(): string {
  const logLines = ["===== test session starts ====="];
  // Stay over the 8000-char error-protection cap so FAIL/ERROR logs
  // still reach LogCompressor instead of being held verbatim.
  for (let i = 0; i < 160; i++) {
    logLines.push(`INFO compiling unit ${i} ok`);
  }
  for (let i = 0; i < 15; i++) {
    logLines.push("FAIL compilation unit failed with diagnostics");
  }
  logLines.push("ERROR cannot find symbol Foo");
  logLines.push("INFO compiling leftover unit ok");
  logLines.push("===== 1 failed, 80 passed =====");

  const list = Array.from(
    { length: 80 },
    (_, index) =>
      `- file src/module-${index}.ts size=${1000 + index} hash=abc${index}`,
  ).join("\n");

  const filler = Array.from(
    { length: 24 },
    (_, index) =>
      `第${index}号监控服务器的日志显示子系统今天运行平稳没有出现异常。`,
  ).join("");
  const needle =
    "认证令牌的缓存采用最近最少使用淘汰算法。" +
    "parseConfig 在端口 8080 请求 https://example.com/auth 时返回 ERROR。" +
    "详见《认证令牌规范》。";
  const prose = `${filler.slice(0, filler.length / 2)}${needle}${filler.slice(filler.length / 2)}`;

  return `${logLines.join("\n")}\n\n${list}\n\n${prose}`;
}

function officialMixedPayload(): string {
  const prose = Array.from(
    { length: 20 },
    (_, index) =>
      `First sentence has enough words to count in paragraph ${index} with extra padding text.`,
  ).join("\n");
  const code = [
    "```python",
    "def unique_marker_function():",
    "    return 'keep-this-code-verbatim-xyz'",
    "```",
  ].join("\n");
  const items = Array.from({ length: 80 }, (_, index) => ({
    id: index,
    name: `record-${index}`,
    status: index === 79 ? "error" : "ok",
    detail: `payload field for record ${index} with extra padding text`,
  }));
  const json = JSON.stringify(items, null, 2);
  const search = Array.from(
    { length: 80 },
    (_, index) => `src/app.py:${index}:print('hit-${index}')`,
  ).join("\n");
  return `${prose}\n${code}\n${json}\n${search}`;
}

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

  it("writes one disk object and rewrites a long message to a locator plus retrieve hint", () => {
    const storeDir = tempStore();
    const messages = withProtectedTail([
      { role: "tool" as const, content: LONG_ORIGINAL, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });

    expect(compressed[0]).toMatchObject({
      role: "tool",
      toolName: "bash",
      compressed: true,
    });
    expect(compressed[0]?.content).toContain(LONG_LOCATOR);
    expect(compressed[0]?.content).toContain(RETRIEVE_HINT);
    expect(compressed[0]?.content.length).toBeLessThan(LONG_ORIGINAL.length);
    expect(compressed.slice(1)).toEqual(PROTECTED_TAIL);
    expect(readdirSync(storeDir)).toEqual([LONG_HASH]);
    expect(readFileSync(join(storeDir, LONG_HASH), "utf8")).toBe(LONG_ORIGINAL);
  });

  it("retrieves the original from the full locator", () => {
    const storeDir = tempStore();
    compressConversation(
      withProtectedTail([
        { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
      ]),
      { storeDir },
    );

    expect(retrieve(LONG_LOCATOR, { storeDir })).toBe(LONG_ORIGINAL);
  });

  it("retrieves the original from the bare content hash", () => {
    const storeDir = tempStore();
    compressConversation(
      withProtectedTail([
        { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
      ]),
      { storeDir },
    );

    expect(retrieve(LONG_HASH, { storeDir })).toBe(LONG_ORIGINAL);
  });

  it("retrieves after a simulated restart from disk only", () => {
    const storeDir = tempStore();
    writeFileSync(join(storeDir, LONG_HASH), LONG_ORIGINAL, "utf8");

    expect(retrieve(LONG_LOCATOR, { storeDir })).toBe(LONG_ORIGINAL);
  });

  it("fails clearly when the hash is missing or unknown", () => {
    const storeDir = tempStore();
    const missing =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(() => retrieve(missing, { storeDir })).toThrowError(
      `compressor_retrieve: unknown hash ${missing}`,
    );
    expect(() => retrieve("not-a-locator-or-hash", { storeDir })).toThrowError(
      /compressor_retrieve: missing or unknown hash/,
    );
  });

  it("does not turn a compressor_retrieve result into a new locator", () => {
    const storeDir = tempStore();
    const messages = [
      {
        role: "tool" as const,
        toolName: "compressor_retrieve",
        content: LONG_ORIGINAL,
      },
    ];

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("uses a locator that is obviously not a filesystem path", () => {
    const storeDir = tempStore();
    const [compressed] = compressConversation(
      withProtectedTail([
        { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
      ]),
      { storeDir },
    );

    expect(compressed.content).toContain(LONG_LOCATOR);
    expect(compressed.content).toContain(RETRIEVE_HINT);
    expect(compressed.content).toMatch(/<<compressor:[0-9a-f]{64}>>/);
    expect(compressed.content).not.toMatch(/[/\\]/);
    expect(compressed.content).not.toMatch(/(?:^|[\s])(?:~|\.{0,2}\/)/);
    expect(retrieve(compressed.content, { storeDir })).toBe(LONG_ORIGINAL);
  });

  it("stores originals under DSH home when no storeDir is given", () => {
    const home = tempStore();
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const compressed = compressConversation(
        withProtectedTail([
          { role: "tool", content: LONG_ORIGINAL, toolName: "bash" },
        ]),
      );

      expect(compressed[0]?.content).toContain(LONG_LOCATOR);
      expect(compressed[0]?.content).toContain(RETRIEVE_HINT);
      expect(readFileSync(join(home, "dsh-compressor", LONG_HASH), "utf8")).toBe(
        LONG_ORIGINAL,
      );
      expect(retrieve(LONG_HASH)).toBe(LONG_ORIGINAL);
    } finally {
      if (previous === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = previous;
      }
    }
  });

  it("never compresses user messages", () => {
    const storeDir = tempStore();
    const messages = withProtectedTail([
      { role: "user", content: LONG_ORIGINAL },
    ]);

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("writes one disk object per content hash", () => {
    const storeDir = tempStore();
    const messages = withProtectedTail([
      { role: "tool" as const, content: LONG_ORIGINAL, toolName: "bash" },
      { role: "tool" as const, content: LONG_ORIGINAL, toolName: "run_code" },
    ]);

    const compressed = compressConversation(messages, { storeDir });

    expect(compressed[0]?.content).toContain(LONG_LOCATOR);
    expect(compressed[1]?.content).toBe(compressed[0]?.content);
    expect(compressed.slice(2).map((message) => message.content)).toEqual(
      PROTECTED_TAIL.map((message) => message.content),
    );
    expect(readdirSync(storeDir)).toEqual([LONG_HASH]);
  });

  it("leaves a 400-character block with enough tokens verbatim", () => {
    const storeDir = tempStore();
    const payload = underCharGateProse();
    const messages = withProtectedTail([
      { role: "tool" as const, content: payload, toolName: "bash" },
    ]);

    expect(payload.length).toBe(400);
    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("compresses an eligible block over 50 tokens and 500 characters", () => {
    const storeDir = tempStore();
    const payload = midSizeInfoLog();
    const messages = withProtectedTail([
      { role: "tool" as const, content: payload, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });

    expect(payload.length).toBeGreaterThan(500);
    expect(compressed[0]?.compressed).toBe(true);
    expect(compressed[0]?.content).toMatch(/<<compressor:[0-9a-f]{64}>>/);
    expect(compressed[0]?.content.length).toBeLessThan(payload.length);
    expect(retrieve(compressed[0]?.content, { storeDir })).toBe(payload);
  });

  it("leaves excluded coding-tool and retrieve results verbatim", () => {
    const storeDir = tempStore();
    const excludedTools = [
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "WebSearch",
      "WebFetch",
      "compressor_retrieve",
      "headroom_retrieve",
      "read",
      "web_search",
      "web_fetch",
    ];
    const messages = withProtectedTail(
      excludedTools.map((toolName) => ({
        role: "tool" as const,
        toolName,
        content: LONG_ORIGINAL,
      })),
    );

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("does not compress system messages by default", () => {
    const storeDir = tempStore();
    const messages = withProtectedTail([
      { role: "system" as const, content: LONG_ORIGINAL },
    ]);

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("does not compress assistant text", () => {
    const storeDir = tempStore();
    const messages = withProtectedTail([
      { role: "assistant" as const, content: LONG_ORIGINAL },
    ]);

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("does not treat a single error keyword as a protected output", () => {
    const storeDir = tempStore();
    const payload = Array.from(
      { length: 80 },
      (_, index) => `INFO compiling unit ${index} ok`,
    ).join("\n") + "\nERROR cannot find symbol Foo\n";
    const messages = withProtectedTail([
      { role: "tool" as const, content: payload, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });
    expect(compressed[0]?.compressed).toBe(true);
    expect(retrieve(compressed[0]?.content, { storeDir })).toBe(payload);
  });

  it("crushes an isError tool result once it exceeds the 8000 character cap", () => {
    const storeDir = tempStore();
    const payload = `${errorTraceback()}\n${"INFO padding line for size gate\n".repeat(200)}`;
    expect(payload.length).toBeGreaterThan(8000);
    const messages = withProtectedTail([
      {
        role: "tool" as const,
        content: payload,
        toolName: "bash",
        isError: true,
      },
    ]);

    const compressed = compressConversation(messages, { storeDir });
    expect(compressed[0]?.compressed).toBe(true);
    expect(retrieve(compressed[0]?.content, { storeDir })).toBe(payload);
  });

  it("leaves a short error traceback under 8000 characters verbatim", () => {
    const storeDir = tempStore();
    const traceback = errorTraceback();
    const messages = withProtectedTail([
      { role: "tool" as const, content: traceback, toolName: "bash" },
    ]);

    expect(traceback.length).toBeGreaterThan(500);
    expect(traceback.length).toBeLessThanOrEqual(8000);
    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("does not nest an already-marked compressed message into another locator", () => {
    const storeDir = tempStore();
    const messages = withProtectedTail([
      {
        role: "tool" as const,
        toolName: "bash",
        compressed: true,
        content: LONG_ORIGINAL,
      },
    ]);

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("leaves a message as-is when a locator would not shrink it", () => {
    const storeDir = tempStore();
    // Over the token gate, but official TextCrusher is a no-op on one
    // repetitive ASCII segment, so wrapping a locator would not help.
    const compactLog = `note ${"n".repeat(1200)}`;
    const messages = withProtectedTail([
      { role: "tool" as const, content: compactLog, toolName: "bash" },
    ]);

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("crushes a large JSON array to a shortened list plus a locator", () => {
    const storeDir = tempStore();
    const items = Array.from({ length: 80 }, (_, index) => ({
      id: index,
      name: `record-${index}`,
      status: index === 79 ? "error" : "ok",
      detail: `payload field for record ${index} with extra padding text`,
    }));
    const payload = JSON.stringify(items, null, 2);
    const messages = withProtectedTail([
      { role: "tool" as const, content: payload, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });
    const crushed = compressed[0]?.content ?? "";

    expect(compressed[0]?.compressed).toBe(true);
    expect(crushed.length).toBeLessThan(payload.length);
    expect(crushed).toMatch(/80/);
    expect(crushed).toMatch(/record-0/);
    expect(crushed).toMatch(/record-79/);
    expect(crushed).not.toMatch(/record-40/);
    expect(crushed).toMatch(/<<compressor:[0-9a-f]{64}>>/);
    expect(crushed).toContain(RETRIEVE_HINT);
    expect(retrieve(crushed, { storeDir })).toBe(payload);
  });

  it("collapses obvious duplicate items in a JSON array crush", () => {
    const storeDir = tempStore();
    const duplicate = {
      status: "ok",
      code: 200,
      detail: "repeated health-check payload with extra padding text",
    };
    const items = [
      ...Array.from({ length: 70 }, () => duplicate),
      { status: "error", code: 500, detail: "final unique failure payload" },
    ];
    const payload = JSON.stringify(items, null, 2);
    const messages = withProtectedTail([
      { role: "tool" as const, content: payload, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });
    const crushed = compressed[0]?.content ?? "";

    expect(compressed[0]?.compressed).toBe(true);
    expect(crushed.length).toBeLessThan(payload.length);
    expect(crushed).toMatch(/200/);
    expect(crushed).toMatch(/500/);
    expect(crushed).toMatch(/<<compressor:[0-9a-f]{64}>>/);
    expect(retrieve(crushed, { storeDir })).toBe(payload);
  });

  it("crushes a structured list of similar lines plus a locator", () => {
    const storeDir = tempStore();
    const lines = Array.from(
      { length: 80 },
      (_, index) =>
        `- file src/module-${index}.ts size=${1000 + index} hash=abc${index}`,
    );
    const payload = lines.join("\n");
    const messages = withProtectedTail([
      { role: "tool" as const, content: payload, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });
    const crushed = compressed[0]?.content ?? "";

    expect(compressed[0]?.compressed).toBe(true);
    expect(crushed.length).toBeLessThan(payload.length);
    expect(crushed).toMatch(/module-79/);
    expect(crushed).toMatch(/<<compressor:[0-9a-f]{64}>>/);
    expect(crushed).toContain(RETRIEVE_HINT);
    expect(retrieve(crushed, { storeDir })).toBe(payload);
  });

  it("crushes a long log to a readable extract plus a locator", () => {
    const storeDir = tempStore();
    const logLines = ["===== test session starts ====="];
    for (let i = 0; i < 300; i++) {
      logLines.push(`INFO compiling unit ${i} ok`);
    }
    for (let i = 0; i < 15; i++) {
      logLines.push("FAIL compilation unit failed with diagnostics");
    }
    logLines.push("ERROR cannot find symbol Foo");
    logLines.push("INFO compiling leftover unit ok");
    logLines.push("===== 1 failed, 80 passed =====");
    const log = logLines.join("\n");
    const messages = withProtectedTail([
      { role: "tool" as const, content: log, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });
    const crushed = compressed[0]?.content ?? "";

    expect(compressed[0]?.compressed).toBe(true);
    expect(crushed.length).toBeLessThan(log.length);
    expect(crushed).toMatch(/FAIL compilation unit failed with diagnostics/);
    expect(crushed).toMatch(/ERROR cannot find symbol Foo/);
    expect(crushed).toMatch(/===== 1 failed, 80 passed =====/);
    expect(crushed).toMatch(/<<compressor:[0-9a-f]{64}>>/);
    expect(crushed).toContain(RETRIEVE_HINT);
    expect(retrieve(crushed, { storeDir })).toBe(log);
  });

  it("still applies skip policy to a large JSON array", () => {
    const storeDir = tempStore();
    const items = Array.from({ length: 80 }, (_, index) => ({
      id: index,
      name: `record-${index}`,
      detail: `payload field for record ${index} with extra padding text`,
    }));
    const payload = JSON.stringify(items, null, 2);
    const messages = [
      { role: "user" as const, content: payload },
      { role: "tool" as const, content: payload, toolName: "Read" },
      { role: "tool" as const, content: payload, toolName: "bash" },
      { role: "assistant" as const, content: payload },
      { role: "system" as const, content: payload },
      { role: "tool" as const, content: payload, toolName: "bash" },
    ];

    const compressed = compressConversation(messages, { storeDir });

    expect(compressed[0]).toEqual(messages[0]);
    expect(compressed[1]).toEqual(messages[1]);
    expect(compressed[2]?.compressed).toBe(true);
    expect(compressed[2]?.content.length).toBeLessThan(payload.length);
    expect(compressed[3]).toEqual(messages[3]);
    expect(compressed[4]).toEqual(messages[4]);
    expect(compressed[5]?.compressed).toBe(true);
    expect(compressed[5]?.content.length).toBeLessThan(payload.length);
    expect(retrieve(compressed[2]?.content, { storeDir })).toBe(payload);
    expect(retrieve(compressed[5]?.content, { storeDir })).toBe(payload);
  });

  it("crushes a long log in the last four messages", () => {
    const storeDir = tempStore();
    const messages = [
      { role: "tool" as const, content: LONG_ORIGINAL, toolName: "bash" },
      { role: "assistant" as const, content: "tail-1" },
      { role: "system" as const, content: "tail-2" },
      { role: "tool" as const, content: "ok", toolName: "bash" },
    ];

    const compressed = compressConversation(messages, { storeDir });

    expect(compressed[0]?.compressed).toBe(true);
    expect(compressed[0]?.content).toContain(LONG_LOCATOR);
    expect(compressed[0]?.content.length).toBeLessThan(LONG_ORIGINAL.length);
    expect(compressed[1]).toEqual(messages[1]);
    expect(compressed[2]).toEqual(messages[2]);
    expect(compressed[3]).toEqual(messages[3]);
    expect(retrieve(compressed[0]?.content, { storeDir })).toBe(LONG_ORIGINAL);
  });

  it("leaves source code in the last four messages verbatim", () => {
    const storeDir = tempStore();
    const payload = sourceCodeBlob();
    const messages = [
      { role: "tool" as const, content: payload, toolName: "bash" },
      { role: "assistant" as const, content: "tail-1" },
      { role: "assistant" as const, content: "tail-2" },
      { role: "assistant" as const, content: "tail-3" },
    ];

    expect(compressConversation(messages, { storeDir })).toEqual(messages);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("crushes long CJK prose to an extractive keep plus a locator", () => {
    const storeDir = tempStore();
    const filler = Array.from(
      { length: 24 },
      (_, index) =>
        `第${index}号监控服务器的日志显示子系统今天运行平稳没有出现异常。`,
    ).join("");
    const needle =
      "认证令牌的缓存采用最近最少使用淘汰算法。" +
      "parseConfig 在端口 8080 请求 https://example.com/auth 时返回 ERROR。" +
      "详见《认证令牌规范》。";
    const payload = `${filler.slice(0, filler.length / 2)}${needle}${filler.slice(filler.length / 2)}`;
    const messages = withProtectedTail([
      { role: "tool" as const, content: payload, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });
    const crushed = compressed[0]?.content ?? "";

    expect(compressed[0]?.compressed).toBe(true);
    expect(crushed.length).toBeLessThan(payload.length);
    expect(crushed).toMatch(/8080/);
    expect(crushed).toMatch(/parseConfig/);
    expect(crushed).toMatch(/https:\/\/example\.com\/auth/);
    expect(crushed).toMatch(/ERROR/);
    expect(crushed).toMatch(/认证令牌规范/);
    expect(crushed).toMatch(/<<compressor:[0-9a-f]{64}>>/);
    expect(crushed).toContain(RETRIEVE_HINT);
    expect(retrieve(crushed, { storeDir })).toBe(payload);
  });

  it("crushes long Korean with sub-eojeol keep, not CJK-char or English-word split", () => {
    const storeDir = tempStore();
    const filler = Array.from(
      { length: 24 },
      (_, index) =>
        `${index}번 모니터링 서버의 로그에는 데이터 베이스 하위 시스템이 오늘도 정상 작동했다고 기록되어 있다。`,
    ).join("");
    const needle =
      "인증 토큰 캐시는 최근 최소 사용 알고리즘으로 관리된다。" +
      "포트 8080 의 parseConfig 가 https://example.com/auth 에서 ERROR 를 반환한다。" +
      "데이터베이스연결정보는 「최근최소사용」 규격을 따른다。";
    const payload = `${filler.slice(0, filler.length / 2)}${needle}${filler.slice(filler.length / 2)}`;
    const messages = withProtectedTail([
      { role: "tool" as const, content: payload, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });
    const crushed = compressed[0]?.content ?? "";

    expect(compressed[0]?.compressed).toBe(true);
    expect(crushed.length).toBeLessThan(payload.length);
    expect(crushed).toContain("데이터베이스");
    expect(crushed).toMatch(/최근최소사용|최근 최소 사용/);
    expect(crushed).not.toContain("데 이 터 베 이 스");
    expect(crushed).toMatch(/8080/);
    expect(crushed).toMatch(/parseConfig/);
    expect(crushed).toMatch(/ERROR/);
    expect(crushed).toMatch(/[\uac00-\ud7a3]{2,}/);
    expect(crushed).toMatch(/<<compressor:[0-9a-f]{64}>>/);
    expect(crushed).toContain(RETRIEVE_HINT);
    expect(retrieve(crushed, { storeDir })).toBe(payload);
  });

  it("does not enable code-aware compression or Kompress", () => {
    const storeDir = tempStore();
    const payload = sourceCodeBlob();
    const messages = withProtectedTail([
      { role: "tool" as const, content: payload, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });

    expect(compressed[0]?.compressed).toBeUndefined();
    expect(compressed[0]?.content).toBe(payload);
    expect(readdirSync(storeDir)).toEqual([]);
  });

  it("crushes mixed log, structured list, and CJK sections with matching styles", () => {
    const storeDir = tempStore();
    const payload = mixedLogListCjk();
    const messages = withProtectedTail([
      { role: "tool" as const, content: payload, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });
    const crushed = compressed[0]?.content ?? "";

    expect(compressed[0]?.compressed).toBe(true);
    expect(crushed.length).toBeLessThan(payload.length);
    expect(crushed).toMatch(/FAIL compilation unit failed with diagnostics/);
    expect(crushed).toMatch(/ERROR cannot find symbol Foo/);
    expect(crushed).toMatch(/===== 1 failed, 80 passed =====/);
    expect(crushed).toMatch(/<<compressor:[0-9a-f]{64}>>/);
    expect(crushed).toContain(RETRIEVE_HINT);
    expect(crushed.match(/<<compressor:[0-9a-f]{64}>>/g)).toHaveLength(1);
    expect(retrieve(crushed, { storeDir })).toBe(payload);
    expect(readdirSync(storeDir)).toHaveLength(1);
  });

  it("still applies skip policy to mixed log, list, and CJK content", () => {
    const storeDir = tempStore();
    const payload = mixedLogListCjk();
    const messages = [
      { role: "user" as const, content: payload },
      { role: "tool" as const, content: payload, toolName: "Read" },
      { role: "tool" as const, content: payload, toolName: "bash" },
      { role: "assistant" as const, content: payload },
      { role: "system" as const, content: payload },
      { role: "tool" as const, content: payload, toolName: "bash" },
    ];

    const compressed = compressConversation(messages, { storeDir });

    expect(compressed[0]).toEqual(messages[0]);
    expect(compressed[1]).toEqual(messages[1]);
    expect(compressed[2]?.compressed).toBe(true);
    expect(compressed[2]?.content.length).toBeLessThan(payload.length);
    expect(compressed[3]).toEqual(messages[3]);
    expect(compressed[4]).toEqual(messages[4]);
    expect(compressed[5]?.compressed).toBe(true);
    expect(compressed[5]?.content.length).toBeLessThan(payload.length);
    expect(retrieve(compressed[2]?.content, { storeDir })).toBe(payload);
    expect(readdirSync(storeDir)).toHaveLength(1);
  });

  it("crushes mixed sections independently and restores the whole original", () => {
    const storeDir = tempStore();
    const payload = officialMixedPayload();
    const messages = withProtectedTail([
      { role: "tool" as const, content: payload, toolName: "bash" },
    ]);

    const compressed = compressConversation(messages, { storeDir });
    const crushed = compressed[0]?.content ?? "";

    expect(compressed[0]?.compressed).toBe(true);
    expect(crushed.length).toBeLessThan(payload.length);
    expect(crushed).toContain("```python");
    expect(crushed).toContain("def unique_marker_function():");
    expect(crushed).toContain("keep-this-code-verbatim-xyz");
    expect(crushed).toMatch(/record-0/);
    expect(crushed).toMatch(/record-79/);
    expect(crushed).not.toMatch(/record-40/);
    expect(crushed).toMatch(/hit-0/);
    expect(crushed).toMatch(/hit-79/);
    expect(crushed).not.toMatch(/hit-40/);
    expect(crushed).toMatch(/<<compressor:[0-9a-f]{64}>>/);
    expect(crushed).toContain(RETRIEVE_HINT);
    expect(crushed.match(/<<compressor:[0-9a-f]{64}>>/g)).toHaveLength(1);
    expect(retrieve(crushed, { storeDir })).toBe(payload);
    expect(readdirSync(storeDir)).toHaveLength(1);
  });
});
