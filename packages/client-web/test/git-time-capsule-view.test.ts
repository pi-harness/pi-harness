import { describe, expect, test } from "vitest";
import { gitTimeCapsulePanelView } from "../src/git-time-capsule-view.js";

describe("Git time capsule panel view", () => {
  test("normalizes activity, capsule inventory, timeout, and safety limits", () => {
    const view = gitTimeCapsulePanelView({
      latest: {
        action: "capture",
        status: "completed",
        at: "2026-09-05T06:00:00.000Z",
        name: "20260905T060000000Z-a1b2c3d4.patch",
        bytes: 512,
        files: 2,
      },
      capsules: [
        { name: "20260905T060000000Z-a1b2c3d4.patch", bytes: 512 },
        { name: "20260905T050000000Z-e5f6a7b8.patch", bytes: 256 },
      ],
      inventory: { total: 25, shown: 2, truncated: true, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
    });

    expect(view).toEqual({
      latest: {
        action: "capture",
        status: "completed",
        at: "2026-09-05T06:00:00.000Z",
        name: "20260905T060000000Z-a1b2c3d4.patch",
        bytes: 512,
        files: 2,
        error: null,
      },
      capsules: [
        { name: "20260905T060000000Z-a1b2c3d4.patch", bytes: 512 },
        { name: "20260905T050000000Z-e5f6a7b8.patch", bytes: 256 },
      ],
      inventory: { total: 25, shown: 2, truncated: true, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
      truncated: false,
    });
  });

  test("bounds hostile panel data and never presents malformed activity as success", () => {
    const capsules = Array.from({ length: 30 }, (_, index) => ({
      name: index === 0 ? "../outside.patch" : `${String(index).padStart(4, "0")}.patch`,
      bytes: index === 1 ? Number.POSITIVE_INFINITY : index,
    }));
    const view = gitTimeCapsulePanelView({
      latest: { action: "capture", status: "completed", at: "invalid", name: "../outside.patch", error: "x".repeat(3_000) },
      capsules,
      inventory: { total: -1, shown: Number.NaN, truncated: false, displayLimit: Number.POSITIVE_INFINITY },
      timeoutMs: Number.NaN,
      limits: { capsuleBytes: -1, inventory: 0, directoryEntries: Number.POSITIVE_INFINITY },
    });

    expect(view.latest).toBeNull();
    expect(view.capsules).toHaveLength(18);
    expect(view.capsules[0]?.name).toBe("0002.patch");
    expect(view).toMatchObject({
      inventory: { total: 18, shown: 18, truncated: true, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
      truncated: true,
    });
  });

  test("fails closed without invoking panel accessors or revoked proxies", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "capsules", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(() => gitTimeCapsulePanelView(accessor)).not.toThrow();
    expect(() => gitTimeCapsulePanelView(revocable.proxy)).not.toThrow();
    expect(getterCalls).toBe(0);
    expect(gitTimeCapsulePanelView(accessor)).toMatchObject({ latest: null, capsules: [], truncated: true });
    expect(gitTimeCapsulePanelView(revocable.proxy)).toMatchObject({ latest: null, capsules: [], truncated: true });
  });

  test("bounds inaccessible nested capsule collections without invoking entries", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "name", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "poison.patch";
      },
    });
    const revocable = Proxy.revocable([], {});
    revocable.revoke();

    expect(() => gitTimeCapsulePanelView({ capsules: revocable.proxy })).not.toThrow();
    expect(() => gitTimeCapsulePanelView({ capsules: [accessor] })).not.toThrow();
    expect(getterCalls).toBe(0);
    expect(gitTimeCapsulePanelView({ capsules: revocable.proxy })).toMatchObject({ capsules: [], truncated: true });
    expect(gitTimeCapsulePanelView({ capsules: [accessor] })).toMatchObject({ capsules: [], truncated: true });
  });

  test("removes control and bidi characters from panel-visible failures and names", () => {
    const view = gitTimeCapsulePanelView({
      latest: { action: "capture", status: "failed", at: "2026-09-05T06:00:00.000Z", error: "fatal\u202e\u0001message" },
      capsules: [{ name: "deceptive\u202e.patch", bytes: 1 }],
      inventory: { total: 1, shown: 1, truncated: false, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
    });

    expect(view.latest?.error).toBe("fatal message");
    expect(view.capsules).toEqual([]);
    expect(view.truncated).toBe(true);
  });

  test("rejects ambiguous or unsafe capsule names consistently with restore", () => {
    const view = gitTimeCapsulePanelView({
      latest: {
        action: "capture",
        status: "completed",
        at: "2026-09-05T06:00:00.000Z",
        name: " padded.patch ",
        bytes: 1,
        files: 1,
      },
      capsules: [
        { name: " padded.patch ", bytes: 1 },
        { name: `${"😀".repeat(64)}.patch`, bytes: 1 },
        { name: "broken\ud800.patch", bytes: 1 },
      ],
      inventory: { total: 3, shown: 3, truncated: false, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
    });

    expect(view.latest).toBeNull();
    expect(view.capsules).toEqual([]);
    expect(view.truncated).toBe(true);
  });

  test("replaces contradictory inventory and limit metadata with safe contract values", () => {
    const view = gitTimeCapsulePanelView({
      latest: null,
      capsules: [{ name: "20260905T060000000Z-a1b2c3d4.patch", bytes: 512 }],
      inventory: { total: 0, shown: 20, truncated: false, displayLimit: 999 },
      timeoutMs: 999_999,
      limits: { capsuleBytes: 1, inventory: 999, directoryEntries: 1 },
    });

    expect(view).toMatchObject({
      capsules: [{ name: "20260905T060000000Z-a1b2c3d4.patch", bytes: 512 }],
      inventory: { total: 1, shown: 1, truncated: true, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
      truncated: true,
    });
  });

  test("rejects activity and inventory byte counts beyond the capsule limit", () => {
    const name = "20260905T060000000Z-a1b2c3d4.patch";
    const view = gitTimeCapsulePanelView({
      latest: { action: "capture", status: "completed", at: "2026-09-05T06:00:00.000Z", name, bytes: 8_388_609, files: 1 },
      capsules: [{ name, bytes: 8_388_609 }],
      inventory: { total: 1, shown: 1, truncated: false, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
    });

    expect(view.latest).toBeNull();
    expect(view.capsules).toEqual([]);
    expect(view.truncated).toBe(true);
  });

  test("rejects failure activity that omits its diagnostic", () => {
    const view = gitTimeCapsulePanelView({
      latest: { action: "restore", status: "failed", at: "2026-09-05T06:00:00.000Z" },
      capsules: [],
      inventory: { total: 0, shown: 0, truncated: false, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
    });

    expect(view.latest).toBeNull();
    expect(view.truncated).toBe(true);
  });

  test("rejects non-canonical activity timestamps instead of silently rewriting them", () => {
    const name = "20260905T060000000Z-a1b2c3d4.patch";
    const view = gitTimeCapsulePanelView({
      latest: { action: "capture", status: "completed", at: "2026-09-05T06:00:00Z", name, bytes: 512, files: 2 },
      capsules: [{ name, bytes: 512 }],
      inventory: { total: 1, shown: 1, truncated: false, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
    });

    expect(view.latest).toBeNull();
    expect(view.truncated).toBe(true);
  });

  test("marks unknown top-level panel contract fields as truncated", () => {
    const view = gitTimeCapsulePanelView({
      latest: null,
      capsules: [],
      inventory: { total: 0, shown: 0, truncated: false, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
      unexpected: true,
    });

    expect(view).toMatchObject({ latest: null, capsules: [], truncated: true });
  });

  test("marks unknown nested panel contract fields as truncated", () => {
    const name = "20260905T060000000Z-a1b2c3d4.patch";
    const base = {
      latest: { action: "capture", status: "completed", at: "2026-09-05T06:00:00.000Z", name, bytes: 512, files: 2 },
      capsules: [{ name, bytes: 512 }],
      inventory: { total: 1, shown: 1, truncated: false, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
    };

    const views = [
      gitTimeCapsulePanelView({ ...base, latest: { ...base.latest, unexpected: true } }),
      gitTimeCapsulePanelView({ ...base, capsules: [{ ...base.capsules[0], unexpected: true }] }),
      gitTimeCapsulePanelView({ ...base, inventory: { ...base.inventory, unexpected: true } }),
      gitTimeCapsulePanelView({ ...base, limits: { ...base.limits, unexpected: true } }),
    ];

    expect(views.map((view) => view.truncated)).toEqual([true, true, true, true]);
    expect(views.every((view) => view.capsules.length === 1 && view.inventory.total === 1)).toBe(true);
  });

  test("accepts the restore completion marker emitted by the backend", () => {
    const name = "20260905T060000000Z-a1b2c3d4.patch";
    const view = gitTimeCapsulePanelView({
      latest: { action: "restore", status: "completed", at: "2026-09-05T06:00:00.000Z", name, bytes: 512, files: 2, restored: true },
      capsules: [{ name, bytes: 512 }],
      inventory: { total: 1, shown: 1, truncated: false, displayLimit: 20 },
      timeoutMs: 15_000,
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
    });

    expect(view).toMatchObject({ latest: { action: "restore", status: "completed", name }, truncated: false });
  });
});
