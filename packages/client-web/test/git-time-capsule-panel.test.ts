import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("does not invent zero-file completion metadata for cancelled restore", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "git-time-capsule-panel",
        pluginId: "@pi-harness/plugin-git-time-capsule",
        title: "Git Time Capsule",
        data: {
          latest: { action: "restore", status: "cancelled", at: "2026-09-10T12:00:00.000Z", error: "Inspect the workspace before retrying." },
          capsules: [],
          inventory: { total: 0, shown: 0, truncated: false, displayLimit: 20 },
          timeoutMs: 15000,
          limits: { capsuleBytes: 8388608, inventory: 256, directoryEntries: 4096 },
        },
      },
    }),
  );
  expect(html).toContain("Inspect the workspace before retrying.");
  expect(html).toContain("已取消");
  expect(html).not.toContain("0 bytes");
});
