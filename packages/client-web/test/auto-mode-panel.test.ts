import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("shows stderr and failure exit status even when stdout is nonempty", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "auto-mode-panel",
        pluginId: "@pi-harness/plugin-auto-mode",
        title: "Auto Mode",
        data: { mode: "safe", last: { command: ["fixture"], exitCode: 1, stdout: "PARTIAL_OUTPUT", stderr: "TIMEOUT_DIAGNOSTIC" } },
      },
    }),
  );
  expect(html).toContain("PARTIAL_OUTPUT");
  expect(html).toContain("TIMEOUT_DIAGNOSTIC");
  expect(html).toContain("exit 1");
});
