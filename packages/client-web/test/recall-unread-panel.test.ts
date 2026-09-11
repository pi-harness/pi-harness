import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

describe("Recall Unread panel", () => {
  test("keeps bounded long previews wrappable inside the grid", () => {
    const message = "X".repeat(500);
    const html = renderToStaticMarkup(
      createElement(PluginPanelCard, {
        panel: {
          id: "recall-unread-panel",
          pluginId: "@pi-harness/plugin-recall-unread",
          title: "Recall Unread",
          data: {
            total: 1,
            items: [{ id: "audit", name: "Audit", message, messageCount: 1 }],
            inventory: { available: 1, candidates: 1, scanned: 1, unread: 1, shown: 1 },
            status: { state: "completed", at: "2026-09-09T00:00:00.000Z" },
          },
        },
      }),
    );
    expect(html).toContain(message);
    expect(html).toMatch(/<p class="[^"]*\[overflow-wrap:anywhere\][^"]*">X/u);
    expect(html).not.toMatch(/<p class="[^"]*break-words[^"]*">X/u);
  });
});
