import { describe, expect, it } from "vitest";
import { browserSessionPanelView, browserSessionTabs } from "../src/browser-session-view.js";

const defaults = { tabs: 20, textPreviewCharacters: 12_000, errorCharacters: 2_000 } as const;

describe("browser session view", () => {
  it("keeps valid tabs bounded and preserves browser order", () => {
    expect(
      browserSessionTabs(
        [
          { targetId: "one", title: "Pi Harness", url: "http://127.0.0.1:3081" },
          { targetId: "", title: "invalid", url: "http://invalid" },
          { targetId: "two", title: "Docs", url: "https://example.com" },
        ],
        1,
      ),
    ).toEqual([{ targetId: "one", title: "Pi Harness", url: "http://127.0.0.1:3081" }]);
  });

  it("normalizes a complete browser session panel payload", () => {
    expect(
      browserSessionPanelView({
        endpoint: "http://127.0.0.1:9222/",
        connected: true,
        error: null,
        tabs: [{ targetId: "one", title: "Pi Harness", url: "http://127.0.0.1:3081" }],
        inventory: { total: 3, shown: 1, truncated: true },
        limits: { tabs: 20, textPreviewCharacters: 12_000, errorCharacters: 2_000 },
        latest: {
          targetId: "one",
          title: "Pi Harness",
          url: "http://127.0.0.1:3081",
          status: "read",
          truncated: false,
          previewTruncated: true,
          text: "page text",
          clicked: false,
          screenshot: { bytes: 8, mimeType: "image/png" },
        },
      }),
    ).toEqual({
      endpoint: "http://127.0.0.1:9222/",
      connected: true,
      error: null,
      tabs: [{ targetId: "one", title: "Pi Harness", url: "http://127.0.0.1:3081" }],
      inventory: { total: 3, shown: 1, truncated: true },
      limits: { tabs: 20, textPreviewCharacters: 12_000, errorCharacters: 2_000 },
      latest: {
        targetId: "one",
        title: "Pi Harness",
        url: "http://127.0.0.1:3081",
        status: "read",
        truncated: false,
        previewTruncated: true,
        text: "page text",
        clicked: false,
        screenshot: { bytes: 8, mimeType: "image/png" },
      },
      malformed: false,
    });
  });

  it("keeps multi-line page text and neutralizes format code points in tab titles", () => {
    const title = "\u{1F469}\u200D\u{1F4BB} Dashboard";
    const view = browserSessionPanelView({
      endpoint: "http://127.0.0.1:9222/",
      connected: true,
      error: null,
      tabs: [{ targetId: "one", title, url: "https://a.example/" }],
      inventory: { total: 1, shown: 1, truncated: false },
      limits: defaults,
      latest: {
        targetId: "one",
        title,
        url: "https://a.example/",
        status: "read",
        truncated: false,
        previewTruncated: false,
        text: "line1\nline2",
        clicked: false,
      },
    });

    expect(view.malformed).toBe(false);
    expect(view.tabs).toEqual([{ targetId: "one", title: "\u{1F469}\uFFFD\u{1F4BB} Dashboard", url: "https://a.example/" }]);
    expect(view.inventory).toEqual({ total: 1, shown: 1, truncated: false });
    expect(view.latest?.text).toBe("line1\nline2");
    expect(view.latest?.title).toBe("\u{1F469}\uFFFD\u{1F4BB} Dashboard");
  });

  it("fails closed for malformed panel fields instead of inventing defaults", () => {
    const long = "x".repeat(20_000);
    const view = browserSessionPanelView({
      endpoint: long,
      connected: "yes",
      error: long,
      tabs: [
        { targetId: "", title: "invalid", url: "https://invalid.example" },
        ...Array.from({ length: 20 }, (_, index) => ({ targetId: `${index}-${long}`, title: long, url: long })),
      ],
      inventory: { total: 999, shown: 999, truncated: false },
      limits: { tabs: -1, textPreviewCharacters: Number.POSITIVE_INFINITY, errorCharacters: 99_999 },
      latest: {
        targetId: long,
        title: long,
        url: long,
        status: long,
        truncated: "yes",
        previewTruncated: false,
        text: long,
        clicked: "yes",
        screenshot: { bytes: -1, mimeType: long, data: long },
      },
    });

    expect(view).toMatchObject({ malformed: true, latest: null, tabs: [], connected: false });
  });

  it("fails closed for accessors and unknown root properties", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "latest", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return null;
      },
    });
    expect(browserSessionPanelView(accessor).malformed).toBe(true);
    expect(
      browserSessionPanelView({
        endpoint: "http://127.0.0.1:9222",
        connected: false,
        error: null,
        tabs: [],
        inventory: { total: 0, shown: 0, truncated: false },
        limits: defaults,
        latest: null,
        extra: true,
      }).malformed,
    ).toBe(true);
    expect(getterCalls).toBe(0);
  });

  it("keeps line breaks and tabs in the extracted page text while tab identifiers stay strict", () => {
    const pageText = "Pi Harness\n\nSection\tvalue\r\nEnd";
    const payload = {
      endpoint: "http://127.0.0.1:9222/",
      connected: true,
      error: null,
      tabs: [{ targetId: "one", title: "Pi Harness", url: "http://127.0.0.1:3081" }],
      inventory: { total: 1, shown: 1, truncated: false },
      limits: { ...defaults },
      latest: {
        targetId: "one",
        title: "Pi Harness",
        url: "http://127.0.0.1:3081",
        status: "read",
        truncated: false,
        previewTruncated: false,
        text: pageText,
        clicked: false,
      },
    };

    expect(browserSessionPanelView(payload)).toMatchObject({ malformed: false, latest: { text: pageText, previewTruncated: false } });
    expect(browserSessionPanelView({ ...payload, latest: { ...payload.latest, text: "page\u0000break" } })).toMatchObject({
      malformed: false,
      latest: { text: "page\uFFFDbreak" },
    });
    expect(browserSessionPanelView({ ...payload, latest: { ...payload.latest, text: "page\u2029break" } })).toMatchObject({
      malformed: false,
      latest: { text: "page\uFFFDbreak" },
    });
    expect(browserSessionPanelView({ ...payload, latest: { ...payload.latest, title: "Pi\nHarness" } })).toMatchObject({
      malformed: false,
      latest: { title: "Pi\uFFFDHarness" },
    });
    expect(browserSessionPanelView({ ...payload, latest: { ...payload.latest, url: "http://127.0.0.1:3081\n" } }).malformed).toBe(true);
    expect(browserSessionPanelView({ ...payload, latest: { ...payload.latest, targetId: "one\ntwo" } }).malformed).toBe(true);
    expect(browserSessionPanelView({ ...payload, tabs: [{ targetId: "one", title: "Pi Harness", url: "http://127.0.0.1:3081\n" }] }).malformed).toBe(true);
  });
});
