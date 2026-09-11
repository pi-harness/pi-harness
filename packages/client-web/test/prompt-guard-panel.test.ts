import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

test("shows all risk findings including a sixth incomplete-scan warning", () => {
  const codes = ["instruction_override", "secret_exfiltration", "remote_payload", "system_prompt_probe", "hidden_instruction", "input_truncated"];
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "prompt-guard-panel",
        pluginId: "@pi-harness/plugin-prompt-guard",
        title: "Prompt Guard",
        data: {
          scans: 1,
          highest: {
            risk: "blocked",
            source: "tool:read",
            truncated: true,
            findings: codes.map((code) => ({ code, severity: "medium", message: `Finding ${code}` })),
          },
        },
      },
    }),
  );
  for (const code of codes) expect(html).toContain(`Finding ${code}`);
});
