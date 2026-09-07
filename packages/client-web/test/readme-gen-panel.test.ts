import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

function renderPanel(data: unknown): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "readme-gen-panel",
        pluginId: "@pi-harness/plugin-readme-gen",
        title: "README Generator",
        data,
      },
    }),
  );
}

function complete(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generated: true,
    name: "@scope/demo",
    scripts: 4,
    plugins: 12,
    lastWrite: { path: "docs/README.generated.md", bytes: 4_096, overwritten: false },
    status: { state: "completed", operation: "write", at: "2026-09-06T00:00:00.000Z" },
    ...overrides,
  };
}

describe("README generator panel", () => {
  test("renders the validated generation summary, write receipt, and status", () => {
    const html = renderPanel(complete());

    for (const expected of ["@scope/demo", "4 个脚本", "12 个运行时插件", "docs/README.generated.md", "4,096 bytes", "新文件", "写入已完成"]) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain("README 面板数据无效");
  });

  test("renders actionable failure state without hiding the last good draft", () => {
    const html = renderPanel(
      complete({
        lastWrite: null,
        status: { state: "failed", operation: "write", at: "2026-09-06T00:00:00.000Z", error: "overwrite=true is required" },
      }),
    );

    expect(html).toContain("@scope/demo");
    expect(html).toContain("写入失败");
    expect(html).toContain("overwrite=true is required");
  });

  test("renders a useful untouched state", () => {
    const html = renderPanel({ generated: false, lastWrite: null, status: { state: "idle" } });

    expect(html).toContain("还没有生成 README 草稿");
    expect(html).toContain("readme_report");
    expect(html).not.toContain("README 面板数据无效");
  });

  test("fails closed for malformed data instead of showing zero-valued success", () => {
    const html = renderPanel(complete({ scripts: -1, plugins: Number.NaN }));

    expect(html).toContain("README 面板数据无效");
    expect(html).not.toContain("0 个脚本");
    expect(html).not.toContain("README.generated.md");
    expect(html).not.toContain("写入已完成");
  });

  test("wraps maximum-length names and paths", () => {
    const name = "n".repeat(256);
    const path = `${"d".repeat(499)}/README.md`;
    const html = renderPanel(complete({ name, lastWrite: { path, bytes: 1, overwritten: true } }));

    expect(html).toContain(name);
    expect(html).toContain(path);
    expect(html).toMatch(/class="[^"]*break-all[^"]*"[^>]*>n{256}</u);
    expect(html).toMatch(/class="[^"]*break-all[^"]*"[^>]*>d{499}/u);
  });
});
