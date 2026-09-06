import createDOMPurify, { type Config } from "dompurify";
import { marked } from "marked";

const markdownOptions = { gfm: true, breaks: true } as const;
const purifier = typeof window === "undefined" ? undefined : createDOMPurify(window);

// DOMPurify's USE_PROFILES replaces ALLOWED_TAGS and ALLOWED_ATTR wholesale with its built-in HTML profile (img, form, input, style, ...), so it must stay out of this config for the explicit allowlist below to be enforced.
export const MARKDOWN_SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: ["a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "strong", "ul"],
  ALLOWED_ATTR: ["href", "rel", "target"],
  FORBID_ATTR: ["style", "class", "id"],
};

export type MarkdownSanitizer = (html: string, config: Config) => string;

const defaultSanitizer: MarkdownSanitizer | undefined = purifier === undefined ? undefined : (html, config) => purifier.sanitize(html, config);

export function renderMarkdown(source: string, sanitize: MarkdownSanitizer | undefined = defaultSanitizer): string {
  const html = marked.parse(source, markdownOptions);
  if (typeof html !== "string") return "";
  return sanitize?.(html, MARKDOWN_SANITIZE_CONFIG) ?? "";
}

export function MarkdownMessage({ text, onMouseUp }: { text: string; onMouseUp?: () => void }) {
  return <div className="turn-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} onMouseUp={onMouseUp} />;
}
