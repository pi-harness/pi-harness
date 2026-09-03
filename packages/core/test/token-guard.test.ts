import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry } from "../src/services.js";
import tokenGuardPlugin from "../src/plugins/token-guard.js";

describe("token guard absolute run budget", () => {
  test("aborts a streaming run when run tokens exceed the configured limit", async () => {
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    let totalTokens = 100;
    let aborts = 0;
    context.provide("piRuntime", {
      session: {
        isStreaming: true,
        getContextUsage: () => ({ tokens: totalTokens, contextWindow: 8_000, percent: (totalTokens / 8_000) * 100 }),
        getSessionStats: () => ({ tokens: { total: totalTokens } }),
      },
      abort: () => {
        aborts += 1;
        return Promise.resolve();
      },
    } as never);
    context.provide("piPluginUi", panels);
    await context.plugin(tokenGuardPlugin, { maxPercent: 100, maxRunTokens: 50 });
    context.emit("pi/session-event", { type: "agent_start" } as never);
    totalTokens = 151;
    context.emit("pi/session-event", { type: "message_update" } as never);
    await expect(panels.snapshot()).resolves.toMatchObject([
      { id: "token-guard-panel", data: { maxRunTokens: 50, runTokens: 51, runExceeded: true, exceeded: true, aborts: 1 } },
    ]);
    expect(aborts).toBe(1);
    await context.fiber.dispose();
  });
});
