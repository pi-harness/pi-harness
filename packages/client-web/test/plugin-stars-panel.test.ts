import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

function renderPanel(data: unknown): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "plugin-stars-panel", pluginId: "@pi-harness/core/plugins/plugin-stars", title: "Plugin Stars", data },
    }),
  );
}

const limits = { responseBytes: 2_097_152, sourceItems: 1_000, resultItems: 10, panelItems: 20, queryCharacters: 120, timeoutMs: 15_000 };

describe("Plugin Stars panel", () => {
  test("renders a validated ranking", () => {
    const html = renderPanel({
      source: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json",
      limit: 10,
      timeoutMs: 15_000,
      latest: {
        source: "fixture",
        generatedAt: "2026-09-05T00:00:00Z",
        total: 1,
        query: "",
        fetchedAt: "2026-09-05T00:01:00Z",
        results: [{ fullName: "owner/fixture", name: "fixture", stars: 2, htmlUrl: "https://github.com/owner/fixture", updatedAt: "2026-09-05" }],
      },
      inventory: { total: 1, shown: 1, truncated: false },
      limits,
    });
    expect(html).toContain("owner/fixture");
    expect(html).toContain("★ 2");
    expect(html).not.toContain("面板数据异常");
  });

  test("fails closed for malformed ranking metadata", () => {
    const html = renderPanel({ source: "fixture", limit: 10, timeoutMs: 15_000, latest: null, inventory: { total: 1, shown: 0, truncated: false }, limits });
    expect(html).toContain("Plugin Stars 面板数据异常");
    expect(html).toContain("面板数据不完整或不可信");
    expect(html).not.toContain("社区排行榜");
  });
});
