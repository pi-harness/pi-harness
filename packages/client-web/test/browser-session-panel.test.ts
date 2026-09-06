import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

function renderPanel(data: unknown): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "browser-session-panel", pluginId: "@pi-harness/core/plugins/browser-session", title: "Browser Session", data },
    }),
  );
}

const limits = { tabs: 20, textPreviewCharacters: 12_000, errorCharacters: 2_000 };

describe("Browser Session panel", () => {
  test("renders a validated connected session", () => {
    const html = renderPanel({
      endpoint: "http://127.0.0.1:9222/",
      connected: true,
      error: null,
      tabs: [{ targetId: "one", title: "Pi Harness", url: "http://127.0.0.1:3081" }],
      inventory: { total: 1, shown: 1, truncated: false },
      limits,
      latest: {
        targetId: "one",
        title: "Pi Harness",
        url: "http://127.0.0.1:3081",
        status: "read",
        truncated: false,
        previewTruncated: false,
        text: "page",
        clicked: false,
      },
    });
    expect(html).toContain("已连接");
    expect(html).toContain("page");
    expect(html).not.toContain("面板数据异常");
  });

  test("fails closed for malformed session payload", () => {
    const html = renderPanel({
      endpoint: "http://127.0.0.1:9222",
      connected: true,
      error: null,
      tabs: [],
      inventory: { total: 1, shown: 1, truncated: false },
      limits,
      latest: null,
    });
    expect(html).toContain("Browser Session 面板数据异常");
    expect(html).toContain("面板数据不完整或不可信");
    expect(html).not.toContain("已连接");
  });
});
