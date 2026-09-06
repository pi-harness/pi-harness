import { describe, expect, it } from "vitest";
import { turnRewindPanelView } from "../src/turn-rewind-view.js";

describe("Turn Rewind view", () => {
  it("normalizes candidate inventory and completed operation state", () => {
    expect(
      turnRewindPanelView({
        candidates: [
          { entryId: "u1", text: "first" },
          { entryId: "u2", text: "second" },
        ],
        inventory: { scannedEntries: 4, shown: 2, truncated: false, scanTruncated: false, candidateTruncated: false },
        latest: {
          status: "completed",
          target: { entryId: "u2", text: "second" },
          cancelled: false,
          summarized: true,
          editorText: "second",
          requestedAt: "2026-09-05T13:00:00.000Z",
          startedAt: "2026-09-05T13:00:01.000Z",
          finishedAt: "2026-09-05T13:00:02.000Z",
        },
        limits: { candidates: 50, scannedEntries: 4_096, contentParts: 1_000, previewCharacters: 500 },
      }),
    ).toEqual({
      candidates: [
        { entryId: "u1", text: "first" },
        { entryId: "u2", text: "second" },
      ],
      inventory: {
        scannedEntries: 4,
        shown: 2,
        truncated: false,
        scanTruncated: false,
        candidateTruncated: false,
        displayTruncated: false,
      },
      latest: {
        status: "completed",
        target: { entryId: "u2", text: "second" },
        cancelled: false,
        summarized: true,
        editorText: "second",
        error: null,
        requestedAt: "2026-09-05T13:00:00.000Z",
        startedAt: "2026-09-05T13:00:01.000Z",
        finishedAt: "2026-09-05T13:00:02.000Z",
      },
      limits: {
        candidates: 50,
        displayCandidates: 8,
        scannedEntries: 4_096,
        contentParts: 1_000,
        previewCharacters: 500,
        entryIdCharacters: 200,
        editorTextCharacters: 4_096,
        errorCharacters: 2_000,
      },
    });
  });

  it("enforces fixed browser caps and rejects malformed nested state", () => {
    const unsafe = `bad\0${"x".repeat(10_000)}`;
    const candidates = Array.from({ length: 100 }, (_, index) => ({ entryId: `${index}-${unsafe}`, text: unsafe }));
    const view = turnRewindPanelView({
      candidates,
      inventory: {
        scannedEntries: Number.MAX_SAFE_INTEGER,
        shown: Number.MAX_SAFE_INTEGER,
        truncated: true,
        scanTruncated: true,
        candidateTruncated: true,
      },
      latest: {
        status: "failed",
        target: { entryId: unsafe, text: unsafe },
        cancelled: false,
        summarized: "yes",
        editorText: unsafe,
        error: unsafe,
        requestedAt: unsafe,
        startedAt: unsafe,
        finishedAt: unsafe,
      },
      limits: {
        candidates: 999_999,
        scannedEntries: 999_999,
        contentParts: 999_999,
        previewCharacters: 999_999,
        entryIdCharacters: 999_999,
        editorTextCharacters: 999_999,
        errorCharacters: 999_999,
      },
    });

    expect(view.candidates).toHaveLength(8);
    expect(view.candidates[0]?.entryId.startsWith("92-")).toBe(true);
    expect(view.candidates[0]?.entryId).toHaveLength(200);
    expect(view.candidates[0]?.text).toHaveLength(500);
    expect(view.candidates[0]?.entryId).not.toContain("\0");
    expect(view.inventory).toEqual({
      scannedEntries: 0,
      shown: 0,
      truncated: true,
      scanTruncated: true,
      candidateTruncated: true,
      displayTruncated: true,
    });
    expect(view.latest).toMatchObject({
      status: "failed",
      cancelled: false,
      summarized: false,
      requestedAt: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(view.latest?.target.entryId).toHaveLength(200);
    expect(view.latest?.target.text).toHaveLength(500);
    expect(view.latest?.editorText).toHaveLength(4_096);
    expect(view.latest?.error).toHaveLength(2_000);
    expect(view.limits).toEqual({
      candidates: 50,
      displayCandidates: 8,
      scannedEntries: 4_096,
      contentParts: 1_000,
      previewCharacters: 500,
      entryIdCharacters: 200,
      editorTextCharacters: 4_096,
      errorCharacters: 2_000,
    });
  });

  it("does not execute candidate array or nested object accessors", () => {
    let accessed = false;
    const candidates = Array.from({ length: 9 }, (_, index) => ({ entryId: `u${index}`, text: `turn ${index}` })) as unknown[];
    Object.defineProperty(candidates, "8", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("candidate array getter executed");
      },
    });
    const hostile = {};
    Object.defineProperty(hostile, "text", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("candidate text getter executed");
      },
    });
    Object.defineProperty(candidates, "7", { enumerable: true, value: hostile });

    expect(() => turnRewindPanelView({ candidates })).not.toThrow();
    const view = turnRewindPanelView({ candidates });
    expect(accessed).toBe(false);
    expect(view.candidates).toHaveLength(6);
    expect(view.candidates[0]).toEqual({ entryId: "u1", text: "turn 1" });
  });
});
