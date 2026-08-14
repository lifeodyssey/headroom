import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { nativeFileName } from "./native.js";

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
});
