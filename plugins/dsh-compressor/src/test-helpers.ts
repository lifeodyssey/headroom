import { afterEach, beforeEach } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";

import { apply } from "./index.js";
import {
  markRetrieveRegistered,
  resetRetrieveRegistered,
} from "./compress.js";

export function enableRetrieveInTests(): void {
  beforeEach(() => {
    markRetrieveRegistered();
  });
  afterEach(() => {
    resetRetrieveRegistered();
  });
}

export function bootOfficialTools(): {
  ctx: Context;
  tools: ToolRuntime;
} {
  const ctx = new Context();
  new SystemPrompt(ctx, { includeHarnessIdentity: false, persona: "" });
  const tools = new ToolRuntime(ctx, { mode: "native" });
  apply(ctx);
  return { ctx, tools };
}
