import createDOMPurify from "dompurify";
import { marked } from "marked";

const markdownOptions = { gfm: true, breaks: true } as const;
const purifier = typeof window === "undefined" ? undefined : createDOMPurify(window);

function renderMarkdown(source: string): string {
  const html = marked.parse(source, markdownOptions);
  if (typeof html !== "string") return "";
  return (
    purifier?.sanitize(html, {
      USE_PROFILES: { html: true },
      ALLOWED_TAGS: ["a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "strong", "ul"],
      ALLOWED_ATTR: ["href", "rel", "target"],
      FORBID_ATTR: ["style", "class", "id"],
    }) ?? ""
  );
}

export function MarkdownMessage({ text }: { text: string }) {
  return <div className="turn-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
