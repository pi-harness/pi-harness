import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Trajectory, timelineBars } from "../src/react-room.js";

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

describe("trajectory timeline", () => {
  const events = (count: number) => Array.from({ length: count }, (_, index) => ({ type: "tool_call", toolName: `tool-${index}` }));

  test("gives a short run one bar per event", () => {
    expect(timelineBars(events(5))).toEqual([
      { from: 0, to: 0, count: 1 },
      { from: 1, to: 1, count: 1 },
      { from: 2, to: 2, count: 1 },
      { from: 3, to: 3, count: 1 },
      { from: 4, to: 4, count: 1 },
    ]);
  });

  // 1,311 events laid 9,174px of bars into a 1,272px row with nothing to scroll: the strip showed the first 185 and dropped the rest without saying so.
  test("keeps a long run inside the strip instead of running off the end of it", () => {
    const bars = timelineBars(events(1311));

    expect(bars).toHaveLength(100);
    expect(bars[0]?.from).toBe(0);
    expect(bars.at(-1)?.to).toBe(1310);
  });

  test("covers every event exactly once, with no gap between buckets", () => {
    const bars = timelineBars(events(1311));

    expect(bars.reduce((total, bar) => total + bar.count, 0)).toBe(1311);
    expect(bars.every((bar, index) => index === 0 || bar.from === (bars[index - 1]?.to ?? -1) + 1)).toBe(true);
    expect(bars.every((bar) => bar.count >= 1)).toBe(true);
  });

  test("renders at most one bar per bucket for a run long enough to need them", () => {
    const html = renderTrajectory(events(400), 400);

    expect(html.split("timeline-turn").length - 1).toBe(100);
    expect(html).toContain("400 个事件");
  });

  test("has nothing to draw for an empty run", () => {
    expect(timelineBars([])).toEqual([]);
  });
});
