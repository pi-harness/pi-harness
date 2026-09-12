import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test, vi } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import { createPromptTemplate, type PromptTemplate } from "../src/index.js";
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
  test("retrieves a single complete prompt for the model without changing the journal", async () => {
    const f = await fixture();
    try {
      const saved = await f.call({ action: "save", title: "Review", prompt: "Review every changed branch.\nInclude tests.", tags: ["code"] });
      const selected = (saved.details as { selected: { id: string; prompt: string } }).selected;
      await f.call({ action: "save", title: "Other", prompt: "Unrelated template body" });
      const entries = structuredClone(f.entries());
      const result = await f.call({ action: "get", id: selected.id });
      expect(result.content).toEqual([{ type: "text", text: selected.prompt }]);
      expect(result.details).toMatchObject({ selected, templates: [{ id: selected.id }] });
      expect((result.details as { templates: unknown[] }).templates).toHaveLength(1);
      expect(f.entries()).toEqual(entries);
      (result.details as { selected: { prompt: string } }).selected.prompt = "mutated";
      expect((await f.call({ action: "get", id: selected.id })).content).toEqual([{ type: "text", text: selected.prompt }]);
    } finally {
      await f.context.fiber.dispose();
    }
  });

  test("validates get IDs and isolates retrieval across sessions", async () => {
    const f = await fixture();
    try {
      await expect(f.call({ action: "get" })).rejects.toThrow("id is required");
      await expect(f.call({ action: "get", id: "missing" })).rejects.toThrow("Prompt was not found");
      await expect(f.call({ action: "get", id: "missing", query: "x" })).rejects.toThrow("Unknown property");
      const saved = await f.call({ action: "save", title: "Private", prompt: "Session scoped" });
      const id = (saved.details as { selected: { id: string } }).selected.id;
      f.switchSession();
      await expect(f.call({ action: "get", id })).rejects.toThrow("Prompt was not found");
      expect(f.entries()).toHaveLength(0);
    } finally {
      await f.context.fiber.dispose();
    }
  });

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
  test("bounds the panel to the twelve most recently mutated templates", async () => {
    const f = await fixture();
    try {
      let firstId = "";
      for (let index = 1; index <= 15; index += 1) {
        const saved = await f.call({ action: "save", title: `Tenant ${index}`, prompt: `Operations playbook ${index}` });
        if (index === 1) firstId = (saved.details as { selected: { id: string } }).selected.id;
      }
      expect((await f.panels.snapshot())[0]?.data).toMatchObject({
        total: 15,
        shown: 12,
        truncated: true,
        templates: Array.from({ length: 12 }, (_, index) => ({ title: `Tenant ${15 - index}` })),
      });

      await f.call({ action: "save", id: firstId, title: "Tenant 1 updated" });
      expect(((await f.panels.snapshot())[0]?.data as { templates: PromptTemplate[] }).templates[0]).toMatchObject({
        id: firstId,
        title: "Tenant 1 updated",
      });
    } finally {
      await f.context.fiber.dispose();
    }
  });
  test("includes legacy in-place updates in the newest panel inventory", async () => {
    const f = await fixture();
    try {
      const templates = Array.from({ length: 15 }, (_, index): PromptTemplate => ({
        id: `prompt-${index + 1}`,
        title: `Legacy ${index + 1}`,
        prompt: `Legacy playbook ${index + 1}`,
        tags: [],
        createdAt: `2026-09-12T02:00:${String(index).padStart(2, "0")}.000Z`,
        updatedAt: index === 0 ? "2026-09-12T03:00:00.000Z" : `2026-09-12T02:00:${String(index).padStart(2, "0")}.000Z`,
      }));
      f.entries().push({ type: "custom", customType: "pi-harness/prompt-library", data: { templates } });

      expect(((await f.panels.snapshot())[0]?.data as { templates: PromptTemplate[] }).templates[0]).toMatchObject({ id: "prompt-1" });
    } finally {
      await f.context.fiber.dispose();
    }
  });
  test("keeps updates readable when the wall clock moves backward", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-12T03:00:00.000Z"));
      const saved = await f.call({ action: "save", title: "Tenant", prompt: "Initial playbook" });
      const selected = (saved.details as { selected: PromptTemplate }).selected;
      vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
      const updated = await f.call({ action: "save", id: selected.id, prompt: "Updated playbook" });
      const updatedTemplate = (updated.details as { selected: PromptTemplate }).selected;

      expect(Date.parse(updatedTemplate.updatedAt)).toBe(Date.parse(selected.updatedAt) + 1);
      await expect(f.call({ action: "get", id: selected.id })).resolves.toMatchObject({ content: [{ text: "Updated playbook" }] });
    } finally {
      vi.useRealTimers();
      await f.context.fiber.dispose();
    }
  });
  test("advances frozen timestamps across expanded years and rejects exhaustion", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("9999-12-31T23:59:59.999Z"));
      const first = (await f.call({ action: "save", title: "First", prompt: "First" })).details as { selected: PromptTemplate };
      const second = (await f.call({ action: "save", title: "Second", prompt: "Second" })).details as { selected: PromptTemplate };
      expect(first.selected.updatedAt).toBe("9999-12-31T23:59:59.999Z");
      expect(second.selected.updatedAt).toBe("+010000-01-01T00:00:00.000Z");

      f.switchSession();
      f.entries().push({
        type: "custom",
        customType: "pi-harness/prompt-library",
        data: {
          templates: [
            {
              id: "prompt-max",
              title: "Maximum",
              prompt: "Maximum",
              tags: [],
              createdAt: "+275760-09-13T00:00:00.000Z",
              updatedAt: "+275760-09-13T00:00:00.000Z",
            },
          ],
        },
      });
      await expect(f.call({ action: "save", title: "Overflow", prompt: "Overflow" })).rejects.toThrow(/timestamp sequence is exhausted/i);
      expect(f.entries()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await f.context.fiber.dispose();
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
  test("rejects journal timestamps that move backward", async () => {
    const f = await fixture();
    try {
      f.entries().push({
        type: "custom",
        customType: "pi-harness/prompt-library",
        data: {
          templates: [
            {
              id: "prompt-1",
              title: "Refund review",
              prompt: "Review the refund",
              tags: [],
              createdAt: "2026-09-12T03:00:01.000Z",
              updatedAt: "2026-09-12T03:00:00.000Z",
            },
          ],
        },
      });
      await expect(f.call({ action: "list" })).rejects.toThrow(/timestamp/i);
      expect(f.entries()).toHaveLength(1);
    } finally {
      await f.context.fiber.dispose();
    }
  });
  test("rejects sparse, accessor, extra-property, and proxied journal inventories without invoking getters or proxy traps", async () => {
    const f = await fixture();
    try {
      let getterCalls = 0;
      let proxyCalls = 0;
      const valid = {
        id: "prompt-1",
        title: "Refund review",
        prompt: "Review the refund",
        tags: [],
        createdAt: "2026-09-12T03:00:00.000Z",
        updatedAt: "2026-09-12T03:00:00.000Z",
      };
      const accessor: unknown[] = [];
      Object.defineProperty(accessor, "0", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return valid;
        },
      });
      const sparse = new Array<unknown>(1);
      const extra = [valid] as unknown[] & { extra?: boolean };
      extra.extra = true;
      const proxy = new Proxy([valid], {
        get() {
          proxyCalls += 1;
          return undefined;
        },
      });
      for (const templates of [accessor, sparse, extra, proxy]) {
        f.switchSession();
        f.entries().push({ type: "custom", customType: "pi-harness/prompt-library", data: { templates } });
        await expect(f.call({ action: "list" })).rejects.toThrow(/inventory/i);
      }
      expect(getterCalls).toBe(0);
      expect(proxyCalls).toBe(0);
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

test("follows the native manager while the launch service stays unchanged and rejects pending session switches", async () => {
  const context = new Context(),
    tools = new PiToolRegistry(),
    panels = new PiPluginUiRegistry();
  const launch = SessionManager.inMemory("/launch"),
    active = SessionManager.inMemory("/active");
  const runtime = { session: { sessionManager: launch } };
  context.provide("piSession", { manager: launch });
  context.provide("piRuntime", runtime as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  try {
    await context.plugin(promptLibraryPlugin);
    const tool = tools.snapshot().customTools[0]!;
    const call = (params: unknown) => tool.execute("native", params, undefined, undefined, {} as never);
    await call({ action: "save", title: "launch", prompt: "launch body" });
    const launchEntries = structuredClone(launch.getEntries());
    runtime.session.sessionManager = active;
    expect((await panels.snapshot())[0]!.data).toMatchObject({ total: 0, templates: [] });
    await call({ action: "save", title: "active", prompt: "active body" });
    expect((await call({ action: "list" })).details).toMatchObject({ templates: [{ title: "active" }] });
    expect(launch.getEntries()).toEqual(launchEntries);
    const activeEntries = structuredClone(active.getEntries());
    const pending = call({ action: "save", title: "obsolete", prompt: "must not persist" });
    runtime.session.sessionManager = launch;
    await expect(pending).rejects.toThrow(/session changed/);
    expect(active.getEntries()).toEqual(activeEntries);
    expect(launch.getEntries()).toEqual(launchEntries);
    expect((await panels.snapshot())[0]!.data).toMatchObject({ templates: [{ title: "launch" }] });
  } finally {
    await context.fiber.dispose();
  }
});
