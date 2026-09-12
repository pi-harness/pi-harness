import { formatLocale, t } from "./i18n.js";

export type RuntimeEvent = Record<string, unknown>;
const MAX_TRAJECTORY_EVENTS = 2000;

function record(value: unknown): RuntimeEvent | undefined {
  return typeof value === "object" && value !== null ? (value as RuntimeEvent) : undefined;
}

function entryClock(entry: RuntimeEvent, message: RuntimeEvent): number | undefined {
  const timestamp = entry.timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : undefined;
}

function boundedHistoricalEvents(events: readonly RuntimeEvent[], limit: number): readonly RuntimeEvent[] {
  if (events.length <= limit) return events;
  if (limit <= 0) return [];
  const existingMarker = events[0]?.type === "historical_events_omitted" ? events[0] : undefined;
  const source = existingMarker === undefined ? events : events.slice(1);
  const existingOmitted = typeof existingMarker?.omitted === "number" && Number.isFinite(existingMarker.omitted) ? existingMarker.omitted : 0;
  if (limit === 1) return [{ type: "historical_events_omitted", historical: true, omitted: existingOmitted + source.length }];
  let firstRetained = Math.max(0, source.length - (limit - 1));
  while (firstRetained < source.length && source[firstRetained]?.type === "tool_execution_end") firstRetained += 1;
  const retained = source.slice(firstRetained);
  return [
    {
      type: "historical_events_omitted",
      historical: true,
      omitted: existingOmitted + firstRetained,
      receivedAt: retained[0]?.receivedAt,
    },
    ...retained,
  ];
}

/** Rebuild the durable part of the tool timeline from Pi's append-only session entries. Runtime events are ephemeral, but tool calls and results persist in JSONL with stable call ids and timestamps. */
export function historicalTrajectoryEvents(entries: readonly unknown[]): readonly RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  const startedAt = new Map<string, number>();
  for (const candidate of entries) {
    const entry = record(candidate);
    if (entry === undefined) continue;
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (message === undefined) continue;
    const receivedAt = entryClock(entry, message);
    if (receivedAt === undefined) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        const content = record(item);
        if (content?.type !== "toolCall" || typeof content.id !== "string" || typeof content.name !== "string") continue;
        startedAt.set(content.id, receivedAt);
        events.push({
          type: "tool_execution_start",
          toolCallId: content.id,
          toolName: content.name,
          args: content.arguments,
          receivedAt,
          historical: true,
        });
      }
      continue;
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string" || typeof message.toolName !== "string") continue;
    const start = startedAt.get(message.toolCallId);
    events.push({
      type: "tool_execution_end",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      result: {
        content: message.content,
        ...(message.details === undefined ? {} : { details: message.details }),
      },
      isError: message.isError === true,
      receivedAt,
      ...(start === undefined ? {} : { durationMs: Math.max(0, receivedAt - start) }),
      historical: true,
    });
  }
  return boundedHistoricalEvents(events, MAX_TRAJECTORY_EVENTS);
}

/** Keep durable history while a newly observed run streams, excluding entries the live event feed already represents. */
export function mergeTrajectoryEvents(entries: readonly unknown[], liveEvents: readonly RuntimeEvent[]): readonly RuntimeEvent[] {
  const historical = historicalTrajectoryEvents(entries);
  if (liveEvents.length === 0) return historical;
  const liveToolCallIds = new Set(
    liveEvents.map((event) => event.toolCallId).filter((toolCallId): toolCallId is string => typeof toolCallId === "string"),
  );
  const liveClocks = liveEvents.map(eventClock).filter((clock): clock is number => clock !== undefined);
  const firstLiveAt = liveClocks.length === 0 ? undefined : Math.min(...liveClocks);
  const retainedHistory = historical.filter((event) => {
    if (typeof event.toolCallId === "string" && liveToolCallIds.has(event.toolCallId)) return false;
    const clock = eventClock(event);
    return firstLiveAt === undefined || (clock !== undefined && clock < firstLiveAt);
  });
  const retainedLive = liveEvents.slice(-MAX_TRAJECTORY_EVENTS);
  return [...boundedHistoricalEvents(retainedHistory, MAX_TRAJECTORY_EVENTS - retainedLive.length), ...retainedLive];
}

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
  ["tool_execution_update", "工具进展"],
  ["tool_execution_end", "工具返回"],
  ["queue_update", "队列变更"],
  ["compaction_start", "压缩开始"],
  ["compaction_delta", "压缩进展"],
  ["compaction_cost", "压缩开销"],
  ["compaction_end", "压缩结束"],
  ["entry_appended", "写入会话"],
  ["session_info_changed", "会话信息变更"],
  ["thinking_level_changed", "思考级别变更"],
  ["historical_events_omitted", "更早的历史事件已省略"],
  ["auto_retry_start", "自动重试"],
  ["auto_retry_end", "重试结束"],
  ["file", "文件详情"],
  ["file_diff", "文件差异"],
]);

/** The readable name of an event kind, falling back to the raw id so an event type this console has not met yet still reads as itself. The table holds the Chinese source rather than the translation because it is built once at import, before any catalog is loaded. */
export function eventKindLabel(type: unknown): string {
  if (typeof type !== "string" || type === "") return t("事件");
  const label = EVENT_KIND_LABELS.get(type);
  return label === undefined ? type : t(label);
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
  return new Date(clock).toLocaleTimeString(formatLocale(), { hour12: false });
}

/** What produced the event: the model for a message, the tool for a call, and the runtime for everything the harness itself emits. */
export function eventOrigin(event: RuntimeEvent): string {
  if (typeof event.toolName === "string" && event.toolName !== "") return event.toolName;
  const message = messageRecord(event);
  if (message !== undefined) {
    if (typeof message.model === "string" && message.model !== "") return message.model;
    if (typeof message.role === "string" && message.role !== "") return message.role;
  }
  return t("运行时");
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

/** Identifies the durable or live boundary that produced a trace row. */
export function eventDataSource(event: RuntimeEvent): string {
  if (event.type === "file" || event.type === "file_diff") return "Git workspace · /api/files";
  return event.historical === true ? "Session JSONL · message history" : "Runtime loader · event";
}
