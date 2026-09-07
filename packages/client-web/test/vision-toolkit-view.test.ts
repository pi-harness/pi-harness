import { describe, expect, test } from "vitest";
import { visionToolkitPanelView } from "../src/vision-toolkit-view.js";

describe("Vision Toolkit panel view", () => {
  test("normalizes a completed bounded catalog", () => {
    const view = visionToolkitPanelView({
      status: { state: "completed", operation: "catalog", count: 1, truncated: false, at: "2026-09-06T00:00:00.000Z" },
      report: {
        assets: [{ path: "design/hero.png", mimeType: "image/png", bytes: 24, width: 320, height: 180, headerTruncated: false }],
        issues: [],
        inspectedCandidates: 1,
        scannedEntries: 2,
        scannedDirectories: 1,
        truncated: false,
        issuesTruncated: false,
      },
      supportedTypes: ["gif", "jpeg", "jpg", "png", "webp"],
      limits: {
        imageBytes: 20_971_520,
        headerBytes: 262_144,
        pathCharacters: 4_096,
        assets: 100,
        imageCandidates: 256,
        scannedEntries: 4_096,
        scannedDirectories: 512,
        depth: 16,
        issues: 20,
        issueCharacters: 500,
        agentTextBytes: 16_384,
      },
    });

    expect(view).toEqual({
      status: { state: "completed", operation: "catalog", count: 1, truncated: false, at: "2026-09-06T00:00:00.000Z" },
      report: {
        assets: [{ path: "design/hero.png", mimeType: "image/png", bytes: 24, width: 320, height: 180, headerTruncated: false }],
        issues: [],
        inspectedCandidates: 1,
        scannedEntries: 2,
        scannedDirectories: 1,
        truncated: false,
        issuesTruncated: false,
      },
      supportedTypes: ["png", "jpeg", "jpg", "gif", "webp"],
      limits: {
        imageBytes: 20_971_520,
        headerBytes: 262_144,
        pathCharacters: 4_096,
        assets: 100,
        imageCandidates: 256,
        scannedEntries: 4_096,
        scannedDirectories: 512,
        depth: 16,
        issues: 20,
        issueCharacters: 500,
        agentTextBytes: 16_384,
      },
      truncated: false,
    });
  });

  test("keeps a catalog whose issue came from an unreadable subdirectory", () => {
    const view = visionToolkitPanelView({
      status: { state: "completed", operation: "catalog", count: 3, truncated: false, at: "2026-09-06T00:00:00.000Z" },
      report: {
        assets: Array.from({ length: 3 }, (_, index) => ({
          path: `design/hero-${index}.png`,
          mimeType: "image/png",
          bytes: 24,
          width: 320,
          height: 180,
          headerTruncated: false,
        })),
        issues: [{ path: "protected", reason: "EACCES: permission denied" }],
        inspectedCandidates: 3,
        scannedEntries: 4,
        scannedDirectories: 2,
        truncated: false,
        issuesTruncated: false,
      },
      supportedTypes: ["gif", "jpeg", "jpg", "png", "webp"],
      limits: {
        imageBytes: 20_971_520,
        headerBytes: 262_144,
        pathCharacters: 4_096,
        assets: 100,
        imageCandidates: 256,
        scannedEntries: 4_096,
        scannedDirectories: 512,
        depth: 16,
        issues: 20,
        issueCharacters: 500,
        agentTextBytes: 16_384,
      },
    });

    expect(view.truncated).toBe(false);
    expect(view.report?.assets).toHaveLength(3);
    expect(view.report).toMatchObject({
      issues: [{ path: "protected", reason: "EACCES: permission denied" }],
      inspectedCandidates: 3,
      scannedEntries: 4,
      scannedDirectories: 2,
    });
  });

  test("fails closed without invoking accessors or revoked proxies", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "report", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { assets: [] };
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(() => visionToolkitPanelView(accessor)).not.toThrow();
    expect(() => visionToolkitPanelView(revocable.proxy)).not.toThrow();
    expect(getterCalls).toBe(0);
    expect(visionToolkitPanelView(accessor)).toMatchObject({ status: { state: "idle" }, report: null, truncated: true });
    expect(visionToolkitPanelView(revocable.proxy)).toMatchObject({ status: { state: "idle" }, report: null, truncated: true });
  });

  test("bounds hostile arrays and marks contradictory completion metadata", () => {
    const asset = { path: "hero.png", mimeType: "image/png", bytes: 24, width: 16, height: 9, headerTruncated: false };
    const poisonedIssues = new Proxy([], {
      getOwnPropertyDescriptor() {
        throw new Error("must not escape the normalizer");
      },
    });
    const base = {
      status: { state: "completed", operation: "catalog", count: 2, truncated: false, at: "2026-09-06T00:00:00.000Z" },
      report: {
        assets: Array.from({ length: 10_000 }, () => asset),
        issues: poisonedIssues,
        inspectedCandidates: 256,
        scannedEntries: 256,
        scannedDirectories: 1,
        truncated: false,
        issuesTruncated: false,
      },
      supportedTypes: ["png", "jpeg", "jpg", "gif", "webp"],
      limits: {
        imageBytes: 20_971_520,
        headerBytes: 262_144,
        pathCharacters: 4_096,
        assets: 100,
        imageCandidates: 256,
        scannedEntries: 4_096,
        scannedDirectories: 512,
        depth: 16,
        issues: 20,
        issueCharacters: 500,
        agentTextBytes: 16_384,
      },
    };

    expect(() => visionToolkitPanelView(base)).not.toThrow();
    expect(visionToolkitPanelView(base)).toMatchObject({ report: null, truncated: true });

    const contradictory = { ...base, report: { ...base.report, assets: [asset], issues: [] } };
    expect(visionToolkitPanelView(contradictory)).toMatchObject({ report: { assets: [asset] }, status: { count: 2 }, truncated: true });
  });

  test("rejects dimensions outside the represented image format", () => {
    const view = visionToolkitPanelView({
      status: { state: "completed", operation: "catalog", count: 1, truncated: false, at: "2026-09-06T00:00:00.000Z" },
      report: {
        assets: [{ path: "impossible.gif", mimeType: "image/gif", bytes: 10, width: 70_000, height: 1, headerTruncated: false }],
        issues: [],
        inspectedCandidates: 1,
        scannedEntries: 1,
        scannedDirectories: 1,
        truncated: false,
        issuesTruncated: false,
      },
      supportedTypes: ["png", "jpeg", "jpg", "gif", "webp"],
      limits: {
        imageBytes: 20_971_520,
        headerBytes: 262_144,
        pathCharacters: 4_096,
        assets: 100,
        imageCandidates: 256,
        scannedEntries: 4_096,
        scannedDirectories: 512,
        depth: 16,
        issues: 20,
        issueCharacters: 500,
        agentTextBytes: 16_384,
      },
    });

    expect(view).toMatchObject({ report: { assets: [] }, truncated: true });
  });
});
