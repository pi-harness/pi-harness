import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

const render = (data: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "synapse-panel", pluginId: "@pi-harness/plugin-synapse", title: "Synapse", data },
    }),
  );

test("labels header-only sessions without claiming they contain zero messages", () => {
  const html = render({
    cwd: "/workspace",
    total: 1,
    truncated: false,
    metadataTruncated: 1,
    nodes: [{ id: "large", label: "large", cwd: "/workspace", messageCount: 0, messagesTruncated: true, active: true, branchCount: 0 }],
    edges: [],
    orphanCount: 0,
  });

  expect(html).toContain("消息元数据未扫描（文件超过 4 MiB）");
  expect(html).toContain("1 个会话的消息元数据未扫描");
  expect(html).not.toContain("0 条消息");
});
