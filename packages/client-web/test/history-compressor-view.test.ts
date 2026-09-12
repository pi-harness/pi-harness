import { describe, expect, test } from "vitest";
import { historyCompressorPanelView } from "../src/history-compressor-view.js";

function report() {
  return {
    sessionId: "session-1",
    enabled: true,
    thresholdPercent: 85,
    compactions: 2,
    lastUsagePercent: 87.5,
    queued: false,
    lastError: null,
  };
}

describe("History Compressor panel view", () => {
  test("accepts only the active session snapshot", () => {
    expect(historyCompressorPanelView(report(), "session-1")).toEqual({ ...report(), malformed: false });
    expect(historyCompressorPanelView(report(), "session-2")).toMatchObject({ malformed: true, sessionId: "", compactions: 0 });
  });

  test("fails closed on malformed and accessor-backed snapshots", () => {
    let accessed = false;
    const accessor = report();
    Object.defineProperty(accessor, "compactions", {
      enumerable: true,
      get() {
        accessed = true;
        return 2;
      },
    });
    const revoked = Proxy.revocable(report(), {});
    revoked.revoke();

    for (const value of [
      null,
      { ...report(), extra: true },
      { ...report(), compactions: -1 },
      { ...report(), lastError: "x".repeat(2_001) },
      accessor,
      revoked.proxy,
    ]) {
      expect(historyCompressorPanelView(value, "session-1")).toMatchObject({ malformed: true, sessionId: "", compactions: 0 });
    }
    expect(accessed).toBe(false);
  });
});
