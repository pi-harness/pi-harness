import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

describe("Anchored Standard panel", () => {
  test("shows all five supported violation kinds", () => {
    const messages = ["orphan tool finding", "nested run finding", "budget finding", "orphan end finding", "disallowed tool finding"];
    const html = renderToStaticMarkup(
      createElement(PluginPanelCard, {
        panel: {
          id: "anchored-standard-panel",
          pluginId: "@pi-harness/plugin-anchored-standard",
          title: "Anchored Standard",
          data: { status: "violated", events: 7, toolCalls: 3, violations: messages.map((message) => ({ message })) },
        },
      }),
    );
    for (const message of messages) expect(html).toContain(message);
  });
});
