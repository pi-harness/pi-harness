import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("labels retained review as historical and shows the current failure", () => {
  const html = renderToStaticMarkup(createElement(PluginPanelCard, { panel: {
    id: "reviewer-bot-panel", pluginId: "@pi-harness/plugin-reviewer-bot", title: "Reviewer Bot",
    data: { status: "failed", lastError: "Synthetic diff limit exceeded", latestStale: true,
      latest: { status: "pass", cwd: "/synthetic", changedFiles: 0, findingCount: 0, findings: [] } },
  } }));
  expect(html).toContain("Synthetic diff limit exceeded");
  expect(html).toContain("上次成功结果（非本次审阅）");
  expect(html).not.toContain("未命中检查规则");
  expect(html).not.toContain("border-[#b9e6c9]");
});
