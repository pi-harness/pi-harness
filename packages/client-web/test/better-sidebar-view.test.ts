import { describe, expect, test } from "vitest";
import { betterSidebarPanelView } from "../src/better-sidebar-view.js";

function valid() {
  return {
    cwd: "/workspace/commerce-platform",
    gitAvailable: true,
    gitFailureReason: null,
    branch: "feature/orders",
    clean: false,
    changedCount: 2,
    changedFiles: [
      { path: "services/orders/index.ts", status: " M" },
      { path: "services/catalog/index.ts", status: "??" },
    ],
    directoryCount: 20,
    fileCount: 60,
    truncated: false,
    sessionId: "session-1",
    summary: "feature/orders · 2 个变更",
  };
}

describe("better sidebar panel view", () => {
  test("accepts an exact bounded producer snapshot", () => {
    expect(betterSidebarPanelView(valid())).toEqual({ ...valid(), malformed: false });
    expect(betterSidebarPanelView(valid(), "another-session")).toMatchObject({ malformed: true, changedFiles: [] });
  });

  test("accepts an actionable unavailable Git reason", () => {
    const value = {
      ...valid(),
      gitAvailable: false,
      gitFailureReason: "timeout",
      branch: null,
      clean: false,
      changedCount: 0,
      changedFiles: [],
      truncated: false,
      summary: "Git 状态不可用 (timeout) · 无变更",
    };

    expect(betterSidebarPanelView(value)).toMatchObject({ malformed: false, gitAvailable: false, gitFailureReason: "timeout" });
  });

  test("preserves a valid rename pair", () => {
    const value = {
      ...valid(),
      changedCount: 1,
      changedFiles: [{ path: "services/orders/new.ts", originalPath: "services/orders/old.ts", status: "R " }],
    };

    expect(betterSidebarPanelView(value)).toMatchObject({
      malformed: false,
      changedFiles: [{ path: "services/orders/new.ts", originalPath: "services/orders/old.ts", status: "R " }],
    });
  });

  test("fails closed on contradictory, accessor, proxy, and oversized snapshots", () => {
    const accessor = valid();
    let accessed = false;
    Object.defineProperty(accessor, "cwd", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("getter executed");
      },
    });
    const revoked = Proxy.revocable(valid(), {});
    revoked.revoke();
    let arrayAccessed = false;
    const proxiedFiles = new Proxy(valid().changedFiles, {
      get() {
        arrayAccessed = true;
        throw new Error("array getter executed");
      },
    });
    const malformed = [
      null,
      { ...valid(), extra: true },
      { ...valid(), directoryCount: 21 },
      { ...valid(), changedCount: 1 },
      { ...valid(), changedFiles: [{ path: "../outside", status: " M" }] },
      { ...valid(), changedFiles: [{ path: "orders\n\u202Ecod.ts", status: "??" }] },
      { ...valid(), changedFiles: [{ path: "orders\u2028line\u2029paragraph.ts", status: "??" }] },
      { ...valid(), cwd: "/workspace/commerce\u202Eplatform" },
      { ...valid(), changedFiles: [{ path: "orders.ts", status: "bad" }] },
      { ...valid(), gitFailureReason: "timeout" },
      { ...valid(), gitAvailable: false, gitFailureReason: "timeout" },
      { ...valid(), summary: "x".repeat(129 * 1024) },
      accessor,
      revoked.proxy,
    ];

    for (const value of malformed) expect(betterSidebarPanelView(value)).toMatchObject({ malformed: true, changedFiles: [] });
    expect(betterSidebarPanelView({ ...valid(), changedFiles: proxiedFiles })).toMatchObject({ malformed: false });
    expect(accessed).toBe(false);
    expect(arrayAccessed).toBe(false);
  });
});
