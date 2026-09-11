import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("shows every file, constraint and acceptance criterion in a maximum-sized handoff", () => {
  const files = Array.from({ length: 20 }, (_, i) => `file-${i + 1}.ts`);
  const constraints = Array.from({ length: 20 }, (_, i) => `constraint-${i + 1}`);
  const acceptance = Array.from({ length: 20 }, (_, i) => `acceptance-${i + 1}`);
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "colleague-skill-panel",
        pluginId: "@pi-harness/plugin-colleague-skill",
        title: "Colleague Skill",
        data: { latest: { toRole: "reviewer", objective: "Complete packet", files, constraints, acceptance } },
      },
    }),
  );
  for (const text of [...files, ...constraints, ...acceptance]) expect(html).toContain(text);
});

test("preserves repeated file references and escapes inert markup in handoff requirements", () => {
  const files = Array.from({ length: 12 }, () => "repeated-file.ts");
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "colleague-skill-panel",
        pluginId: "@pi-harness/plugin-colleague-skill",
        title: "Colleague Skill",
        data: { latest: { toRole: "reviewer", objective: "Complete packet", files, constraints: ["<script>inert</script>"], acceptance: [] } },
      },
    }),
  );
  expect(html.split("repeated-file.ts")).toHaveLength(13);
  expect(html).toContain("&lt;script&gt;inert&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});
