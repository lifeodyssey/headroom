import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  crushDiff,
  crushLog,
  crushSearch,
  nativeFileName,
} from "./native.js";

const nativeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "native");

describe("native addon loader mapping", () => {
  it("requests the gnu addon on linux-x64", () => {
    expect(nativeFileName("linux", "x64")).toBe(
      "dsh-compressor.linux-x64-gnu.node",
    );
  });

  it("ships the linux-x64-gnu addon in the bundle native directory", () => {
    expect(
      existsSync(join(nativeDir, "dsh-compressor.linux-x64-gnu.node")),
    ).toBe(true);
  });

  it("omits official CCR retrieve lines unless a caller enables CCR", () => {
    const log = Array.from({ length: 305 }, (_, index) =>
      index === 300
        ? "ERROR something broke at step 42"
        : `line ${index}: INFO processing request`,
    ).join("\n");
    const search = Array.from(
      { length: 80 },
      (_, index) => `src/app.py:${index}:print('hit-${index}')`,
    ).join("\n");
    const diff = [
      "diff --git a/src/app.py b/src/app.py",
      "--- a/src/app.py",
      "+++ b/src/app.py",
      "@@ -1,80 +1,80 @@",
      ...Array.from({ length: 80 }, (_, index) => `+print('hit-${index}')`),
    ].join("\n");

    expect(crushLog(log).compressed).not.toMatch(/Retrieve more: hash=/);
    expect(crushSearch(search).compressed).not.toMatch(/Retrieve more: hash=/);
    expect(crushDiff(diff).compressed).not.toMatch(/Retrieve more: hash=/);
    expect(crushLog(log, { enable_ccr: true }).compressed).toMatch(
      /Retrieve more: hash=/,
    );
  });
});
