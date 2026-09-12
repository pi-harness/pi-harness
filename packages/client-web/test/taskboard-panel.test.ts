import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("keeps maximum task titles and dependency lists readable instead of truncating or widening the panel", () => {
  const title = `Investigate-order-${"x".repeat(182)}`;
  const dependsOn = Array.from({ length: 32 }, (_, index) => `LONG_OPS_KEY-${index + 1}`);
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "taskboard-panel",
        pluginId: "@pi-harness/plugin-taskboard",
        title: "Taskboard",
        data: {
          workspace: "/workspace",
          total: 1,
          counts: { backlog: 0, todo: 0, in_progress: 1, in_review: 0, blocked: 0, canceled: 0, done: 0 },
          recent: [
            {
              id: "task-1",
              key: "OPS-33",
              workspace: "/workspace",
              title,
              description: "",
              status: "in_progress",
              priority: "urgent",
              createdAt: "2026-09-12T03:00:00.000Z",
              updatedAt: "2026-09-12T03:00:00.000Z",
              version: 1,
              dependsOn,
            },
          ],
        },
      },
    }),
  );

  expect(html).toContain(title);
  expect(html).toContain(dependsOn.join(", "));
  expect(html).toMatch(/class="[^"]*\[overflow-wrap:anywhere\][^"]*"[^>]*>Investigate-order-/u);
  expect(html).toMatch(/class="[^"]*basis-full[^"]*\[overflow-wrap:anywhere\][^"]*"/u);
  expect(html).not.toMatch(/class="[^"]*truncate[^"]*"[^>]*>Investigate-order-/u);
});

test("keeps all eight backend-bounded recent tasks accessible", () => {
  const recent = Array.from({ length: 8 }, (_, index) => ({
    id: `task-${index + 1}`,
    key: `OPS-${index + 1}`,
    workspace: "/workspace",
    title: `Order workflow ${index + 1}`,
    description: "",
    status: "todo",
    priority: "medium",
    createdAt: `2026-09-12T03:00:0${7 - index}.000Z`,
    updatedAt: `2026-09-12T03:00:0${7 - index}.000Z`,
    version: 1,
    dependsOn: [],
  }));
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "taskboard-panel",
        pluginId: "@pi-harness/plugin-taskboard",
        title: "Taskboard",
        data: {
          workspace: "/workspace",
          total: recent.length,
          counts: { backlog: 0, todo: 8, in_progress: 0, in_review: 0, blocked: 0, canceled: 0, done: 0 },
          recent,
        },
      },
    }),
  );

  for (const task of recent) expect(html).toContain(task.title);
  expect(html).toContain("最近任务 8 / 8");
});

test("rejects contradictory taskboard data instead of rendering invented healthy counts", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "taskboard-panel",
        pluginId: "@pi-harness/plugin-taskboard",
        title: "Taskboard",
        data: {
          workspace: "/workspace",
          total: 99,
          counts: { backlog: 0, todo: 0, in_progress: 0, in_review: 0, blocked: 0, canceled: 0, done: 0 },
          recent: [],
        },
      },
    }),
  );

  expect(html).toContain("Taskboard 面板数据异常");
  expect(html).toContain("面板数据不完整或不可信，请重新加载后再查询。");
  expect(html).not.toContain("99 个");
});
