import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("keeps bookmarks beyond the twelfth accessible in the panel", () => {
  const bookmarks = Array.from({ length: 25 }, (_, index) => ({ id: `entry-${index}`, entryId: `entry-${index}`, label: `Bookmark ${index + 1}` }));
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "session-bookmarks-panel", pluginId: "@pi-harness/plugin-session-bookmarks", title: "Session Bookmarks", data: { total: bookmarks.length, bookmarks } },
    }),
  );
  for (const bookmark of bookmarks) {
    expect(html).toContain(`>${bookmark.label}</strong>`);
    expect(html).toContain(`entry: ${bookmark.entryId}</code>`);
  }
});
