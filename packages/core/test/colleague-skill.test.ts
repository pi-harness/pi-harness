import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";
import { createColleagueHandoff } from "../src/plugins/colleague-skill.js";
import colleagueSkillPlugin from "../src/plugins/colleague-skill.js";

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
