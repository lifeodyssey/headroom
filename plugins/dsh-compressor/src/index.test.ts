import { describe, expect, it } from "vitest";

import { apply } from "./index.js";

describe("plugin surface", () => {
  it("does not replace official spill or take a Headroom proxy URL", () => {
    const provided: string[] = [];
    const ctx = {
      provide(key: string, _value: unknown) {
        provided.push(key);
      },
    };

    apply(ctx);

    expect(provided).not.toContain("spillStore");
  });
});
