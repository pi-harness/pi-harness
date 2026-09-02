type RuntimeEvent = Record<string, unknown>;

function thinkingDelta(event: RuntimeEvent | undefined): { assistantMessageEvent: RuntimeEvent; delta: string } | undefined {
  if (event?.type !== "message_update" || typeof event.assistantMessageEvent !== "object" || event.assistantMessageEvent === null) return undefined;
  const assistantMessageEvent = event.assistantMessageEvent as RuntimeEvent;
  if (assistantMessageEvent.type !== "thinking_delta") return undefined;
  return { assistantMessageEvent, delta: typeof assistantMessageEvent.delta === "string" ? assistantMessageEvent.delta : "" };
}

export function compactThinkingEvents(events: readonly RuntimeEvent[]): readonly RuntimeEvent[] {
  const compacted: RuntimeEvent[] = [];
  for (const event of events) {
    const currentThinking = thinkingDelta(event);
    const previous = compacted.at(-1);
    const previousThinking = thinkingDelta(previous);
    if (currentThinking && previous && previousThinking) {
      compacted[compacted.length - 1] = {
        ...previous,
        assistantMessageEvent: {
          ...previousThinking.assistantMessageEvent,
          delta: previousThinking.delta + currentThinking.delta,
        },
      };
      continue;
    }
    compacted.push(event);
  }
  return compacted;
}
