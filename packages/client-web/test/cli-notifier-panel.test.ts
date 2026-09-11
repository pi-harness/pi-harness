import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("reports command submission without claiming desktop delivery", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "cli-notifier-panel",
        pluginId: "@pi-harness/plugin-cli-notifier",
        title: "CLI Notifier",
        data: { enabled: true, notifications: [{ title: "Synthetic", message: "Notification", delivered: true }] },
      },
    }),
  );
  expect(html).toContain("已提交系统");
  expect(html).not.toContain("已送达");
  expect(html).toContain("不代表通知已显示或已读");
});
