import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function dsh(home: string, args: string[]): string {
  return execFileSync("npx", ["--yes", "@deepseek-ai/dsh", ...args], {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: home },
    timeout: 120_000,
  });
}

describe("DSH bundle install", () => {
  it("adds the checkout to a profile and shows the layer in dump-config", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-compressor-"));
    homes.push(home);

    dsh(home, ["plugin", "--profile", "probe", "add", packageRoot]);

    const profile = JSON.parse(
      readFileSync(join(home, "profiles", "probe", "package.json"), "utf8"),
    ) as { dsh?: { profile?: { bundles?: string[] } } };

    expect(profile.dsh?.profile?.bundles).toContain("dsh-compressor");

    const dump = dsh(home, ["--profile", "probe", "--dump-config"]);
    expect(dump).toMatch(/# == dsh-compressor\b/);
    expect(dump).toMatch(/id: dsh-compressor/);
  });
});
