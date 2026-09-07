import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import themeStudioPlugin, { themePresets } from "../src/index.js";

describe("theme studio", () => {
  test("exposes bounded presets and persists the selected theme", async () => {
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    const entries: unknown[] = [];
    context.provide("piSession", {
      manager: {
        getEntries: () => entries,
        appendCustomEntry: (_type: string, data: unknown) => entries.push({ type: "custom", customType: "pi-harness/theme-studio", data }),
      },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(themeStudioPlugin, {});
      expect(Object.keys(themePresets)).toEqual(["light", "midnight", "paper", "high-contrast"]);
      const set = tools.snapshot().customTools.find((tool) => tool.name === "theme_set");
      const status = tools.snapshot().customTools.find((tool) => tool.name === "theme_status");
      expect(set).toBeDefined();
      expect(status).toBeDefined();
      await expect(set!.execute("set-1", { theme: "midnight" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { theme: "midnight", tokens: { "--color-ink": "#f8fafc" } },
      });
      await expect(status!.execute("status-1", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { theme: "midnight", tokens: { "--color-blue": "#8ab4ff" } },
      });
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "theme-studio-panel", data: { theme: "midnight", changed: true } }]);
      expect(entries).toHaveLength(1);
    } finally {
      await context.fiber.dispose();
    }
  });
});
