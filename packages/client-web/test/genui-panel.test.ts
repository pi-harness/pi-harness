import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("allows long GenUI text to wrap without expanding the grid's minimum width", () => {
  const html = renderToStaticMarkup(createElement(PluginPanelCard, { panel: {
    id: "genui-panel", pluginId: "@pi-harness/plugin-genui", title: "GenUI",
    data: { rendered: 1, latest: { title: "Layout audit", blocks: [
      { type: "text", label: "Long text", value: "X".repeat(2100), tone: "neutral" },
    ] } },
  } }));
  expect(html).toContain("面板明细已截断");
  expect(html).toMatch(/<p class="[^"]*\[overflow-wrap:anywhere\][^"]*">X/u);
});
