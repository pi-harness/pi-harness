import { describe, expect, test, vi } from "vitest";
import { failLoggerPanelView } from "../src/fail-logger-view.js";

describe("failure logger panel view", () => {
  test("preserves aggregate counters and normalized failure occurrences", () => {
    const view = failLoggerPanelView({
      total: 2,
      observed: 4,
      dropped: 1,
      capacity: 50,
      failures: [
        { time: "2026-09-05T01:02:03.000Z", source: "agent", message: "failed", occurrences: 3 },
        { time: "2026-09-05T02:03:04.000Z", source: "compaction", message: "compact failed", occurrences: 1 },
      ],
    });

    expect(view).toEqual({
      total: 2,
      observed: 4,
      dropped: 1,
      capacity: 50,
      failures: [
        { time: "2026-09-05T01:02:03.000Z", source: "agent", message: "failed", occurrences: 3 },
        { time: "2026-09-05T02:03:04.000Z", source: "compaction", message: "compact failed", occurrences: 1 },
      ],
      truncated: false,
    });
  });

  test("bounds hostile failure lists and strings without trusting invalid counters", () => {
    const failures = Array.from({ length: 60 }, (_, index) => ({
      time: index === 0 ? "invalid" : "2026-09-05T00:00:00.000Z",
      source: "s".repeat(100),
      message: "m".repeat(3_000),
      occurrences: index === 1 ? Number.POSITIVE_INFINITY : 1,
    }));
    const view = failLoggerPanelView({
      total: -1,
      observed: Number.NaN,
      dropped: -10,
      capacity: Number.POSITIVE_INFINITY,
      failures,
    });

    expect(view.failures).toHaveLength(50);
    expect(view.failures[0]).toEqual({ time: null, source: "s".repeat(64), message: "m".repeat(2_048), occurrences: 1 });
    expect(view.failures[1]?.occurrences).toBe(1);
    expect(view).toMatchObject({ total: 50, observed: 50, dropped: 0, capacity: 50, truncated: true });
  });

  test("normalizes hostile panel objects without property reads", () => {
    const reads: PropertyKey[] = [];
    const hostile = new Proxy(
      {},
      {
        get(_target, key) {
          reads.push(key);
          throw new Error(`panel property read: ${String(key)}`);
        },
      },
    );

    expect(() => failLoggerPanelView(hostile)).not.toThrow();
    expect(reads).toEqual([]);
    expect(failLoggerPanelView(hostile)).toEqual({
      total: 0,
      observed: 0,
      dropped: 0,
      capacity: 50,
      failures: [],
      truncated: false,
    });
  });

  test("normalizes proxy failure arrays without property reads", () => {
    const reads: PropertyKey[] = [];
    const failures = new Proxy([{ time: "2026-09-05T01:02:03.000Z", source: "agent", message: "failed", occurrences: 1 }], {
      get(_target, key) {
        reads.push(key);
        throw new Error(`failure list property read: ${String(key)}`);
      },
    });

    const view = failLoggerPanelView({ total: 1, observed: 1, dropped: 0, capacity: 50, failures });
    expect(reads).toEqual([]);
    expect(view.failures).toEqual([{ time: "2026-09-05T01:02:03.000Z", source: "agent", message: "failed", occurrences: 1 }]);
    expect(view.truncated).toBe(false);
  });

  test("normalizes proxy failure records without property reads", () => {
    const reads: PropertyKey[] = [];
    const item = new Proxy(
      { time: "2026-09-05T01:02:03.000Z", source: "agent", message: "failed", occurrences: 2 },
      {
        get(_target, key) {
          reads.push(key);
          throw new Error(`failure property read: ${String(key)}`);
        },
      },
    );

    const view = failLoggerPanelView({ total: 1, observed: 2, dropped: 0, capacity: 50, failures: [item] });
    expect(reads).toEqual([]);
    expect(view.failures).toEqual([{ time: "2026-09-05T01:02:03.000Z", source: "agent", message: "failed", occurrences: 2 }]);
    expect(view.truncated).toBe(false);
  });

  test("marks a bounded failure string as truncated even below the list limit", () => {
    const view = failLoggerPanelView({
      total: 1,
      observed: 1,
      dropped: 0,
      capacity: 50,
      failures: [{ time: null, source: "s".repeat(65), message: "m".repeat(2_049), occurrences: 1 }],
    });

    expect(view.failures[0]).toMatchObject({ source: "s".repeat(64), message: "m".repeat(2_048) });
    expect(view.truncated).toBe(true);
  });

  test("sanitizes NUL characters in browser failure strings", () => {
    const view = failLoggerPanelView({
      total: 1,
      observed: 1,
      dropped: 0,
      capacity: 50,
      failures: [{ time: null, source: "ag\0ent", message: "fa\0iled", occurrences: 1 }],
    });

    expect(view.failures[0]).toMatchObject({ source: "ag�ent", message: "fa�iled" });
    expect(view.truncated).toBe(true);
  });

  test("does not trust a capacity above the fixed backend limit", () => {
    const view = failLoggerPanelView({ total: 0, observed: 0, dropped: 0, capacity: Number.MAX_SAFE_INTEGER, failures: [] });
    expect(view.capacity).toBe(50);
  });

  test("rejects oversized timestamps before date parsing", () => {
    const parse = vi.spyOn(Date, "parse");
    try {
      const view = failLoggerPanelView({
        total: 1,
        observed: 1,
        dropped: 0,
        capacity: 50,
        failures: [{ time: "2".repeat(10_000), source: "agent", message: "failed", occurrences: 1 }],
      });
      expect(view.failures[0]?.time).toBeNull();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});
