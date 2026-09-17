import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Trajectory, nextTrajectoryRow, timelineBars } from "../src/react-room.js";

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

describe("trajectory failure state", () => {
  // The transcript had marked both of these failed from the first render; the trace drew them with the same class and the same blue dot as the calls that worked.
  test("marks a failed tool result apart from the successful ones", () => {
    const html = renderTrajectory(
      [
        { type: "tool_execution_end", toolName: "bash", isError: false, durationMs: 44 },
        { type: "tool_execution_end", toolName: "read", isError: true, durationMs: 30 },
      ],
      2,
    );

    expect(html.split("event-row failed").length - 1).toBe(1);
    expect(html.split("event-dot failed").length - 1).toBe(1);
  });

  // A background tint and a red dot are the whole signal a screen reader cannot hear and a colourblind reader cannot see, so the outcome has to be in the row's text.
  test("writes the outcome into the row text rather than only colouring the row", () => {
    const failed = renderTrajectory([{ type: "tool_execution_end", toolName: "read", isError: true, durationMs: 30 }], 1);
    const succeeded = renderTrajectory([{ type: "tool_execution_end", toolName: "bash", isError: false, durationMs: 44 }], 1);

    expect(failed).toContain("失败");
    expect(succeeded).not.toContain("失败");
  });

  test("leaves a row that reports no outcome unmarked", () => {
    const html = renderTrajectory([{ type: "turn_start" }], 1);

    expect(html).not.toContain("failed");
  });
});

describe("trajectory timeline", () => {
  // The strip buckets the flat event list by index and its tooltips name event ranges, so a heading of 按轮次 read as eight turns over a run that had two.
  test("names the strip after what it buckets", () => {
    const html = renderTrajectory([{ type: "turn_start" }, { type: "tool_execution_start", toolName: "bash" }], 2);

    expect(html).toContain("按事件");
    expect(html).not.toContain("按轮次");
  });

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

describe("trajectory row navigation", () => {
  // 1,237 rows for 23 on screen means a keyboard user pays a thousand keystrokes to get past the table, so it is one tab stop with arrows inside it.
  test("moves one row at a time and stops at both ends", () => {
    expect(nextTrajectoryRow("ArrowDown", 0, 5)).toBe(1);
    expect(nextTrajectoryRow("ArrowUp", 3, 5)).toBe(2);
    expect(nextTrajectoryRow("ArrowDown", 4, 5)).toBe(4);
    expect(nextTrajectoryRow("ArrowUp", 0, 5)).toBe(0);
  });

  test("jumps to either end", () => {
    expect(nextTrajectoryRow("Home", 3, 5)).toBe(0);
    expect(nextTrajectoryRow("End", 1, 5)).toBe(4);
  });

  test("leaves every other key to the browser", () => {
    expect(nextTrajectoryRow("Enter", 1, 5)).toBeUndefined();
    expect(nextTrajectoryRow("Tab", 1, 5)).toBeUndefined();
    expect(nextTrajectoryRow(" ", 1, 5)).toBeUndefined();
  });

  test("has nowhere to go in an empty table", () => {
    expect(nextTrajectoryRow("ArrowDown", 0, 0)).toBeUndefined();
    expect(nextTrajectoryRow("Home", 0, 0)).toBeUndefined();
  });

  test("puts exactly one row in the tab order", () => {
    const events = Array.from({ length: 40 }, (_, index) => ({ type: "tool_call", toolName: `tool-${index}` }));
    const html = renderTrajectory(events, 40);

    expect(html.split('tabindex="0"').length - 1).toBe(1);
    expect(html.split('tabindex="-1"').length - 1).toBe(39);
  });
});
