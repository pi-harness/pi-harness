import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import { createPromptTemplate } from "../src/index.js";
import promptLibraryPlugin from "../src/index.js";

describe("prompt library", () => {
  test("normalizes a bounded prompt template", () => {
    expect(
      createPromptTemplate({ title: "  Review API  ", prompt: "  Check error handling.  ", tags: ["api", "review"] }, "prompt-1", "2026-09-03T00:00:00.000Z"),
    ).toEqual({
      id: "prompt-1",
      title: "Review API",
      prompt: "Check error handling.",
      tags: ["api", "review"],
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
  });

  test("rejects empty or oversized templates", () => {
    expect(() => createPromptTemplate({ title: " ", prompt: "x" }, "prompt-1", "2026-09-03T00:00:00.000Z")).toThrow("title");
    expect(() => createPromptTemplate({ title: "x", prompt: "x".repeat(8_001) }, "prompt-1", "2026-09-03T00:00:00.000Z")).toThrow("8,000");
  });

  test("persists templates through the registered tool and panel", async () => {
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    const entries: unknown[] = [];
    context.provide("piSession", {
      manager: {
        getEntries: () => entries,
        appendCustomEntry: (_type: string, data: unknown) => entries.push({ type: "custom", customType: "pi-harness/prompt-library", data }),
      },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(promptLibraryPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "prompt_library");
      expect(tool).toBeDefined();
      await expect(
        tool!.execute("call-1", { action: "save", title: "Review", prompt: "Review this diff", tags: ["code"] }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({
        details: { templates: [{ title: "Review", prompt: "Review this diff" }] },
      });
      await expect(tool!.execute("call-2", { action: "list", query: "review" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { templates: [{ title: "Review" }] },
      });
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "prompt-library-panel", data: { total: 1 } }]);
    } finally {
      await context.fiber.dispose();
    }
  });
});
