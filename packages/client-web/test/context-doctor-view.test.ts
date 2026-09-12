import { describe, expect, test } from "vitest";
import { contextDoctorPanelView } from "../src/context-doctor-view.js";

describe("Context Doctor panel view", () => {
  test("fails closed for a snapshot from another active session", () => {
    const view = contextDoctorPanelView(
      {
        sessionId: "previous-session",
        status: "warning",
        usagePercent: 92,
        messageCount: 20,
        scannedMessages: 20,
        oversizedMessages: 2,
        uninspectableMessages: 1,
        toolErrors: 3,
        recommendations: ["old recommendation"],
        compaction: { status: "completed" },
      },
      "active-session",
    );

    expect(view).toMatchObject({ sessionId: "", status: "unknown", usagePercent: null, messageCount: 0, recommendations: [], malformed: true });
    expect(view.compaction.status).toBe("unknown");
  });

  test("preserves over-capacity usage for warnings", () => {
    expect(contextDoctorPanelView({ usagePercent: 125 })).toMatchObject({ usagePercent: 125 });
  });

  test("normalizes a complete audit and completed compaction", () => {
    expect(
      contextDoctorPanelView({
        sessionId: "session-1",
        status: "warning",
        usagePercent: 82,
        tokens: 820,
        contextWindow: 1_000,
        messageCount: 12,
        scannedMessages: 12,
        messagesTruncated: false,
        oversizedMessages: 2,
        uninspectableMessages: 1,
        toolErrors: 3,
        warnPercent: 75,
        maxMessageBytes: 65_536,
        recommendations: ["compact older context", "inspect tool failures"],
        compaction: {
          status: "completed",
          requestedAt: "2026-09-05T13:00:00.000Z",
          startedAt: "2026-09-05T13:00:01.000Z",
          finishedAt: "2026-09-05T13:00:02.000Z",
        },
        limits: {
          scannedMessages: 10_000,
          jsonDepth: 64,
          jsonNodesPerMessage: 10_000,
          jsonNodesPerAudit: 100_000,
          errorCharacters: 2_000,
        },
      }),
    ).toEqual({
      sessionId: "session-1",
      status: "warning",
      usagePercent: 82,
      tokens: 820,
      contextWindow: 1_000,
      messageCount: 12,
      scannedMessages: 12,
      messagesTruncated: false,
      oversizedMessages: 2,
      uninspectableMessages: 1,
      toolErrors: 3,
      warnPercent: 75,
      maxMessageBytes: 65_536,
      recommendations: ["compact older context", "inspect tool failures"],
      recommendationsTruncated: false,
      compaction: {
        status: "completed",
        error: null,
        requestedAt: "2026-09-05T13:00:00.000Z",
        startedAt: "2026-09-05T13:00:01.000Z",
        finishedAt: "2026-09-05T13:00:02.000Z",
      },
      limits: {
        scannedMessages: 10_000,
        jsonDepth: 64,
        jsonNodesPerMessage: 10_000,
        jsonNodesPerAudit: 100_000,
        errorCharacters: 2_000,
        recommendationCharacters: 500,
        displayRecommendations: 4,
      },
      malformed: false,
    });
  });

  test("enforces fixed browser caps for malformed panel data", () => {
    const unsafe = `bad\0${"x".repeat(10_000)}`;
    const view = contextDoctorPanelView({
      status: unsafe,
      usagePercent: Number.POSITIVE_INFINITY,
      tokens: -1,
      contextWindow: Number.NaN,
      messageCount: Number.MAX_SAFE_INTEGER,
      scannedMessages: Number.MAX_SAFE_INTEGER,
      oversizedMessages: Number.MAX_SAFE_INTEGER,
      uninspectableMessages: Number.MAX_SAFE_INTEGER,
      toolErrors: Number.MAX_SAFE_INTEGER,
      warnPercent: 999,
      maxMessageBytes: Number.MAX_SAFE_INTEGER,
      recommendations: Array.from({ length: 20 }, () => unsafe),
      compaction: {
        status: "failed",
        error: unsafe,
        requestedAt: unsafe,
        startedAt: unsafe,
        finishedAt: unsafe,
      },
      limits: {
        scannedMessages: 999_999,
        jsonDepth: 999_999,
        jsonNodesPerMessage: 999_999,
        jsonNodesPerAudit: 999_999,
        errorCharacters: 999_999,
      },
    });

    expect(view).toMatchObject({
      status: "unknown",
      usagePercent: null,
      tokens: null,
      contextWindow: null,
      messageCount: 0,
      scannedMessages: 0,
      oversizedMessages: 0,
      uninspectableMessages: 0,
      toolErrors: 0,
      warnPercent: 75,
      maxMessageBytes: 65_536,
      recommendationsTruncated: true,
      compaction: { status: "failed", requestedAt: null, startedAt: null, finishedAt: null },
    });
    expect(view.recommendations).toHaveLength(4);
    expect(view.recommendations[0]).toHaveLength(500);
    expect(view.recommendations[0]).not.toContain("\0");
    expect(view.compaction.error).toHaveLength(2_000);
    expect(view.compaction.error).not.toContain("\0");
    expect(view.limits).toMatchObject({
      scannedMessages: 10_000,
      jsonDepth: 64,
      jsonNodesPerMessage: 10_000,
      jsonNodesPerAudit: 100_000,
      errorCharacters: 2_000,
    });
  });

  test("does not execute root, compaction, or recommendation array accessors", () => {
    let accessed = false;
    const recommendations = ["safe", "hidden"] as unknown[];
    Object.defineProperty(recommendations, "1", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("recommendation getter executed");
      },
    });
    const compaction = { status: "failed" };
    Object.defineProperty(compaction, "error", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("compaction error getter executed");
      },
    });
    const data = { recommendations, compaction };
    Object.defineProperty(data, "usagePercent", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("usage getter executed");
      },
    });

    expect(() => contextDoctorPanelView(data)).not.toThrow();
    expect(contextDoctorPanelView(data)).toMatchObject({
      usagePercent: null,
      recommendations: ["safe"],
      recommendationsTruncated: true,
      compaction: { status: "failed", error: null },
    });
    expect(accessed).toBe(false);
  });
});
