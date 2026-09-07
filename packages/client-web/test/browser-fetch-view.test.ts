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

  test("keeps multi-line document previews and neutralizes unsafe code points", () => {
    const view = browserFetchPanelView({
      latest: {
        url: "https://example.com/start",
        finalUrl: "https://example.com/start",
        status: 200,
        contentType: "text/html",
        bytes: 38,
        truncated: false,
        previewTruncated: false,
        text: "<html>\n\t<body>hi\u0000\u200B</body>\r\n</html>",
      },
      allowPrivate: false,
      maxResponseBytes: 512 * 1024,
      maxPanelTextChars: 12_000,
      maxRedirects: 3,
      timeoutMs: 20_000,
    });

    expect(view.malformed).toBe(false);
    expect(view.latest?.text).toBe("<html>\n\t<body>hi\uFFFD\uFFFD</body>\r\n</html>");
    expect(view.latest).toMatchObject({ status: 200, bytes: 38, truncated: false, previewTruncated: false });
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

  test("keeps line breaks and tabs in the fetched page preview while metadata fields stay strict", () => {
    const pageText = "Example Domain\n\nThis domain is for use in illustrative examples.\n\tMore information...\r\n";
    const payload = {
      latest: {
        url: "https://example.com/",
        finalUrl: "https://example.com/",
        status: 200,
        contentType: "text/html; charset=utf-8",
        bytes: 1_256,
        truncated: false,
        previewTruncated: false,
        text: pageText,
      },
      allowPrivate: false,
      maxResponseBytes: 512 * 1024,
      maxPanelTextChars: 12_000,
      maxRedirects: 3,
      timeoutMs: 20_000,
    };

    expect(browserFetchPanelView(payload)).toMatchObject({ malformed: false, latest: { text: pageText, previewTruncated: false } });
    expect(browserFetchPanelView({ ...payload, latest: { ...payload.latest, text: "page\u0000break" } })).toMatchObject({
      malformed: false,
      latest: { text: "page\uFFFDbreak" },
    });
    expect(browserFetchPanelView({ ...payload, latest: { ...payload.latest, text: "page\u2028break" } })).toMatchObject({
      malformed: false,
      latest: { text: "page\uFFFDbreak" },
    });
    expect(browserFetchPanelView({ ...payload, latest: { ...payload.latest, url: "https://example.com/\nevil" } }).malformed).toBe(true);
    expect(browserFetchPanelView({ ...payload, latest: { ...payload.latest, finalUrl: "https://example.com/\tevil" } }).malformed).toBe(true);
    expect(browserFetchPanelView({ ...payload, latest: { ...payload.latest, contentType: "text/html\n" } }).malformed).toBe(true);
  });
});
