import { describe, expect, test } from "vitest";
import { compactThinkingEvents, eventKindLabel } from "../src/runtime-events.js";

describe("runtime event compaction", () => {
  test("merges token-level thinking deltas into one renderable event", () => {
    const events = [
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "先" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "分析" } },
      { type: "tool_execution_start", toolName: "read" },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "再" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "确认" } },
    ];

    expect(compactThinkingEvents(events)).toEqual([
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "先分析" } },
      { type: "tool_execution_start", toolName: "read" },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "再确认" } },
    ]);
  });

  test("keeps non-thinking events and empty deltas unchanged", () => {
    const event = { type: "agent_start" };
    expect(compactThinkingEvents([event, { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }])).toEqual([
      event,
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } },
    ]);
  });
});

describe("runtime event labels", () => {
  test("names every event kind the runtime emits", () => {
    // These three reached the trace as raw snake_case ids while every neighbouring row was Chinese.
    expect(eventKindLabel("tool_execution_update")).toBe("工具进展");
    expect(eventKindLabel("compaction_delta")).toBe("压缩进展");
    expect(eventKindLabel("compaction_cost")).toBe("压缩开销");
  });

  test("falls back to the raw id for an event kind it has not met", () => {
    expect(eventKindLabel("some_future_event")).toBe("some_future_event");
    expect(eventKindLabel(undefined)).toBe("事件");
  });
});
