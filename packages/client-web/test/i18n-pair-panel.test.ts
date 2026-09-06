import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

function renderPanel(data: unknown): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "i18n-pair-panel",
        pluginId: "@pi-harness/core/plugins/i18n-pair",
        title: "I18n Pair",
        data,
      },
    }),
  );
}

function complete(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: { state: "completed", at: "2026-09-05T01:00:00.000Z" },
    report: {
      base: "locales/en.json",
      target: "locales/ja.json",
      baseKeys: 3,
      targetKeys: 2,
      missing: ["actions.cancel"],
      extra: [],
      missingTotal: 1,
      extraTotal: 0,
      truncated: false,
    },
    limits: { fileBytes: 4_194_304, depth: 128, keysPerFile: 50_000, flattenedKeyLength: 2_048, pathLength: 4_096, panelKeysPerSide: 100 },
    ...overrides,
  };
}

describe("I18n pair panel", () => {
  test("renders validated parity counts, paths, keys, status, and limits", () => {
    const html = renderPanel(complete());

    for (const expected of ["已完成", "缺失 1 个，额外 0 个", "locales/en.json", "locales/ja.json", "actions.cancel", "file:4MiB", "depth:128", "keys:50000"])
      expect(html).toContain(expected);
    expect(html).not.toContain("面板数据不完整或不可信");
  });

  test("retains the last valid report while showing a later failure", () => {
    const html = renderPanel(complete({ status: { state: "failed", at: "2026-09-05T01:01:00.000Z", error: "Invalid locale JSON" } }));

    expect(html).toContain("检查失败");
    expect(html).toContain("Invalid locale JSON");
    expect(html).toContain("actions.cancel");
  });

  test("fails closed for malformed data without manufacturing success counts", () => {
    const html = renderPanel(complete({ report: { baseKeys: 0, targetKeys: 0, missing: [], extra: [] } }));

    expect(html).toContain("数据异常");
    expect(html).toContain("面板数据不完整或不可信");
    expect(html).not.toContain("语言包键完全一致");
    expect(html).not.toContain("基准键");
    expect(html).not.toContain("目标键");
  });

  test("renders a useful untouched state", () => {
    const html = renderPanel(complete({ status: { state: "idle" }, report: null }));

    expect(html).toContain("等待检查");
    expect(html).toContain("还没有检查语言包");
    expect(html).toContain("i18n_check");
  });
});
