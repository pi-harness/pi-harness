import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test.each(["running", "failed", "cancelled"])("does not show a retained pass during %s verification", (status) => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "change-verifier-panel",
        pluginId: "@pi-harness/plugin-change-verifier",
        title: "Change Verifier",
        data: {
          status,
          lastError: status === "running" ? null : "Synthetic provider failed",
          runs: 1,
          latest: { status: "pass", tests: { exitCode: 0 }, review: { status: "pass" } },
        },
      },
    }),
  );
  expect(html).not.toContain("门禁通过");
  if (status !== "running") expect(html).toContain("Synthetic provider failed");
});
