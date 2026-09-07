import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

function renderPanel(data: unknown): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "cleaner-panel",
        pluginId: "@pi-harness/plugin-cleaner",
        title: "Harness Cleaner",
        data,
      },
    }),
  );
}

function complete(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capsules: [{ name: "0003.patch", bytes: 128 }],
    inventory: { total: 1, shown: 1, truncated: false, displayLimit: 20 },
    lastCleanup: { status: "completed", at: "2026-09-05T01:00:00.000Z", requestedKeep: 1, removed: 2, kept: 1 },
    lastRemoved: 2,
    limits: { capsules: 256, directoryEntries: 4_096 },
    ...overrides,
  };
}

describe("Cleaner panel", () => {
  test("renders validated inventory, activity, capsule names, and limits", () => {
    const html = renderPanel(complete());

    for (const expected of ["Git 胶囊库存", "1 个", "已完成", "已删", "2", "0003.patch", "128 B", "capsules:256", "scan:4096"])
      expect(html).toContain(expected);
    expect(html).not.toContain("Cleaner 面板数据异常");
  });

  test("renders a useful untouched empty state", () => {
    const html = renderPanel(
      complete({ capsules: [], inventory: { total: 0, shown: 0, truncated: false, displayLimit: 20 }, lastCleanup: null, lastRemoved: 0 }),
    );

    expect(html).toContain("当前没有可清理的 Git 胶囊");
    expect(html).toContain("confirm=true");
    expect(html).not.toContain("Cleaner 面板数据异常");
  });

  test("fails closed for malformed data without manufacturing an empty inventory", () => {
    const html = renderPanel(complete({ inventory: { total: 0, shown: 1, truncated: false, displayLimit: 20 } }));

    expect(html).toContain("Cleaner 面板数据异常");
    expect(html).toContain("面板数据不完整或不可信");
    expect(html).not.toContain("0 个");
    expect(html).not.toContain("当前没有可清理的 Git 胶囊");
    expect(html).not.toContain("已完成");
  });

  test("contains long but valid capsule names without widening the card", () => {
    const name = `${"n".repeat(249)}.patch`;
    const html = renderPanel(complete({ capsules: [{ name, bytes: 1 }], inventory: { total: 1, shown: 1, truncated: false, displayLimit: 20 } }));

    expect(html).toContain(name);
    expect(html).toMatch(/class="[^"]*truncate[^"]*"[^>]*title="n{249}\.patch"/u);
  });
});
