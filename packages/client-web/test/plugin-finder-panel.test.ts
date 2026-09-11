import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("shows every returned plugin instead of silently losing results after the fifth", () => {
  const results = Array.from({ length: 25 }, (_, index) => ({ name: `pi-example-${index}`, version: "1.0.0", description: `Capability ${index}` }));
  const html = renderToStaticMarkup(createElement(PluginPanelCard, { panel: {
    id: "plugin-finder-panel", pluginId: "@pi-harness/plugin-plugin-finder", title: "Plugin Finder",
    data: { query: "example", total: 25, registryTotal: 25, truncated: false, results },
  } }));
  for (const result of results) expect(html).toContain(result.name);
});
