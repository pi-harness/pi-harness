import { describe, expect, test } from "vitest";
import { createColleagueHandoff } from "../src/plugins/colleague-skill.js";

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
});
