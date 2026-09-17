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

/** One piece of a turn, kept in the order the model produced it so a call that came after a sentence is not shown before it. */
export type ChatTurnPart = { readonly type: "text" | "thinking"; readonly value: string } | ({ readonly type: "tool" } & ChatToolCall);

/** Prose arrives in as many chunks as the model streamed it in, so a chunk that continues the one before it is joined back rather than kept as a block of its own. */
function appendProse(parts: ChatTurnPart[], type: "text" | "thinking", value: string, separator: string): void {
  if (!value) return;
  const last = parts.at(-1);
  if (last !== undefined && last.type !== "tool" && last.type === type) parts[parts.length - 1] = { type, value: last.value + separator + value };
  else parts.push({ type, value });
}

/** The content of one message as an ordered sequence: the order is the only record of whether the model narrated before or after it called a tool. */
export function messageParts(message: Record<string, unknown>): readonly ChatTurnPart[] {
  const content = message.content;
  if (typeof content === "string") return content ? [{ type: "text", value: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: ChatTurnPart[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      appendProse(parts, "text", part, "");
      continue;
    }
    if (typeof part !== "object" || part === null) continue;
    const typedPart = part as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (typedPart.type === "toolCall") {
      if (typeof typedPart.name !== "string") continue;
      parts.push({
        type: "tool",
        id: typeof typedPart.id === "string" ? typedPart.id : "",
        name: typedPart.name,
        arguments: typedPart.arguments,
        failed: false,
      });
      continue;
    }
    if (typedPart.type === "thinking") {
      if (typeof typedPart.thinking === "string") appendProse(parts, "thinking", typedPart.thinking, "\n\n");
      continue;
    }
    if ((typedPart.type === undefined || typedPart.type === "text") && typeof typedPart.text === "string") appendProse(parts, "text", typedPart.text, "");
  }
  return parts;
}

export interface ChatTurn {
  readonly role: "user" | "assistant" | "compaction";
  /** The prose of the turn on its own: what a user prompt or a compaction summary says, and what an assistant turn reads as with its tool rows taken out. */
  readonly text: string;
  readonly parts: readonly ChatTurnPart[];
  readonly stopped: boolean;
  /** How much context the compaction reclaimed, on a compaction turn only. */
  readonly tokensBefore?: number;
}

/** Two messages that were merged into one turn were written apart, so their prose is separated by a blank line rather than run together into one sentence. */
function turnText(parts: readonly ChatTurnPart[]): string {
  return parts.flatMap((part) => (part.type === "text" ? [part.value] : [])).join("\n\n");
}

/** Reasoning that ran across a message boundary with nothing between it is one train of thought, and kept as two parts it opens two 思考 disclosures for what the reader lived through as a single pause. Prose is not joined the same way: each piece stays its own markdown document so an unclosed code fence in one cannot swallow the next. */
function mergeTurnParts(previous: readonly ChatTurnPart[], next: readonly ChatTurnPart[]): readonly ChatTurnPart[] {
  const merged = [...previous];
  for (const [index, part] of next.entries()) {
    if (index === 0 && part.type === "thinking") appendProse(merged, "thinking", part.value, "\n\n");
    else merged.push(part);
  }
  return merged;
}

/** The runtime writes a compactionSummary message where it replaced the history it dropped. */
export function compactionTurn(message: Record<string, unknown>): ChatTurn | undefined {
  if (message.role !== "compactionSummary") return undefined;
  const summary = typeof message.summary === "string" ? message.summary : messageText(message);
  const tokensBefore = typeof message.tokensBefore === "number" ? message.tokensBefore : undefined;
  return {
    role: "compaction",
    text: summary,
    parts: summary ? [{ type: "text", value: summary }] : [],
    stopped: false,
    ...(tokensBefore === undefined ? {} : { tokensBefore }),
  };
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
    // A compaction is the one point where the transcript stops being a record of what was said, so it is the one place the transcript has to say so itself.
    const compaction = compactionTurn(message);
    if (compaction) {
      turns.push(compaction);
      continue;
    }
    const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : undefined;
    if (!role) continue;
    const parts =
      role === "assistant"
        ? messageParts(message).map((part) => {
            if (part.type !== "tool") return part;
            const result = results.get(part.id);
            return result === undefined ? part : { ...part, result: result.text, failed: result.failed };
          })
        : // A user message is prose and nothing else, and the reasoning of a model has no business being read back as something the user said.
          messageParts(message).filter((part) => part.type === "text");
    // The runtime records an interrupted run on the message it closed, and that message often carries no content at all, so the flag is carried over to the turn it belongs to instead of being dropped along with the empty text.
    const stopped = role === "assistant" && message.stopReason === "aborted";
    const previous = turns.at(-1);
    // A message whose only content is a tool call has no text and no thinking, and dropping it here is what left the transcript claiming the model answered out of thin air.
    if (!parts.length) {
      if (!stopped) continue;
      // An interrupt that lands before the model has written anything belongs to a turn of its own: without one the user sees their prompt followed by nothing, with no sign that the run ended rather than stalled.
      if (previous?.role === "assistant") turns[turns.length - 1] = { ...previous, stopped: true };
      else turns.push({ role, text: "", parts, stopped });
      continue;
    }
    if (role === "assistant" && previous?.role === "assistant") {
      // The merged turn keeps the flag either part carried: an interrupted run whose last message happens to be a normal one is still an interrupted run.
      const merged = mergeTurnParts(previous.parts, parts);
      turns[turns.length - 1] = { role, text: turnText(merged), parts: merged, stopped: previous.stopped || stopped };
    } else {
      turns.push({ role, text: turnText(parts), parts, stopped });
    }
  }
  return turns;
}
