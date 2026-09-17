import { describe, expect, test } from "vitest";
import { compactThinkingEvents, eventKindLabel } from "../src/runtime-events.js";

const persistedToolEntries = (id: string, started: string, ended: string) => [
  {
    type: "message",
    timestamp: started,
    message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.md` } }] },
  },
  {
    type: "message",
    timestamp: ended,
    message: { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: id }], isError: false },
  },
];

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

describe("persisted trajectory recovery", () => {
  test("reconstructs historical tool calls and results from session entries", async () => {
    const module = (await import("../src/runtime-events.js")) as unknown as {
      historicalTrajectoryEvents?: (entries: readonly Record<string, unknown>[]) => readonly Record<string, unknown>[];
    };

    expect(module.historicalTrajectoryEvents).toBeTypeOf("function");
    if (!module.historicalTrajectoryEvents) return;

    const events = module.historicalTrajectoryEvents([
      {
        type: "message",
        timestamp: "2026-09-12T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
        },
      },
      {
        type: "message",
        timestamp: "2026-09-12T10:00:03.500Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "/workspace" }],
          details: { exitCode: 0 },
          isError: false,
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "pwd" },
        receivedAt: Date.parse("2026-09-12T10:00:01.000Z"),
        historical: true,
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "/workspace" }], details: { exitCode: 0 } },
        isError: false,
        receivedAt: Date.parse("2026-09-12T10:00:03.500Z"),
        durationMs: 2500,
        historical: true,
      },
    ]);
  });

  // Pi appends a whole parallel batch at one instant on each side, so subtracting the two instants hands every call in the batch the wall time of the slowest one: a 40 ms call reopened as 6.1 s beside the 6.1 s call it ran next to.
  test("refuses to time the individual calls of a parallel batch, and says what the batch took instead", async () => {
    const module = (await import("../src/runtime-events.js")) as unknown as {
      historicalTrajectoryEvents: (entries: readonly Record<string, unknown>[]) => readonly Record<string, unknown>[];
      formatEventDuration: (event: Record<string, unknown>) => string;
      formatEventBatchDuration: (event: Record<string, unknown>) => string | undefined;
    };

    const events = module.historicalTrajectoryEvents([
      {
        type: "message",
        timestamp: "2026-09-17T12:56:21.936Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-slow", name: "bash", arguments: { command: "sleep 6; echo FIRST" } },
            { type: "toolCall", id: "call-fast", name: "bash", arguments: { command: "echo SECOND" } },
          ],
        },
      },
      {
        type: "message",
        timestamp: "2026-09-17T12:56:28.011Z",
        message: { role: "toolResult", toolCallId: "call-slow", toolName: "bash", content: [{ type: "text", text: "FIRST" }], isError: false },
      },
      {
        type: "message",
        timestamp: "2026-09-17T12:56:28.012Z",
        message: { role: "toolResult", toolCallId: "call-fast", toolName: "bash", content: [{ type: "text", text: "SECOND" }], isError: false },
      },
    ]);

    const results = events.filter((event) => event.type === "tool_execution_end");
    expect(results.map((event) => [event.toolCallId, event.durationMs])).toEqual([
      ["call-slow", undefined],
      ["call-fast", undefined],
    ]);
    expect(results.map((event) => module.formatEventDuration(event))).toEqual(["—", "—"]);
    // The one figure the log does prove is how long the batch took, and it is labelled as the batch's rather than as either call's.
    expect(results.map((event) => [module.formatEventBatchDuration(event), event.batchToolCalls])).toEqual([
      ["6.1 s", 2],
      ["6.1 s", 2],
    ]);
  });

  test("keeps timing a call that was alone in its assistant entry", async () => {
    const module = (await import("../src/runtime-events.js")) as unknown as {
      historicalTrajectoryEvents: (entries: readonly Record<string, unknown>[]) => readonly Record<string, unknown>[];
      formatEventBatchDuration: (event: Record<string, unknown>) => string | undefined;
    };

    const events = module.historicalTrajectoryEvents(persistedToolEntries("solo", "2026-09-12T10:00:01.000Z", "2026-09-12T10:00:02.500Z"));

    expect(events.at(-1)).toMatchObject({ toolCallId: "solo", durationMs: 1500 });
    expect(module.formatEventBatchDuration(events.at(-1) ?? {})).toBeUndefined();
  });

  test("keeps prior persisted tools beside live events without duplicating the active run", async () => {
    const module = (await import("../src/runtime-events.js")) as unknown as {
      mergeTrajectoryEvents?: (
        entries: readonly Record<string, unknown>[],
        liveEvents: readonly Record<string, unknown>[],
      ) => readonly Record<string, unknown>[];
    };

    expect(module.mergeTrajectoryEvents).toBeTypeOf("function");
    if (!module.mergeTrajectoryEvents) return;

    const entries = [
      ...persistedToolEntries("prior", "2026-09-12T10:00:01.000Z", "2026-09-12T10:00:02.000Z"),
      ...persistedToolEntries("current", "2026-09-12T10:01:01.000Z", "2026-09-12T10:01:02.000Z"),
    ];
    const liveEvents = [
      { type: "agent_start", receivedAt: Date.parse("2026-09-12T10:01:00.000Z") },
      { type: "tool_execution_start", toolCallId: "current", toolName: "read", receivedAt: Date.parse("2026-09-12T10:01:01.000Z") },
    ];

    const merged = module.mergeTrajectoryEvents(entries, liveEvents);

    expect(merged.map((event) => [event.type, event.toolCallId, event.historical])).toEqual([
      ["tool_execution_start", "prior", true],
      ["tool_execution_end", "prior", true],
      ["agent_start", undefined, undefined],
      ["tool_execution_start", "current", undefined],
    ]);
  });

  test("bounds reconstructed history and marks omitted early events", async () => {
    const module = (await import("../src/runtime-events.js")) as unknown as {
      historicalTrajectoryEvents: (entries: readonly Record<string, unknown>[]) => readonly Record<string, unknown>[];
    };
    const entries = Array.from({ length: 1001 }, (_, index) =>
      persistedToolEntries(
        `call-${index}`,
        new Date(Date.UTC(2026, 8, 12, 10, 0, index * 2)).toISOString(),
        new Date(Date.UTC(2026, 8, 12, 10, 0, index * 2 + 1)).toISOString(),
      ),
    ).flat();

    const events = module.historicalTrajectoryEvents(entries);

    expect(events.length).toBeLessThanOrEqual(2000);
    expect(events[0]).toMatchObject({ type: "historical_events_omitted", historical: true });
    expect(events.at(-1)).toMatchObject({ type: "tool_execution_end", toolCallId: "call-1000" });
  });

  test("keeps the merged historical and live timeline within the rendering bound", async () => {
    const module = (await import("../src/runtime-events.js")) as unknown as {
      mergeTrajectoryEvents: (
        entries: readonly Record<string, unknown>[],
        liveEvents: readonly Record<string, unknown>[],
      ) => readonly Record<string, unknown>[];
    };
    const entries = Array.from({ length: 1001 }, (_, index) =>
      persistedToolEntries(
        `call-${index}`,
        new Date(Date.UTC(2026, 8, 12, 10, 0, index * 2)).toISOString(),
        new Date(Date.UTC(2026, 8, 12, 10, 0, index * 2 + 1)).toISOString(),
      ),
    ).flat();
    const live = [
      { type: "agent_start", receivedAt: Date.parse("2026-09-13T10:00:00.000Z") },
      { type: "turn_start", receivedAt: Date.parse("2026-09-13T10:00:00.001Z") },
    ];

    const events = module.mergeTrajectoryEvents(entries, live);

    expect(events.length).toBeLessThanOrEqual(2000);
    expect(events.slice(-2)).toEqual(live);
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

  test("distinguishes persisted history from live runtime and file data sources", async () => {
    const module = (await import("../src/runtime-events.js")) as unknown as {
      eventDataSource?: (event: Record<string, unknown>) => string;
    };

    expect(module.eventDataSource).toBeTypeOf("function");
    if (!module.eventDataSource) return;
    expect(module.eventDataSource({ type: "tool_execution_start", historical: true })).toBe("Session JSONL · message history");
    expect(module.eventDataSource({ type: "tool_execution_start" })).toBe("Runtime loader · event");
    expect(module.eventDataSource({ type: "file_diff", historical: true })).toBe("Workspace · /api/files");
    expect(module.eventDataSource({ type: "file", source: "/api/workspace/file" })).toBe("Workspace · /api/workspace/file");
  });
});
