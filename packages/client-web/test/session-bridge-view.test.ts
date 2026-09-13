import { describe, expect, it } from "vitest";
import { sessionBridgePanelView } from "../src/session-bridge-view.js";

describe("Session Bridge view", () => {
  it("preserves the package truncation marker for the control-room warning", () => {
    const view = sessionBridgePanelView({
      latestPreview: {
        source: { sessionId: "source", cwd: "/workspace" },
        preview: { goal: "Goal", currentState: "State", decisions: [], keyFiles: [], nextStep: "Test" },
        truncated: true,
        at: "2026-09-05T10:01:00.000Z",
      },
      currentPreview: { goal: "", currentState: "", decisions: [], keyFiles: [], nextStep: "" },
    });
    expect(view.previewTruncated).toBe(true);
  });

  it("normalizes the latest handoff preview and operation summary", () => {
    expect(
      sessionBridgePanelView({
        latest: { direction: "export", sessionId: "source", messages: 3, attachments: 1, at: "2026-09-05T10:00:00.000Z" },
        latestPreview: {
          source: { sessionId: "source", cwd: "/workspace", model: { provider: "fixture", modelId: "model" } },
          preview: { goal: "Goal", currentState: "State", decisions: ["Keep API"], keyFiles: ["src/index.ts"], nextStep: "Test" },
          at: "2026-09-05T10:01:00.000Z",
        },
        currentPreview: { goal: "Current goal", currentState: "Current state", decisions: [], keyFiles: [], nextStep: "Current next" },
        status: { state: "completed", operation: "preview", at: "2026-09-05T10:02:00.000Z" },
        formatVersion: 1,
        limits: {
          packageBytes: 262_144,
          packageCharacters: 262_144,
          messages: 100,
          messageCharacters: 16_000,
          totalMessageCharacters: 64_000,
          contentParts: 1_000,
          attachments: 100,
          attachmentMarkerCharacters: 256,
          sessionIdCharacters: 256,
          cwdCharacters: 4_096,
          modelFieldCharacters: 256,
          previewTextCharacters: 1_000,
          previewListItems: 8,
          duplicateScanEntries: 10_000,
          operationErrorCharacters: 2_000,
        },
      }),
    ).toMatchObject({
      latest: { direction: "export", sessionId: "source", messages: 3, attachments: 1, at: "2026-09-05T10:00:00.000Z" },
      source: { sessionId: "source", cwd: "/workspace", model: { provider: "fixture", modelId: "model" } },
      preview: { goal: "Goal", currentState: "State", decisions: ["Keep API"], keyFiles: ["src/index.ts"], nextStep: "Test" },
      previewAt: "2026-09-05T10:01:00.000Z",
      status: { state: "completed", operation: "preview", at: "2026-09-05T10:02:00.000Z", error: null },
      formatVersion: 1,
      limits: {
        messages: 100,
        attachments: 100,
        previewTextCharacters: 1_000,
        previewListItems: 8,
        duplicateScanEntries: 10_000,
        operationErrorCharacters: 2_000,
      },
    });
  });

  it("enforces fixed browser caps on hostile nested preview data", () => {
    const long = "x".repeat(20_000);
    const view = sessionBridgePanelView({
      latest: { direction: "erase", sessionId: long, messages: 999, attachments: 999, at: long },
      latestPreview: { source: { sessionId: long, cwd: long, model: { provider: long, modelId: long } }, preview: "invalid", at: long },
      currentPreview: { goal: long, currentState: long, decisions: Array(20).fill(long), keyFiles: Array(20).fill(long), nextStep: long },
      status: { state: "failed", operation: "import", at: "2026-09-05T10:03:00.000Z", error: long },
      formatVersion: 999,
      limits: {
        packageBytes: 9_999_999,
        packageCharacters: 9_999_999,
        messages: 999,
        messageCharacters: 99_999,
        totalMessageCharacters: 99_999,
        contentParts: 99_999,
        attachments: 999,
        attachmentMarkerCharacters: 9_999,
        sessionIdCharacters: 9_999,
        cwdCharacters: 99_999,
        modelFieldCharacters: 9_999,
        previewTextCharacters: 9_999,
        previewListItems: 99,
        duplicateScanEntries: 99_999,
        operationErrorCharacters: 99_999,
      },
    });
    expect(view?.latest).toBeNull();
    expect(view?.source).toBeNull();
    expect(view?.preview.goal).toHaveLength(1_000);
    expect(view?.preview.currentState).toHaveLength(1_000);
    expect(view?.preview.nextStep).toHaveLength(1_000);
    expect(view?.preview.decisions).toHaveLength(8);
    expect(view?.preview.keyFiles).toHaveLength(8);
    expect(view?.preview.decisions[0]).toHaveLength(1_000);
    expect(view?.formatVersion).toBe(1);
    expect(view?.status).toEqual({ state: "failed", operation: "import", at: "2026-09-05T10:03:00.000Z", error: "x".repeat(2_000) });
    expect(view?.limits).toMatchObject({
      packageBytes: 262_144,
      messages: 100,
      messageCharacters: 16_000,
      totalMessageCharacters: 64_000,
      contentParts: 1_000,
      attachments: 100,
      previewTextCharacters: 1_000,
      previewListItems: 8,
      duplicateScanEntries: 10_000,
      operationErrorCharacters: 2_000,
    });
  });
});
