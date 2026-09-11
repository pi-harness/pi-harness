import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { inspectGuardInput } from "../../plugins/hol-guard/src/index.js";
import { PluginPanelCard } from "../src/react-room.js";

test("shows why a real HOL Guard report requires review without retaining the input", () => {
  const input: Record<string, unknown> = { token: "synthetic-private-marker" };
  input.self = input;
  const report = inspectGuardInput(input, "fixture");
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "hol-guard-panel",
        pluginId: "@pi-harness/plugin-hol-guard",
        title: "HOL Guard",
        data: { events: 1, blocked: 0, review: 1, safe: 0, latest: report, receipts: [report] },
      },
    }),
  );
  expect(html).toContain("输入无法序列化，未完成风险扫描，需要人工复核。");
  expect(html).toContain("HOL Guard 不会阻止任何工具执行");
  expect(html).not.toContain("synthetic-private-marker");
});
