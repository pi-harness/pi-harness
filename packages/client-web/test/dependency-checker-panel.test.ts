import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

const baseReport = {
  manifest: "package.json",
  ecosystem: "npm",
  declared: 1,
  installed: 1,
  scanLimit: 2_000,
  missing: [],
  optionalMissing: [],
  invalid: [],
  conflicts: [],
};

function renderDependencyPanel(report: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "dependency-checker-panel",
        pluginId: "@pi-harness/plugin-dependency-checker",
        title: "Dependency Checker",
        data: { report },
      },
    }),
  );
}

describe("dependency checker panel", () => {
  test("renders unresolved-only reports as an amber indeterminate state", () => {
    const html = renderDependencyPanel({
      ...baseReport,
      unresolved: [{ name: "shared", constraints: ["workspace:*", "^1.0.0"] }],
    });

    expect(html).toContain("未决");
    expect(html).toContain("1 组声明约束无法离线判定");
    expect(html).toContain("shared");
    expect(html).toContain("workspace:*");
    expect(html).not.toContain("依赖声明与本地安装一致");
  });

  test("does not render malformed or truncated reports as healthy", () => {
    const html = renderDependencyPanel({ ...baseReport, unresolved: [], unexpected: true });

    expect(html).toContain("报告不完整");
    expect(html).not.toContain("依赖声明与本地安装一致");
  });
});
