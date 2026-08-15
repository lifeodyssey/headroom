import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("DSH bundle install shape", () => {
  it("declares a cordis patch that inserts dsh-compressor", () => {
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { dsh?: { bundle?: { patch?: string } } };

    expect(pkg.dsh?.bundle?.patch).toBe("./cordis.patch.yml");

    const patch = readFileSync(join(packageRoot, "cordis.patch.yml"), "utf8");
    expect(patch).toMatch(/id: dsh-compressor/);
  });
});
