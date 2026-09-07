import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import { createColleagueHandoff } from "../src/index.js";
import colleagueSkillPlugin from "../src/index.js";

async function createHarness(entries: unknown[] = []): Promise<{
  context: Context;
  entries: unknown[];
  panels: PiPluginUiRegistry;
  tool: ReturnType<PiToolRegistry["snapshot"]>["customTools"][number];
  tools: PiToolRegistry;
}> {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piSession", {
    manager: {
      getEntries: () => entries,
      appendCustomEntry: (_type: string, data: unknown) => entries.push({ type: "custom", customType: "pi-harness/colleague-handoff", data }),
    },
  } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(colleagueSkillPlugin);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "colleague_handoff");
  if (tool === undefined) throw new Error("colleague_handoff was not registered");
  return { context, entries, panels, tool, tools };
}

describe("colleague skill", () => {
  test("normalizes a bounded handoff packet for another role", () => {
    expect(
      createColleagueHandoff(
        {
          toRole: "reviewer",
          objective: "检查 API 错误处理",
          context: "最近增加了 SSE 重连逻辑。",
          constraints: ["不改公开接口"],
          files: ["packages/api-gateway/src/index.ts"],
          acceptance: ["补充回归测试", "说明失败原因"],
        },
        "handoff-1",
        "2026-09-03T00:00:00.000Z",
      ),
    ).toEqual({
      id: "handoff-1",
      toRole: "reviewer",
      objective: "检查 API 错误处理",
      context: "最近增加了 SSE 重连逻辑。",
      constraints: ["不改公开接口"],
      files: ["packages/api-gateway/src/index.ts"],
      acceptance: ["补充回归测试", "说明失败原因"],
      createdAt: "2026-09-03T00:00:00.000Z",
    });
  });

  test("rejects empty objectives and oversized packets", () => {
    expect(() => createColleagueHandoff({ toRole: "reviewer", objective: " " }, "handoff-1", "2026-09-03T00:00:00.000Z")).toThrow("objective");
    expect(() =>
      createColleagueHandoff(
        { toRole: "reviewer", objective: "x", files: Array.from({ length: 21 }, (_, index) => `file-${index}`) },
        "handoff-1",
        "2026-09-03T00:00:00.000Z",
      ),
    ).toThrow("files must contain 20 items");
  });

  test("accepts every exact handoff boundary", () => {
    const handoff = createColleagueHandoff(
      {
        toRole: "r".repeat(128),
        objective: "o".repeat(4_000),
        context: "c".repeat(4_000),
        constraints: Array.from({ length: 20 }, () => "x".repeat(1_000)),
        files: Array.from({ length: 20 }, () => "f".repeat(4_096)),
        acceptance: Array.from({ length: 20 }, () => "a".repeat(1_000)),
      },
      "handoff-boundary",
      "2026-09-03T00:00:00.000Z",
    );
    expect(handoff.toRole).toHaveLength(128);
    expect(handoff.objective).toHaveLength(4_000);
    expect(handoff.context).toHaveLength(4_000);
    expect(handoff.constraints).toHaveLength(20);
    expect(handoff.constraints[0]).toHaveLength(1_000);
    expect(handoff.files[0]).toHaveLength(4_096);
    expect(handoff.acceptance[0]).toHaveLength(1_000);
  });

  test("declares complete packet bounds in the tool schema", async () => {
    const fixture = await createHarness();
    try {
      expect(fixture.tool.parameters).toMatchObject({
        properties: {
          toRole: { type: "string", minLength: 1, maxLength: 128 },
          objective: { type: "string", minLength: 1, maxLength: 4_000 },
          context: { type: "string", maxLength: 4_000 },
          constraints: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1_000 } },
          files: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 4_096 } },
          acceptance: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1_000 } },
        },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects malformed packet fields before writing session state", async () => {
    const fixture = await createHarness();
    const invalid: unknown[] = [
      null,
      { toRole: 7, objective: "valid" },
      { toRole: " ", objective: "valid" },
      { toRole: "r".repeat(129), objective: "valid" },
      { toRole: "reviewer", objective: 7 },
      { toRole: "reviewer", objective: "o".repeat(4_001) },
      { toRole: "reviewer", objective: "valid", context: 7 },
      { toRole: "reviewer", objective: "valid", constraints: null },
      { toRole: "reviewer", objective: "valid", constraints: [7] },
      { toRole: "reviewer", objective: "valid", constraints: [" "] },
      { toRole: "reviewer", objective: "valid", constraints: ["x".repeat(1_001)] },
      { toRole: "reviewer", objective: "valid", files: ["x".repeat(4_097)] },
      { toRole: "reviewer", objective: "valid", acceptance: Array.from({ length: 21 }, () => "done") },
    ];
    try {
      for (const params of invalid) {
        await expect(fixture.tool.execute("invalid", params, undefined, undefined, {} as never)).rejects.toThrow(
          /handoff|role|objective|context|constraints|files|acceptance/iu,
        );
      }
      expect(fixture.entries).toEqual([]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("creates unique IDs even when the clock does not advance", async () => {
    const fixture = await createHarness();
    const originalNow = Date.now;
    Date.now = () => 1_000;
    try {
      const first = await fixture.tool.execute("first", { toRole: "reviewer", objective: "First" }, undefined, undefined, {} as never);
      const second = await fixture.tool.execute("second", { toRole: "reviewer", objective: "Second" }, undefined, undefined, {} as never);
      expect((first.details as { id: string }).id).not.toBe((second.details as { id: string }).id);
    } finally {
      Date.now = originalNow;
      await fixture.context.fiber.dispose();
    }
  });

  test("skips malformed persisted records and isolates durable state", async () => {
    const persisted = {
      id: "handoff-valid",
      toRole: "reviewer",
      objective: "Review the change",
      context: "Context",
      constraints: ["No API changes"],
      files: ["src/index.ts"],
      acceptance: ["Tests pass"],
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    const entries: unknown[] = [
      { type: "custom", customType: "pi-harness/colleague-handoff", data: persisted },
      { type: "custom", customType: "pi-harness/colleague-handoff", data: { id: 7 } },
    ];
    const fixture = await createHarness(entries);
    try {
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { latest: { id: "handoff-valid" } } }]);
      const result = await fixture.tool.execute(
        "create",
        { toRole: "frontend", objective: "Implement UI", files: ["src/view.tsx"] },
        undefined,
        undefined,
        {} as never,
      );
      (result.details as { files: string[] }).files[0] = "mutated";
      const appended = entries.at(-1) as { data: { files: string[] } };
      expect(appended.data.files).toEqual(["src/view.tsx"]);
      const [firstPanel] = await fixture.panels.snapshot();
      const latest = (firstPanel?.data as { latest: { files: string[] } }).latest;
      expect(latest.files).toEqual(["src/view.tsx"]);
      latest.files[0] = "panel-mutated";
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { latest: { files: ["src/view.tsx"] } } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("honors cancellation and invalidates retained tools on disposal", async () => {
    const fixture = await createHarness();
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled handoff"));
    try {
      await expect(
        fixture.tool.execute("cancel", { toRole: "reviewer", objective: "Do not persist" }, controller.signal, undefined, {} as never),
      ).rejects.toThrow(/caller cancelled handoff/iu);
      expect(fixture.entries).toEqual([]);
      const retained = fixture.tool;
      await fixture.context.fiber.dispose();
      expect(fixture.tools.snapshot().customTools).toEqual([]);
      await expect(fixture.panels.snapshot()).resolves.toEqual([]);
      await expect(retained.execute("stale", { toRole: "reviewer", objective: "Do not persist" }, undefined, undefined, {} as never)).rejects.toThrow(
        /disposed/iu,
      );
      expect(fixture.entries).toEqual([]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("persists a handoff through the registered Pi tool and panel", async () => {
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    const entries: unknown[] = [];
    context.provide("piSession", {
      manager: {
        getEntries: () => entries,
        appendCustomEntry: (_type: string, data: unknown) => entries.push({ type: "custom", customType: "pi-harness/colleague-handoff", data }),
      },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(colleagueSkillPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "colleague_handoff");
      expect(tool).toBeDefined();
      await expect(
        tool!.execute("call-1", { toRole: "reviewer", objective: "检查变更", files: ["src/index.ts"] }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({
        details: { toRole: "reviewer", objective: "检查变更", files: ["src/index.ts"] },
      });
      await expect(panels.snapshot()).resolves.toMatchObject([
        { id: "colleague-skill-panel", data: { latest: { toRole: "reviewer", objective: "检查变更" } } },
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });
});
