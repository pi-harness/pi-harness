import { describe, expect, test } from "vitest";
import { browserFetchPanelView } from "../src/browser-fetch-view.js";

describe("browser fetch panel view", () => {
  test("normalizes a successful fetch and its production limits", () => {
    expect(
      browserFetchPanelView({
        latest: {
          url: "https://example.com/start",
          finalUrl: "https://example.com/final",
          status: 200,
          contentType: "text/html",
          bytes: 42,
          truncated: false,
          previewTruncated: true,
          text: "page",
        },
        allowPrivate: false,
        maxResponseBytes: 512 * 1024,
        maxPanelTextChars: 12_000,
        maxRedirects: 3,
        timeoutMs: 20_000,
      }),
    ).toEqual({
      latest: {
        url: "https://example.com/start",
        finalUrl: "https://example.com/final",
        status: 200,
        contentType: "text/html",
        bytes: 42,
        truncated: false,
        previewTruncated: true,
        text: "page",
      },
      allowPrivate: false,
      limits: { responseBytes: 512 * 1024, panelTextChars: 12_000, redirects: 3, timeoutMs: 20_000 },
      malformed: false,
    });
  });

  test("bounds valid large previews while preserving validated totals", () => {
    const longUrl = "x".repeat(4_096);
    const longContentType = "x".repeat(256);
    const long = "x".repeat(20_000);
    const view = browserFetchPanelView({
      latest: {
        url: longUrl,
        finalUrl: longUrl,
        status: 200,
        contentType: longContentType,
        bytes: 42,
        truncated: false,
        previewTruncated: false,
        text: long,
      },
      allowPrivate: false,
      maxResponseBytes: 512 * 1024,
      maxPanelTextChars: 12_000,
      maxRedirects: 3,
      timeoutMs: 20_000,
    });

    expect(view.latest?.url).toHaveLength(4_096);
    expect(view.latest?.finalUrl).toHaveLength(4_096);
    expect(view.latest?.contentType).toHaveLength(256);
    expect(view.latest?.text).toHaveLength(12_000);
    expect(view.latest).toMatchObject({ status: 200, bytes: 42, truncated: false, previewTruncated: true });
    expect(view.allowPrivate).toBe(false);
    expect(view.limits).toEqual({ responseBytes: 512 * 1024, panelTextChars: 12_000, redirects: 3, timeoutMs: 20_000 });
    expect(view.malformed).toBe(false);
  });

  test("fails closed for malformed or accessor-backed payloads", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "latest", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return null;
      },
    });
    expect(
      browserFetchPanelView({ latest: null, allowPrivate: false, maxResponseBytes: -1, maxPanelTextChars: 12_000, maxRedirects: 3, timeoutMs: 20_000 })
        .malformed,
    ).toBe(true);
    expect(browserFetchPanelView(accessor).malformed).toBe(true);
    expect(getterCalls).toBe(0);
  });
});
