import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

function renderPanel(data: unknown): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "docker-sandbox-panel", pluginId: "@pi-harness/core/plugins/docker-sandbox", title: "Docker Sandbox", data },
    }),
  );
}

const defaults = {
  image: "alpine:3.20",
  pull: "never",
  network: "none",
  rootFilesystem: "read-only",
  workspace: "read-only",
  memory: "512m",
  cpus: 1,
  pids: 256,
  timeoutMs: 120_000,
};

describe("Docker sandbox panel", () => {
  test("renders a validated run and enforced defaults", () => {
    const html = renderPanel({
      latest: { image: "alpine:3.20", command: ["node", "--version"], write: false, exitCode: 0, status: "completed", output: "v22.0.0\n" },
      defaults,
    });
    expect(html).toContain("alpine:3.20");
    expect(html).toContain("2 个 argv 参数");
    expect(html).toContain("network:none");
    expect(html).not.toContain("面板数据异常");
  });

  test("renders an explicit error for malformed panel data", () => {
    const html = renderPanel({ defaults: { ...defaults, network: "host" }, latest: null });
    expect(html).toContain("Docker Sandbox 面板数据异常");
    expect(html).toContain("面板数据不完整或不可信");
    expect(html).not.toContain("还没有沙箱运行");
  });
});
