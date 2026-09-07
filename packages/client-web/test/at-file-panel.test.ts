import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

function renderPanel(data: unknown): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "at-file-panel",
        pluginId: "@pi-harness/plugin-at-file",
        title: "@file Context",
        data,
      },
    }),
  );
}

describe("at-file panel", () => {
  test("renders a valid bounded attachment report", () => {
    const html = renderPanel({ lastFile: { path: "docs/notes.md", bytes: 5 }, maxBytes: 256 * 1024 });

    expect(html).toContain("docs/notes.md");
    expect(html).toContain("5 bytes");
    expect(html).toContain("262144 bytes");
    expect(html).not.toContain("面板数据不完整");
  });

  test("wraps a long attachment path instead of truncating it", () => {
    const path = `nested/${"a".repeat(500)}.md`;
    const html = renderPanel({ lastFile: { path, bytes: 5 }, maxBytes: 256 * 1024 });

    expect(html).toContain(path);
    expect(html).toMatch(/<p class="[^"]*break-all[^"]*">nested\//u);
    expect(html).not.toMatch(/<p class="[^"]*truncate[^"]*">nested\//u);
  });

  test("fails closed without invoking accessors or revoked proxies", () => {
    let getterCalls = 0;
    const rootAccessor = Object.defineProperty({}, "lastFile", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { path: "poison", bytes: 1 };
      },
    });
    const nestedAccessor = Object.defineProperty({}, "path", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "poison";
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    for (const data of [rootAccessor, { lastFile: nestedAccessor, maxBytes: 256 * 1024 }, revocable.proxy]) {
      expect(() => renderPanel(data)).not.toThrow();
      expect(renderPanel(data)).toContain("面板数据不完整");
    }
    expect(getterCalls).toBe(0);
  });

  test("sanitizes bounded path text and rejects contradictory fields", () => {
    const sanitized = renderPanel({ lastFile: { path: "docs/\u202Enotes.md", bytes: 5 }, maxBytes: 256 * 1024 });
    const invalidBytes = renderPanel({ lastFile: { path: "docs/notes.md", bytes: 256 * 1024 + 1 }, maxBytes: 256 * 1024 });
    const unknown = renderPanel({ lastFile: null, maxBytes: 256 * 1024, unexpected: true });

    expect(sanitized).toContain("docs/ notes.md");
    expect(sanitized).not.toContain("\u202E");
    expect(sanitized).toContain("面板数据不完整");
    expect(invalidBytes).not.toContain("262145 bytes");
    expect(invalidBytes).toContain("面板数据不完整");
    expect(unknown).toContain("面板数据不完整");
  });
});
