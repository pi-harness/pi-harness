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

export interface ChatTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly thinking: string;
}

export function projectChatTurns(messages: readonly Record<string, unknown>[]): readonly ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") continue;
    const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : undefined;
    if (!role) continue;
    const text = messageText(message);
    const thinking = role === "assistant" ? messageThinking(message) : "";
    if (!text && !thinking) continue;
    const previous = turns.at(-1);
    if (role === "assistant" && previous?.role === "assistant") {
      turns[turns.length - 1] = { role, text: previous.text + text, thinking: previous.thinking + thinking };
    } else {
      turns.push({ role, text, thinking });
    }
  }
  return turns;
}
