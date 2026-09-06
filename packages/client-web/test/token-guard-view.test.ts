import { describe, expect, test } from "vitest";
import { tokenGuardPanelView } from "../src/token-guard-view.js";

describe("Token Guard panel view", () => {
  test("normalizes a complete guard snapshot", () => {
    expect(
      tokenGuardPanelView({
        maxPercent: 80,
        maxRunTokens: 1_000,
        percent: 85,
        tokens: 8_500,
        contextWindow: 10_000,
        runTokens: 1_100,
        runExceeded: true,
        exceeded: true,
        aborts: 2,
        lastError: null,
      }),
    ).toEqual({
      maxPercent: 80,
      maxRunTokens: 1_000,
      percent: 85,
      tokens: 8_500,
      contextWindow: 10_000,
      runTokens: 1_100,
      runExceeded: true,
      exceeded: true,
      aborts: 2,
      lastError: null,
      limits: { maxRunTokens: 10_000_000, errorCharacters: 2_000, streamingUpdateInterval: 32 },
    });
  });

  test("applies fixed browser bounds and derives threshold state", () => {
    const error = `bad\0${"x".repeat(10_000)}`;
    const view = tokenGuardPanelView({
      maxPercent: 999,
      maxRunTokens: Number.MAX_SAFE_INTEGER,
      percent: Number.NaN,
      tokens: -1,
      contextWindow: Number.POSITIVE_INFINITY,
      runTokens: 1.5,
      runExceeded: true,
      exceeded: true,
      aborts: Number.MAX_SAFE_INTEGER,
      lastError: error,
      limits: { maxRunTokens: Number.MAX_SAFE_INTEGER, errorCharacters: Number.MAX_SAFE_INTEGER },
    });

    expect(view).toMatchObject({
      maxPercent: 90,
      maxRunTokens: 0,
      percent: null,
      tokens: null,
      contextWindow: null,
      runTokens: null,
      runExceeded: false,
      exceeded: false,
      aborts: 0,
    });
    expect(view.lastError).toHaveLength(2_000);
    expect(view.lastError).not.toContain("\0");
    expect(view.limits).toEqual({ maxRunTokens: 10_000_000, errorCharacters: 2_000, streamingUpdateInterval: 32 });
  });

  test("preserves over-capacity percentages and derives exceeded independently", () => {
    expect(tokenGuardPanelView({ maxPercent: 90, percent: 125, exceeded: false })).toMatchObject({ percent: 125, exceeded: true });
  });

  test("does not execute root or limits accessors", () => {
    let accessed = false;
    const limits = {};
    Object.defineProperty(limits, "errorCharacters", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("limit getter executed");
      },
    });
    const data = { limits };
    Object.defineProperty(data, "percent", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("percent getter executed");
      },
    });

    expect(() => tokenGuardPanelView(data)).not.toThrow();
    expect(tokenGuardPanelView(data)).toMatchObject({ percent: null, exceeded: false });
    expect(accessed).toBe(false);
  });
});
