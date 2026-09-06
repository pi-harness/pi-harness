import { describe, expect, test } from "vitest";
import { cleanerPanelView } from "../src/cleaner-view.js";

function validPanel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capsules: [
      { name: "new.patch", bytes: 128 },
      { name: "old.patch", bytes: 64 },
    ],
    inventory: { total: 2, shown: 2, truncated: false, displayLimit: 20 },
    lastCleanup: { status: "completed", at: "2026-09-05T01:00:00.000Z", requestedKeep: 2, removed: 3, kept: 2 },
    lastRemoved: 3,
    limits: { capsules: 256, directoryEntries: 4_096 },
    ...overrides,
  };
}

describe("Cleaner panel view", () => {
  test("normalizes capsule inventory, cleanup activity, and limits", () => {
    expect(cleanerPanelView(validPanel())).toEqual({
      capsules: [
        { name: "new.patch", bytes: 128 },
        { name: "old.patch", bytes: 64 },
      ],
      totalBytes: 192,
      inventory: { total: 2, shown: 2, truncated: false, displayLimit: 20 },
      lastCleanup: {
        status: "completed",
        at: "2026-09-05T01:00:00.000Z",
        requestedKeep: 2,
        removed: 3,
        kept: 2,
        error: null,
      },
      malformed: false,
      limits: { capsules: 256, directoryEntries: 4_096 },
    });
  });

  test("bounds a valid server inventory to the browser display limit", () => {
    const capsules = Array.from({ length: 20 }, (_, index) => ({ name: `${String(20 - index).padStart(4, "0")}.patch`, bytes: index }));
    const view = cleanerPanelView(
      validPanel({
        capsules,
        inventory: { total: 25, shown: 20, truncated: true, displayLimit: 20 },
      }),
    );

    expect(view.capsules).toEqual(capsules.slice(0, 12));
    expect(view.inventory).toEqual({ total: 25, shown: 12, truncated: true, displayLimit: 20 });
    expect(view.totalBytes).toBe(66);
    expect(view.malformed).toBe(false);
  });

  test("accepts idle, running, failed, and cancelled activity shapes", () => {
    expect(cleanerPanelView(validPanel({ lastCleanup: null, lastRemoved: 0 })).lastCleanup).toBeNull();
    expect(
      cleanerPanelView(
        validPanel({
          lastCleanup: { status: "running", at: "2026-09-05T01:00:00.000Z", requestedKeep: 5, removed: 1 },
          lastRemoved: 1,
        }),
      ).lastCleanup,
    ).toEqual({ status: "running", at: "2026-09-05T01:00:00.000Z", requestedKeep: 5, removed: 1, kept: null, error: null });
    for (const status of ["failed", "cancelled"] as const) {
      expect(
        cleanerPanelView(
          validPanel({
            lastCleanup: { status, at: "2026-09-05T01:00:00.000Z", requestedKeep: 5, removed: 1, error: "operation stopped" },
            lastRemoved: 1,
          }),
        ).lastCleanup,
      ).toEqual({ status, at: "2026-09-05T01:00:00.000Z", requestedKeep: 5, removed: 1, kept: null, error: "operation stopped" });
    }
  });

  test("fails closed for malformed, contradictory, or unbounded payloads", () => {
    const malformed = [
      null,
      [],
      {},
      validPanel({ unexpected: true }),
      validPanel({ capsules: [{ name: "unsafe\n.patch", bytes: 1 }] }),
      validPanel({ capsules: [{ name: "unsafe\\.patch", bytes: 1 }] }),
      validPanel({ capsules: [{ name: "unsafe\u2028.patch", bytes: 1 }] }),
      validPanel({ capsules: [{ name: `${"界".repeat(84)}.patch`, bytes: 1 }] }),
      validPanel({ capsules: [{ name: "safe.patch", bytes: -1 }] }),
      validPanel({ inventory: { total: 1, shown: 2, truncated: false, displayLimit: 20 } }),
      validPanel({ inventory: { total: 2, shown: 2, truncated: true, displayLimit: 20 } }),
      validPanel({ lastRemoved: 2 }),
      validPanel({ lastCleanup: { status: "completed", at: "invalid", requestedKeep: 2, removed: 3, kept: 2 } }),
      validPanel({ lastCleanup: { status: "failed", at: "2026-09-05T01:00:00.000Z", requestedKeep: 2, removed: 3 } }),
      validPanel({ limits: { capsules: 255, directoryEntries: 4_096 } }),
      validPanel({ capsules: Object.assign([{ name: "safe.patch", bytes: 1 }], { "01": { name: "extra.patch", bytes: 1 } }) }),
    ];

    for (const value of malformed) {
      expect(cleanerPanelView(value)).toEqual({
        capsules: [],
        totalBytes: null,
        inventory: null,
        lastCleanup: null,
        malformed: true,
        limits: { capsules: 256, directoryEntries: 4_096 },
      });
    }
  });

  test("does not invoke accessors or revoked proxies and returns detached data", () => {
    let getterCalls = 0;
    const rootAccessor = Object.defineProperty({}, "capsules", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    const capsules: unknown[] = [];
    Object.defineProperty(capsules, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { name: "poison.patch", bytes: 1 };
      },
    });
    const nestedAccessor = validPanel({ capsules, inventory: { total: 1, shown: 1, truncated: false, displayLimit: 20 } });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    for (const value of [rootAccessor, nestedAccessor, revocable.proxy]) {
      expect(() => cleanerPanelView(value)).not.toThrow();
      expect(cleanerPanelView(value).malformed).toBe(true);
    }
    expect(getterCalls).toBe(0);

    const source = validPanel();
    const view = cleanerPanelView(source);
    (source.capsules as Array<{ name: string }>)[0]!.name = "changed.patch";
    (source.lastCleanup as { error?: string }).error = "changed";
    expect(view.capsules[0]?.name).toBe("new.patch");
    expect(view.lastCleanup?.error).toBeNull();
  });
});
