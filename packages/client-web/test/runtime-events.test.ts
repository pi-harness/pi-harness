import { describe, expect, test } from "vitest";
import { compactThinkingEvents } from "../src/runtime-events.js";

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
