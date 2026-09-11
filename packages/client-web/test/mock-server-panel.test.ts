import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("shows the mock server request error without interpreting it as markup", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "mock-server-panel",
        pluginId: "@pi-harness/plugin-mock-server",
        title: "Mock Server",
        data: { running: true, url: "http://127.0.0.1:12345", routes: 1, lastRequest: null, lastError: "Invalid URL <script>inert</script>" },
      },
    }),
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain("Invalid URL &lt;script&gt;inert&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});

test("does not show an error alert after the server clears its error", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "mock-server-panel",
        pluginId: "@pi-harness/plugin-mock-server",
        title: "Mock Server",
        data: { running: true, url: "http://127.0.0.1:12345", routes: 1, lastRequest: "GET /ok", lastError: null },
      },
    }),
  );
  expect(html).not.toContain('role="alert"');
});
