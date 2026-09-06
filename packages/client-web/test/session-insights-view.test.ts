import { describe, expect, test } from "vitest";
import { sessionInsightsPanelView } from "../src/session-insights-view.js";

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionFile: null,
    sessionId: "session-1",
    userMessages: 2,
    assistantMessages: 2,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 5,
    tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, total: 35 },
    cost: 0.012_345,
    contextUsage: { tokens: 250, contextWindow: 1_000, percent: 25 },
    compaction: { status: "completed", requestedAt: "2026-09-06T00:00:00.000Z", startedAt: "2026-09-06T00:00:01.000Z", finishedAt: "2026-09-06T00:00:02.000Z" },
    ...overrides,
  };
}

describe("Session Insights panel view", () => {
  test("normalizes a complete detached session report", () => {
    const source = report();
    const view = sessionInsightsPanelView(source);

    expect(view).toEqual({
      report: {
        sessionId: "session-1",
        userMessages: 2,
        assistantMessages: 2,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 5,
        tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, total: 35 },
        cost: 0.012_345,
        contextUsage: { tokens: 250, contextWindow: 1_000, percent: 25 },
      },
      compaction: {
        status: "completed",
        requestedAt: "2026-09-06T00:00:00.000Z",
        startedAt: "2026-09-06T00:00:01.000Z",
        finishedAt: "2026-09-06T00:00:02.000Z",
        error: null,
      },
      malformed: false,
      limits: { sessionIdCharacters: 512, errorCharacters: 2_000 },
    });
    (source.tokens as { total: number }).total = 999;
    expect(view.report?.tokens.total).toBe(35);
  });

  test("preserves a temporarily unknown post-compaction context usage", () => {
    expect(
      sessionInsightsPanelView(
        report({
          contextUsage: { tokens: null, contextWindow: 1_000, percent: null },
          compaction: { status: "idle" },
        }),
      ),
    ).toMatchObject({
      report: { contextUsage: { tokens: null, contextWindow: 1_000, percent: null } },
      compaction: { status: "idle" },
      malformed: false,
    });
    expect(sessionInsightsPanelView(report({ contextUsage: null }))).toMatchObject({ report: { contextUsage: null }, malformed: false });
  });

  test("fails closed instead of manufacturing healthy values from malformed reports", () => {
    const malformed = [
      null,
      [],
      report({ sessionId: "" }),
      report({ totalMessages: 4 }),
      report({ cost: Number.NaN }),
      report({ tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, total: 34 } }),
      report({ contextUsage: { tokens: null, contextWindow: 1_000, percent: 25 } }),
      report({ contextUsage: { tokens: 250, contextWindow: 1_000, percent: 24 } }),
    ];

    for (const value of malformed) {
      const view = sessionInsightsPanelView(value);
      expect(view.report).toBeNull();
      expect(view.malformed).toBe(true);
    }
  });

  test("does not invoke root or nested accessors", () => {
    let accesses = 0;
    const root = report();
    Object.defineProperty(root, "cost", {
      enumerable: true,
      get() {
        accesses += 1;
        throw new Error("cost getter executed");
      },
    });
    const nested = report();
    Object.defineProperty(nested.tokens, "total", {
      enumerable: true,
      get() {
        accesses += 1;
        throw new Error("token getter executed");
      },
    });
    const compaction = report();
    Object.defineProperty(compaction.compaction, "status", {
      enumerable: true,
      get() {
        accesses += 1;
        throw new Error("compaction getter executed");
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    for (const value of [root, nested, compaction, revocable.proxy]) {
      expect(() => sessionInsightsPanelView(value)).not.toThrow();
      expect(sessionInsightsPanelView(value)).toMatchObject({ report: null, malformed: true });
    }
    expect(accesses).toBe(0);
  });

  test("marks malformed compaction state as unknown without discarding valid statistics", () => {
    for (const state of [
      { status: "queued" },
      { status: "running", requestedAt: "invalid", startedAt: "2026-09-06T00:00:01.000Z" },
      {
        status: "completed",
        requestedAt: "2026-09-06T00:00:02.000Z",
        startedAt: "2026-09-06T00:00:01.000Z",
        finishedAt: "2026-09-06T00:00:00.000Z",
      },
      { status: "failed", requestedAt: "2026-09-06T00:00:00.000Z", finishedAt: "2026-09-06T00:00:01.000Z", error: "x".repeat(2_001) },
    ]) {
      const view = sessionInsightsPanelView(report({ compaction: state }));
      expect(view.report).not.toBeNull();
      expect(view.compaction).toEqual({ status: "unknown", requestedAt: null, startedAt: null, finishedAt: null, error: null });
      expect(view.malformed).toBe(true);
    }
  });

  test("does not share fallback state between normalized views", () => {
    const first = sessionInsightsPanelView(null);
    (first.compaction as { status: string }).status = "completed";
    (first.limits as { errorCharacters: number }).errorCharacters = 1;

    expect(sessionInsightsPanelView(null)).toMatchObject({
      compaction: { status: "unknown" },
      limits: { errorCharacters: 2_000 },
    });
  });
});
