export interface ContextInsightsEventView {
  readonly type: string;
  readonly at: number | null;
}

export interface ContextInsightsPanelView {
  readonly sessionId: string;
  readonly tokens: number | null;
  readonly contextWindow: number | null;
  readonly percent: number | null;
  readonly messages: number;
  readonly scannedMessages: number;
  readonly messagesTruncated: boolean;
  readonly events: number;
  readonly compactions: number;
  readonly composition: {
    readonly user: number;
    readonly assistant: number;
    readonly toolResult: number;
    readonly system: number;
    readonly other: number;
  };
  readonly recentEvents: readonly ContextInsightsEventView[];
  readonly recentEventsTruncated: boolean;
  readonly limits: {
    readonly scannedMessages: number;
    readonly retainedEvents: number;
    readonly displayedEvents: number;
    readonly eventTypeCharacters: number;
  };
  readonly malformed: boolean;
}

const limits = {
  scannedMessages: 10_000,
  retainedEvents: 50,
  displayedEvents: 6,
  eventTypeCharacters: 128,
} as const;
const maxReportedCount = 4_294_967_295;
const maxDateMilliseconds = 8_640_000_000_000_000;
const maxSessionIdCharacters = 512;

function dataProperty(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function count(value: unknown, maximum = maxReportedCount): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
}

function nullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function eventType(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().replaceAll("\0", "�");
  return normalized === "" ? "unknown" : normalized.slice(0, limits.eventTypeCharacters);
}

function eventTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maxDateMilliseconds ? value : null;
}

function arrayLength(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return count(dataProperty(value, "length"), maxReportedCount);
}

function normalizedComposition(value: unknown, scannedMessages: number): ContextInsightsPanelView["composition"] {
  const composition = {
    user: count(dataProperty(value, "user"), scannedMessages),
    assistant: count(dataProperty(value, "assistant"), scannedMessages),
    toolResult: count(dataProperty(value, "toolResult"), scannedMessages),
    system: count(dataProperty(value, "system"), scannedMessages),
    other: count(dataProperty(value, "other"), scannedMessages),
  };
  const total = Object.values(composition).reduce((sum, item) => sum + item, 0);
  return total === scannedMessages ? composition : { user: 0, assistant: 0, toolResult: 0, system: 0, other: scannedMessages };
}

function normalizedEvents(value: unknown): { events: ContextInsightsEventView[]; truncated: boolean } {
  let rawLength: number;
  try {
    rawLength = arrayLength(value);
  } catch {
    return { events: [], truncated: false };
  }
  const retained = Math.min(rawLength, limits.retainedEvents);
  const events: ContextInsightsEventView[] = [];
  for (let offset = 0; offset < Math.min(retained, limits.displayedEvents); offset += 1) {
    const index = rawLength - offset - 1;
    const event = dataProperty(value, String(index));
    events.push({ type: eventType(dataProperty(event, "type")), at: eventTimestamp(dataProperty(event, "at")) });
  }
  return { events, truncated: rawLength > events.length };
}

function emptyPanelView(): ContextInsightsPanelView {
  return {
    sessionId: "",
    tokens: null,
    contextWindow: null,
    percent: null,
    messages: 0,
    scannedMessages: 0,
    messagesTruncated: false,
    events: 0,
    compactions: 0,
    composition: { user: 0, assistant: 0, toolResult: 0, system: 0, other: 0 },
    recentEvents: [],
    recentEventsTruncated: false,
    limits,
    malformed: true,
  };
}

export function contextInsightsPanelView(data: unknown, activeSessionId?: string | null): ContextInsightsPanelView {
  const rawSessionId = dataProperty(data, "sessionId");
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0 && rawSessionId.length <= maxSessionIdCharacters && !/[\0\p{Cc}]/u.test(rawSessionId)
      ? rawSessionId
      : "";
  if (sessionId === "" || (activeSessionId !== undefined && sessionId !== activeSessionId)) return emptyPanelView();
  const messages = count(dataProperty(data, "messages"));
  const scannedMessages = count(dataProperty(data, "scannedMessages"), Math.min(messages, limits.scannedMessages));
  const recent = normalizedEvents(dataProperty(data, "recentEvents"));
  return {
    sessionId,
    tokens: nullableCount(dataProperty(data, "tokens")),
    contextWindow: nullableCount(dataProperty(data, "contextWindow")),
    percent: percent(dataProperty(data, "percent")),
    messages,
    scannedMessages,
    messagesTruncated: dataProperty(data, "messagesTruncated") === true || messages > scannedMessages,
    events: count(dataProperty(data, "events")),
    compactions: count(dataProperty(data, "compactions")),
    composition: normalizedComposition(dataProperty(data, "composition"), scannedMessages),
    recentEvents: recent.events,
    recentEventsTruncated: recent.truncated,
    limits,
    malformed: false,
  };
}
