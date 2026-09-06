import { describe, expect, it } from "vitest";
import { pluginDevPanelView } from "../src/plugin-dev-view.js";

describe("plugin dev view", () => {
  it("normalizes a complete reload panel payload", () => {
    expect(
      pluginDevPanelView({
        status: "running",
        reason: "reload local extension",
        requestedAt: "2026-09-05T10:00:00.000Z",
        startedAt: "2026-09-05T10:00:01.000Z",
        error: "",
        limits: { reasonCharacters: 1_000, errorCharacters: 2_000 },
      }),
    ).toEqual({
      status: "running",
      reason: "reload local extension",
      requestedAt: "2026-09-05T10:00:00.000Z",
      startedAt: "2026-09-05T10:00:01.000Z",
      reloadedAt: null,
      error: null,
      busy: true,
      limits: { reasonCharacters: 1_000, errorCharacters: 2_000 },
    });
  });

  it("bounds hostile strings and falls back from invalid status and limits", () => {
    const long = "x".repeat(10_000);
    const view = pluginDevPanelView({
      status: "invented",
      reason: long,
      requestedAt: long,
      startedAt: 42,
      reloadedAt: long,
      error: long,
      limits: { reasonCharacters: 9_999, errorCharacters: 9_999 },
    });
    expect(view).toEqual({
      status: "idle",
      reason: "x".repeat(1_000),
      requestedAt: "x".repeat(64),
      startedAt: null,
      reloadedAt: "x".repeat(64),
      error: "x".repeat(2_000),
      busy: false,
      limits: { reasonCharacters: 1_000, errorCharacters: 2_000 },
    });
  });

  it("accepts every backend state and marks only queued or running work as busy", () => {
    expect(["idle", "queued", "running", "reloaded", "failed", "cancelled"].map((status) => pluginDevPanelView({ status }).status)).toEqual([
      "idle",
      "queued",
      "running",
      "reloaded",
      "failed",
      "cancelled",
    ]);
    expect(pluginDevPanelView({ status: "queued" }).busy).toBe(true);
    expect(pluginDevPanelView({ status: "running" }).busy).toBe(true);
    expect(pluginDevPanelView({ status: "cancelled" }).busy).toBe(false);
  });
});
