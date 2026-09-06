import { describe, expect, test } from "vitest";
import { i18nPairPanelView } from "../src/i18n-pair-view.js";

function validPanel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: { state: "completed", at: "2026-09-05T01:00:00.000Z" },
    report: {
      base: "locales/en.json",
      target: "locales/ja.json",
      baseKeys: 3,
      targetKeys: 2,
      missing: ["actions.save"],
      extra: [],
      missingTotal: 1,
      extraTotal: 0,
      truncated: false,
    },
    limits: { fileBytes: 4_194_304, depth: 128, keysPerFile: 50_000, flattenedKeyLength: 2_048, pathLength: 4_096, panelKeysPerSide: 100 },
    ...overrides,
  };
}

describe("I18n pair panel view", () => {
  test("normalizes comparison status, report inventories, and limits", () => {
    const view = i18nPairPanelView(validPanel());

    expect(view).toEqual({
      status: { state: "completed", at: "2026-09-05T01:00:00.000Z", error: null },
      report: {
        base: "locales/en.json",
        target: "locales/ja.json",
        baseKeys: 3,
        targetKeys: 2,
        missing: ["actions.save"],
        extra: [],
        missingTotal: 1,
        extraTotal: 0,
        truncated: false,
      },
      malformed: false,
      limits: { fileBytes: 4_194_304, depth: 128, keysPerFile: 50_000, flattenedKeyLength: 2_048, pathLength: 4_096, panelKeysPerSide: 100 },
    });
  });

  test("bounds a valid server inventory to the visible list limit", () => {
    const missing = Array.from({ length: 60 }, (_, index) => `missing-${index}`);
    const extra = Array.from({ length: 60 }, (_, index) => `extra-${index}`);
    const view = i18nPairPanelView(
      validPanel({
        status: { state: "failed", at: "2026-09-05T01:01:00.000Z", error: "comparison failed" },
        report: {
          base: "locales/en.json",
          target: "locales/ja.json",
          baseKeys: 100,
          targetKeys: 100,
          missing,
          extra,
          missingTotal: 60,
          extraTotal: 60,
          truncated: false,
        },
      }),
    );

    expect(view.status).toEqual({ state: "failed", at: "2026-09-05T01:01:00.000Z", error: "comparison failed" });
    expect(view.report).toMatchObject({ baseKeys: 100, targetKeys: 100, missingTotal: 60, extraTotal: 60, truncated: true });
    expect(view.report?.missing).toEqual(missing.slice(0, 50));
    expect(view.report?.extra).toEqual(extra.slice(0, 50));
    expect(view.malformed).toBe(false);
  });

  test("fails closed for malformed or contradictory reports", () => {
    const malformed = [
      null,
      [],
      {},
      validPanel({ report: null }),
      validPanel({ report: { base: "locales/en.json" } }),
      validPanel({
        report: {
          base: "locales/en.json",
          target: "locales/ja.json",
          baseKeys: 1,
          targetKeys: 1,
          missing: [42],
          extra: [],
          missingTotal: 1,
          extraTotal: 0,
          truncated: false,
        },
      }),
      validPanel({
        report: {
          base: "locales/en.json",
          target: "locales/ja.json",
          baseKeys: 1,
          targetKeys: 1,
          missing: ["missing"],
          extra: [],
          missingTotal: 1,
          extraTotal: 0,
          truncated: false,
        },
      }),
      validPanel({ status: { state: "completed", at: "invalid" } }),
      validPanel({ limits: { fileBytes: -1 } }),
      validPanel({ unexpected: true }),
    ];

    for (const value of malformed) {
      const view = i18nPairPanelView(value);
      expect(view).toMatchObject({
        status: { state: "unknown", at: null, error: null },
        report: null,
        malformed: true,
      });
    }
  });

  test("does not invoke accessors or revoked proxies and detaches returned arrays", () => {
    let getterCalls = 0;
    const rootAccessor = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { state: "idle" };
      },
    });
    const listAccessor: unknown[] = [];
    Object.defineProperty(listAccessor, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "poison";
      },
    });
    const nestedAccessor = validPanel({
      report: {
        base: "locales/en.json",
        target: "locales/ja.json",
        baseKeys: 1,
        targetKeys: 0,
        missing: listAccessor,
        extra: [],
        missingTotal: 1,
        extraTotal: 0,
        truncated: false,
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    for (const value of [rootAccessor, nestedAccessor, revocable.proxy]) {
      expect(() => i18nPairPanelView(value)).not.toThrow();
      expect(i18nPairPanelView(value).malformed).toBe(true);
    }
    expect(getterCalls).toBe(0);

    const source = validPanel();
    const view = i18nPairPanelView(source);
    (source.report as { missing: string[] }).missing[0] = "changed";
    expect(view.report?.missing).toEqual(["actions.save"]);
  });
});
