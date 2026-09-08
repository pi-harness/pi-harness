import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import { createPromptTemplate } from "../src/index.js";
import promptLibraryPlugin from "../src/index.js";

async function fixture() {
  const context = new Context(),
    tools = new PiToolRegistry(),
    panels = new PiPluginUiRegistry();
  let entries: unknown[] = [];
  let failWrite = false;
  let header = {};
  const session = {
    manager: {
      getHeader: () => header,
      getEntries: () => entries,
      appendCustomEntry: (customType: string, data: unknown) => {
        if (failWrite) {
          entries.push({ type: "custom", customType, data });
          throw new Error("disk full");
        }
        entries.push({ type: "custom", customType, data });
      },
    },
  };
  context.provide("piSession", session as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(promptLibraryPlugin);
  const tool = tools.snapshot().customTools[0]!;
  return {
    context,
    panels,
    tools,
    entries: () => entries,
    switchSession: () => {
      entries = [];
      header = {};
    },
    fail: () => {
      failWrite = true;
    },
    call: (params: unknown, signal?: AbortSignal) => tool.execute("test", params, signal, undefined, {} as never),
  };
}

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
        getHeader: () => entries,
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
  test("isolates returned state and refreshes the panel when the session changes", async () => {
    const f = await fixture();
    try {
      const saved = await f.call({ action: "save", title: "first", prompt: "body" });
      (saved.details as { templates: { title: string }[] }).templates[0]!.title = "changed";
      expect(JSON.stringify(await f.panels.snapshot())).not.toContain("changed");
      f.switchSession();
      expect((await f.panels.snapshot())[0]?.data).toMatchObject({ total: 0 });
    } finally {
      await f.context.fiber.dispose();
    }
  });

  test("rejects invalid parameters, unknown update IDs and cancelled or disposed calls", async () => {
    const f = await fixture();
    try {
      for (const params of [
        { action: "bogus" },
        { action: "list", extra: true },
        { action: "save", title: 1, prompt: "x" },
        { action: "save", id: "missing", title: "x", prompt: "x" },
      ])
        await expect(f.call(params)).rejects.toThrow();
      const controller = new AbortController();
      const pending = f.call({ action: "save", title: "x", prompt: "x" }, controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow(/cancelled/iu);
      expect(f.entries()).toHaveLength(0);
      await f.context.fiber.dispose();
      await expect(f.call({ action: "list" })).rejects.toThrow(/cancelled/iu);
    } finally {
      await f.context.fiber.dispose();
    }
  });

  test("quarantines a failed append and does not silently evict templates", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 100; i++) await f.call({ action: "save", title: String(i), prompt: "body" });
      await expect(f.call({ action: "save", title: "overflow", prompt: "body" })).rejects.toThrow(/100/iu);
      expect(f.entries()).toHaveLength(100);
      const id = ((await f.call({ action: "list" })).details as { templates: { id: string }[] }).templates[0]!.id;
      f.fail();
      await expect(f.call({ action: "delete", id })).rejects.toThrow(/write failed/iu);
      expect((await f.panels.snapshot())[0]?.error).toMatch(/reopen the session/iu);
      await expect(f.call({ action: "list" })).rejects.toThrow(/reopen the session/iu);
      f.switchSession();
      await expect(f.call({ action: "list" })).resolves.toMatchObject({ details: { templates: [] } });
    } finally {
      await f.context.fiber.dispose();
    }
  });
  test("rejects corrupt journals without overwriting them and never invokes parameter getters", async () => {
    const f = await fixture();
    try {
      let accessed = false;
      const params = { action: "save" };
      Object.defineProperty(params, "title", {
        get() {
          accessed = true;
          return "bad";
        },
        enumerable: true,
      });
      await expect(f.call(params)).rejects.toThrow(/data properties/iu);
      expect(accessed).toBe(false);
      f.entries().push({ type: "custom", customType: "pi-harness/prompt-library", data: { templates: [{ id: "broken" }] } });
      await expect(f.call({ action: "save", title: "x", prompt: "x" })).rejects.toThrow();
      expect(f.entries()).toHaveLength(1);
    } finally {
      await f.context.fiber.dispose();
    }
  });
  test("does not write into a session switched after scheduling the call", async () => {
    const f = await fixture();
    try {
      const pending = f.call({ action: "save", title: "old session", prompt: "body" });
      f.switchSession();
      await expect(pending).rejects.toThrow(/session changed/iu);
      expect(f.entries()).toHaveLength(0);
    } finally {
      await f.context.fiber.dispose();
    }
  });
});
