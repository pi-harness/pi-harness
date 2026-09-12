import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Trajectory } from "../src/react-room.js";

function renderTrajectory(events: readonly Record<string, unknown>[], sessionMessages: number): string {
  return renderToStaticMarkup(createElement(Trajectory, { events, sessionMessages, onSelect: () => {} }));
}

describe("trajectory empty state", () => {
  test("explains that a reopened session has no trace instead of looking broken", () => {
    const html = renderTrajectory([], 13);

    expect(html).toContain("轨迹只记录控制台连上之后发生的事件");
    expect(html).toContain("13 条消息");
    expect(html).not.toContain("等待真实事件");
  });

  test("keeps the waiting copy for a session that has not run anything yet", () => {
    const html = renderTrajectory([], 0);

    expect(html).toContain("等待真实事件");
    expect(html).toContain("暂无轨迹事件。");
  });

  test("names the event kinds the runtime emits mid-tool-call", () => {
    const html = renderTrajectory([{ type: "tool_execution_update", toolName: "bash" }], 4);

    expect(html).toContain("工具进展");
    expect(html).not.toContain("暂无轨迹事件");
  });

  test("labels tool events reconstructed from the persisted session log", () => {
    const html = renderTrajectory([{ type: "tool_execution_start", toolName: "bash", historical: true }], 13);

    expect(html).toContain("已从会话日志恢复 1 个历史事件");
  });
});
