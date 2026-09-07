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
  readonly stopped: boolean;
}

export function projectChatTurns(messages: readonly Record<string, unknown>[]): readonly ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") continue;
    const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : undefined;
    if (!role) continue;
    const text = messageText(message);
    const thinking = role === "assistant" ? messageThinking(message) : "";
    // The runtime records an interrupted run on the message it closed, and that message often carries no content at all, so the flag is carried over to the turn it belongs to instead of being dropped along with the empty text.
    const stopped = role === "assistant" && message.stopReason === "aborted";
    const previous = turns.at(-1);
    if (!text && !thinking) {
      if (!stopped) continue;
      // An interrupt that lands before the model has written anything belongs to a turn of its own: without one the user sees their prompt followed by nothing, with no sign that the run ended rather than stalled.
      if (previous?.role === "assistant") turns[turns.length - 1] = { ...previous, stopped: true };
      else turns.push({ role, text, thinking, stopped });
      continue;
    }
    if (role === "assistant" && previous?.role === "assistant") {
      // The merged turn keeps the flag either part carried: an interrupted run whose last message happens to be a normal one is still an interrupted run.
      turns[turns.length - 1] = { role, text: previous.text + text, thinking: previous.thinking + thinking, stopped: previous.stopped || stopped };
    } else {
      turns.push({ role, text, thinking, stopped });
    }
  }
  return turns;
}
