import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("shows every bounded security finding instead of silently hiding findings after six", () => {
  const findings = Array.from({ length: 200 }, (_, index) => ({
    path: `fixture-${index}.txt`,
    line: index + 1,
    severity: "high",
    kind: "destructive-command",
    message: `Redacted finding ${index}`,
  }));
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "secure-audit-panel",
        pluginId: "@pi-harness/plugin-secure-audit",
        title: "Secure Audit",
        data: {
          root: ".",
          scanned: 200,
          skipped: 0,
          total: 200,
          high: 200,
          critical: 0,
          medium: 0,
          changed: true,
          findings,
          truncated: false,
          incomplete: false,
          credentialLinesSkipped: 0,
          hasRun: true,
        },
      },
    }),
  );
  for (const finding of findings) expect(html).toContain(finding.path);
});
