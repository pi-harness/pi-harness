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

export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly result?: string;
  readonly failed: boolean;
}

/** The tool calls an assistant message asked for, in the order the model wrote them. */
export function messageToolCalls(message: Record<string, unknown>): readonly ChatToolCall[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const calls: ChatToolCall[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const typedPart = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (typedPart.type !== "toolCall" || typeof typedPart.name !== "string") continue;
    calls.push({ id: typeof typedPart.id === "string" ? typedPart.id : "", name: typedPart.name, arguments: typedPart.arguments, failed: false });
  }
  return calls;
}

export interface ChatTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly thinking: string;
  readonly tools: readonly ChatToolCall[];
  readonly stopped: boolean;
}

export function projectChatTurns(messages: readonly Record<string, unknown>[]): readonly ChatTurn[] {
  // A tool result is its own message and arrives after the assistant message that asked for the call, so the results are collected first and joined back onto the call by id.
  const results = new Map<string, { readonly text: string; readonly failed: boolean }>();
  for (const message of messages) {
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    results.set(message.toolCallId, { text: messageText(message), failed: message.isError === true });
  }
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") continue;
    const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : undefined;
    if (!role) continue;
    const text = messageText(message);
    const thinking = role === "assistant" ? messageThinking(message) : "";
    const tools =
      role === "assistant"
        ? messageToolCalls(message).map((call) => {
            const result = results.get(call.id);
            return result === undefined ? call : { ...call, result: result.text, failed: result.failed };
          })
        : [];
    // The runtime records an interrupted run on the message it closed, and that message often carries no content at all, so the flag is carried over to the turn it belongs to instead of being dropped along with the empty text.
    const stopped = role === "assistant" && message.stopReason === "aborted";
    const previous = turns.at(-1);
    // A message whose only content is a tool call has no text and no thinking, and dropping it here is what left the transcript claiming the model answered out of thin air.
    if (!text && !thinking && !tools.length) {
      if (!stopped) continue;
      // An interrupt that lands before the model has written anything belongs to a turn of its own: without one the user sees their prompt followed by nothing, with no sign that the run ended rather than stalled.
      if (previous?.role === "assistant") turns[turns.length - 1] = { ...previous, stopped: true };
      else turns.push({ role, text, thinking, tools, stopped });
      continue;
    }
    if (role === "assistant" && previous?.role === "assistant") {
      // The merged turn keeps the flag either part carried: an interrupted run whose last message happens to be a normal one is still an interrupted run.
      turns[turns.length - 1] = {
        role,
        text: previous.text + text,
        thinking: previous.thinking + thinking,
        tools: [...previous.tools, ...tools],
        stopped: previous.stopped || stopped,
      };
    } else {
      turns.push({ role, text, thinking, tools, stopped });
    }
  }
  return turns;
}
