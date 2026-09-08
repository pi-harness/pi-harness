export type RuntimeEvent = Record<string, unknown>;

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

// The trace table used to print the raw event type in a narrow column, where `tool_execution_start` was cut to `tool_execution_sta` and told the reader nothing the 事件 column did not already say.
const EVENT_KIND_LABELS = new Map<string, string>([
  ["agent_start", "运行开始"],
  ["agent_end", "运行结束"],
  ["agent_settled", "运行就绪"],
  ["turn_start", "轮次开始"],
  ["turn_end", "轮次结束"],
  ["message_start", "消息开始"],
  ["message_update", "消息更新"],
  ["message_end", "消息完成"],
  ["tool_execution_start", "工具调用"],
  ["tool_execution_end", "工具返回"],
  ["queue_update", "队列变更"],
  ["compaction_start", "压缩开始"],
  ["compaction_end", "压缩结束"],
  ["entry_appended", "写入会话"],
  ["session_info_changed", "会话信息变更"],
  ["thinking_level_changed", "思考级别变更"],
  ["auto_retry_start", "自动重试"],
  ["auto_retry_end", "重试结束"],
  ["file", "文件详情"],
  ["file_diff", "文件差异"],
]);

/** The Chinese name of an event kind, falling back to the raw id so an event type this console has not met yet still reads as itself. */
export function eventKindLabel(type: unknown): string {
  if (typeof type !== "string" || type === "") return "事件";
  return EVENT_KIND_LABELS.get(type) ?? type;
}

function messageRecord(event: RuntimeEvent): RuntimeEvent | undefined {
  return typeof event.message === "object" && event.message !== null ? (event.message as RuntimeEvent) : undefined;
}

/** The wall-clock the gateway stamped on arrival, falling back to the timestamp Pi puts inside a message payload. */
export function eventClock(event: RuntimeEvent): number | undefined {
  const stamped = event.receivedAt;
  if (typeof stamped === "number" && Number.isFinite(stamped)) return stamped;
  const timestamp = messageRecord(event)?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

export function formatEventClock(event: RuntimeEvent): string {
  const clock = eventClock(event);
  if (clock === undefined) return "—";
  return new Date(clock).toLocaleTimeString("zh-CN", { hour12: false });
}

/** What produced the event: the model for a message, the tool for a call, and the runtime for everything the harness itself emits. */
export function eventOrigin(event: RuntimeEvent): string {
  if (typeof event.toolName === "string" && event.toolName !== "") return event.toolName;
  const message = messageRecord(event);
  if (message !== undefined) {
    if (typeof message.model === "string" && message.model !== "") return message.model;
    if (typeof message.role === "string" && message.role !== "") return message.role;
  }
  return "运行时";
}

export function formatEventDuration(event: RuntimeEvent): string {
  const duration = event.durationMs;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return "—";
  return duration >= 1000 ? `${(duration / 1000).toFixed(duration >= 10_000 ? 0 : 1)} s` : `${Math.round(duration)} ms`;
}

/** The readable text a tool result carries, so the details panel shows what the tool returned rather than the envelope it came in. */
export function eventOutputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (typeof output !== "object" || output === null) return undefined;
  const content = (output as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part) =>
      typeof part === "object" && part !== null && (part as { text?: unknown }).text !== undefined ? (part as { text?: unknown }).text : undefined,
    )
    .filter((text): text is string => typeof text === "string");
  return parts.length ? parts.join("\n") : undefined;
}
