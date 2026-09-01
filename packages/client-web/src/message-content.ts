export function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const typedPart = part as { type?: unknown; text?: unknown };
      return (typedPart.type === undefined || typedPart.type === "text") && typeof typedPart.text === "string" ? typedPart.text : "";
    })
    .join("");
}

export function messageThinking(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const typedPart = part as { type?: unknown; thinking?: unknown };
      return typedPart.type === "thinking" && typeof typedPart.thinking === "string" ? typedPart.thinking : "";
    })
    .filter(Boolean)
    .join("\n\n");
}
