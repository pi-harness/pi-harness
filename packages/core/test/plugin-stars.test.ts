import { describe, expect, test } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { provideLaunchContext } from "../src/services.js";
import { parsePluginStarsPayload, searchPluginStars } from "../src/plugins/plugin-stars.js";
import pluginStars from "../src/plugins/plugin-stars.js";
import toolsPlugin from "../src/plugins/tools.js";

describe("plugin stars", () => {
  test("normalizes curated ranking data and filters by query", () => {
    const report = parsePluginStarsPayload({
      generatedAt: "2026-09-02T12:00:00Z",
      source: "dsh-plugin-stars",
      plugins: [
        {
          id: "1",
          name: "ModLens",
          fullName: "liustack/modlens",
          description: "Vision bridge",
          htmlUrl: "https://github.com/liustack/modlens",
          stars: 3835,
          topics: ["dsh-plugin", "vision"],
        },
        {
          id: "2",
          name: "Other",
          fullName: "owner/other",
          description: "Task board",
          htmlUrl: "https://github.com/owner/other",
          stars: 281,
          topics: ["taskboard"],
        },
      ],
    });

    expect(searchPluginStars(report, "vision")).toEqual([
      expect.objectContaining({ name: "ModLens", fullName: "liustack/modlens", stars: 3835, topics: ["dsh-plugin", "vision"] }),
    ]);
    expect(report).toMatchObject({ generatedAt: "2026-09-02T12:00:00Z", source: "dsh-plugin-stars" });
  });

  test("drops malformed or non-GitHub entries", () => {
    const report = parsePluginStarsPayload({ plugins: [{ name: "bad", fullName: "bad", htmlUrl: "https://example.com", stars: -1 }, null] });
    expect(report.plugins).toEqual([]);
  });

  test("registers a read-only search tool and panel", async () => {
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/ywsldxk/dsh-plugin-stars/main/data/plugins.json" });
    expect(context.piTools.snapshot().customTools.map((tool) => tool.name)).toContain("plugin_stars_search");
    await expect(context.piPluginUi.snapshot()).resolves.toEqual([expect.objectContaining({ id: "plugin-stars-panel", title: "Plugin Stars" })]);
    await context.fiber.dispose();
  });
});
