import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

const template = {
  id: `prompt-${"a".repeat(121)}`,
  title: `Tenant refund escalation ${"x".repeat(95)}`,
  prompt: `Step one\n${"x".repeat(7_991)}`,
  tags: Array.from({ length: 10 }, (_, index) => `tenant-${index + 1}`),
  createdAt: "2026-09-12T03:00:00.000Z",
  updatedAt: "2026-09-12T03:00:00.000Z",
};

test("keeps maximum prompt-library fields and all tags accessible in narrow panels", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "prompt-library-panel",
        pluginId: "@pi-harness/plugin-prompt-library",
        title: "Prompt Library",
        data: { total: 1, shown: 1, truncated: false, templates: [template] },
      },
    }),
  );

  expect(html).toContain(template.title);
  expect(html).toContain(template.id);
  expect(html).toContain(template.prompt.split("\n")[1]);
  for (const tag of template.tags) expect(html).toContain(tag);
  expect(html).not.toContain("line-clamp-2");
  expect(html).toMatch(/overflow-wrap:anywhere/u);
});

test("renders all twelve backend-bounded templates inside a scrollable inventory", () => {
  const templates = Array.from({ length: 12 }, (_, index) => ({ ...template, id: `prompt-${index + 1}`, title: `Tenant workflow ${12 - index}` }));
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "prompt-library-panel",
        pluginId: "@pi-harness/plugin-prompt-library",
        title: "Prompt Library",
        data: { total: 100, shown: 12, truncated: true, templates },
      },
    }),
  );

  for (const item of templates) expect(html).toContain(item.title);
  expect(html).toContain("max-h-[40rem]");
  expect(html).toContain("最近 12 条有效记录");
});

test("rejects contradictory prompt-library panel inventories", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "prompt-library-panel",
        pluginId: "@pi-harness/plugin-prompt-library",
        title: "Prompt Library",
        data: { total: 99, shown: 1, truncated: false, templates: [template] },
      },
    }),
  );

  expect(html).toContain("Prompt Library 面板数据异常");
  expect(html).not.toContain(template.title);
  expect(html).not.toContain("99");
});
