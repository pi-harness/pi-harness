import { describe, expect, test } from "vitest";
import { contextInsightsPanelView } from "../src/context-insights-view.js";

describe("Context Insights panel view", () => {
  test("fails closed when the snapshot does not carry a valid session ID", () => {
    expect(contextInsightsPanelView({ tokens: 800 })).toMatchObject({ sessionId: "", tokens: null, malformed: true });
  });

  test("fails closed for a snapshot from another active session", () => {
    const view = contextInsightsPanelView(
      {
        sessionId: "previous-session",
        tokens: 800,
        contextWindow: 8_000,
        percent: 10,
        messages: 1,
        scannedMessages: 1,
        events: 3,
        compactions: 1,
        composition: { user: 1, assistant: 0, toolResult: 0, system: 0, other: 0 },
        recentEvents: [{ type: "message_end", at: 1_788_621_601_000 }],
      },
      "active-session",
    );

    expect(view).toMatchObject({ sessionId: "", tokens: null, messages: 0, events: 0, compactions: 0, recentEvents: [], malformed: true });
  });

  test("normalizes a complete bounded context report", () => {
    expect(
      contextInsightsPanelView({
        sessionId: "session-1",
        tokens: 800,
        contextWindow: 8_000,
        percent: 10,
        messages: 5,
        scannedMessages: 5,
        messagesTruncated: false,
        events: 3,
        compactions: 1,
        composition: { user: 2, assistant: 1, toolResult: 1, system: 1, other: 0 },
        recentEvents: [
          { type: "message_start", at: 1_788_621_600_000 },
          { type: "message_end", at: 1_788_621_601_000 },
        ],
      }),
    ).toEqual({
      sessionId: "session-1",
      tokens: 800,
      contextWindow: 8_000,
      percent: 10,
      messages: 5,
      scannedMessages: 5,
      messagesTruncated: false,
      events: 3,
      compactions: 1,
      composition: { user: 2, assistant: 1, toolResult: 1, system: 1, other: 0 },
      recentEvents: [
        { type: "message_end", at: 1_788_621_601_000 },
        { type: "message_start", at: 1_788_621_600_000 },
      ],
      recentEventsTruncated: false,
      limits: { scannedMessages: 10_000, retainedEvents: 50, displayedEvents: 6, eventTypeCharacters: 128 },
      malformed: false,
    });
  });

  test("applies fixed browser bounds to malformed panel data", () => {
    const type = `event\0${"x".repeat(1_000)}`;
    const view = contextInsightsPanelView({
      sessionId: "session-1",
      tokens: -1,
      contextWindow: Number.POSITIVE_INFINITY,
      percent: Number.NaN,
      messages: Number.MAX_SAFE_INTEGER,
      scannedMessages: Number.MAX_SAFE_INTEGER,
      events: -1,
      compactions: 1.5,
      composition: { user: Number.MAX_SAFE_INTEGER },
      recentEvents: Array.from({ length: 100 }, (_, index) => ({ type, at: index === 99 ? Number.MAX_VALUE : index })),
    });

    expect(view).toMatchObject({
      tokens: null,
      contextWindow: null,
      percent: null,
      messages: 0,
      scannedMessages: 0,
      events: 0,
      compactions: 0,
      composition: { user: 0, assistant: 0, toolResult: 0, system: 0, other: 0 },
      recentEventsTruncated: true,
    });
    expect(view.recentEvents).toHaveLength(6);
    expect(view.recentEvents[0]).toMatchObject({ at: null });
    expect(typeof view.recentEvents[0]?.type).toBe("string");
    expect(view.recentEvents[0]?.type).toHaveLength(128);
    expect(view.recentEvents[0]?.type).not.toContain("\0");
  });

  test("preserves over-capacity usage for display", () => {
    expect(contextInsightsPanelView({ sessionId: "session-1", percent: 125 })).toMatchObject({ percent: 125 });
  });

  test("does not execute root, composition, event array, or event accessors", () => {
    let accessed = false;
    const event = { at: 1_788_621_600_000 };
    Object.defineProperty(event, "type", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("event type getter executed");
      },
    });
    const recentEvents = [event];
    Object.defineProperty(recentEvents, "0", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("event index getter executed");
      },
    });
    const composition = {};
    Object.defineProperty(composition, "user", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("composition getter executed");
      },
    });
    const data = { sessionId: "session-1", messages: 1, scannedMessages: 1, composition, recentEvents };
    Object.defineProperty(data, "percent", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("percent getter executed");
      },
    });

    expect(() => contextInsightsPanelView(data)).not.toThrow();
    expect(contextInsightsPanelView(data)).toMatchObject({
      percent: null,
      composition: { user: 0, assistant: 0, toolResult: 0, system: 0, other: 1 },
      recentEvents: [{ type: "unknown", at: null }],
    });
    expect(accessed).toBe(false);
  });
});
