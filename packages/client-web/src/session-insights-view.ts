export type SessionInsightsCompactionStatus = "idle" | "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface SessionInsightsReportView {
  readonly sessionId: string;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly totalMessages: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: number;
  readonly contextUsage: {
    readonly tokens: number | null;
    readonly contextWindow: number;
    readonly percent: number | null;
  } | null;
}

export interface SessionInsightsCompactionView {
  readonly status: SessionInsightsCompactionStatus;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export interface SessionInsightsPanelView {
  readonly report: SessionInsightsReportView | null;
  readonly compaction: SessionInsightsCompactionView;
  readonly malformed: boolean;
  readonly limits: {
    readonly sessionIdCharacters: number;
    readonly errorCharacters: number;
  };
}

const fixedLimits = { sessionIdCharacters: 512, errorCharacters: 2_000 } as const;
const maxCost = 1_000_000_000;

function unknownCompaction(): SessionInsightsCompactionView {
  return { status: "unknown", requestedAt: null, startedAt: null, finishedAt: null, error: null };
}

function ownDataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function reportView(source: Record<string, unknown>): SessionInsightsReportView | undefined {
  const sessionId = source.sessionId;
  const tokens = ownDataRecord(source.tokens);
  const userMessages = count(source.userMessages);
  const assistantMessages = count(source.assistantMessages);
  const toolCalls = count(source.toolCalls);
  const toolResults = count(source.toolResults);
  const totalMessages = count(source.totalMessages);
  const input = count(tokens?.input);
  const output = count(tokens?.output);
  const cacheRead = count(tokens?.cacheRead);
  const cacheWrite = count(tokens?.cacheWrite);
  const total = count(tokens?.total);
  const cost = source.cost;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > fixedLimits.sessionIdCharacters ||
    /[\0\p{Cc}]/u.test(sessionId) ||
    tokens === undefined ||
    userMessages === undefined ||
    assistantMessages === undefined ||
    toolCalls === undefined ||
    toolResults === undefined ||
    totalMessages === undefined ||
    !Number.isSafeInteger(userMessages + assistantMessages + toolResults) ||
    userMessages + assistantMessages + toolResults > totalMessages ||
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    total === undefined ||
    !Number.isSafeInteger(input + output + cacheRead + cacheWrite) ||
    total !== input + output + cacheRead + cacheWrite ||
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    cost > maxCost
  )
    return undefined;

  let contextUsage: SessionInsightsReportView["contextUsage"] = null;
  if (source.contextUsage !== null) {
    const usage = ownDataRecord(source.contextUsage);
    const usageTokens = usage?.tokens;
    const contextWindow = count(usage?.contextWindow);
    const percent = usage?.percent;
    const tokensValid = usageTokens === null || count(usageTokens) !== undefined;
    const percentValid = percent === null || (typeof percent === "number" && Number.isFinite(percent) && percent >= 0);
    const nullabilityMatches = (usageTokens === null) === (percent === null);
    const expectedPercent = typeof usageTokens === "number" && contextWindow !== undefined && contextWindow > 0 ? (usageTokens / contextWindow) * 100 : null;
    const percentMatches =
      expectedPercent === null ||
      (typeof percent === "number" && Math.abs(percent - expectedPercent) <= Math.max(1e-9, Math.abs(expectedPercent) * Number.EPSILON * 8));
    if (usage === undefined || !tokensValid || contextWindow === undefined || contextWindow <= 0 || !percentValid || !nullabilityMatches || !percentMatches)
      return undefined;
    contextUsage = { tokens: usageTokens as number | null, contextWindow, percent };
  }

  return {
    sessionId,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages,
    tokens: { input, output, cacheRead, cacheWrite, total },
    cost,
    contextUsage,
  };
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function compactionView(source: Record<string, unknown>): SessionInsightsCompactionView | undefined {
  const status = source.status;
  const requestedAt = timestamp(source.requestedAt);
  const startedAt = timestamp(source.startedAt);
  const finishedAt = timestamp(source.finishedAt);
  const error = source.error;
  const hasRequestedAt = source.requestedAt !== undefined;
  const hasStartedAt = source.startedAt !== undefined;
  const hasFinishedAt = source.finishedAt !== undefined;
  const hasError = source.error !== undefined;
  const ordered =
    requestedAt !== null &&
    (startedAt === null || Date.parse(requestedAt) <= Date.parse(startedAt)) &&
    (finishedAt === null || Date.parse(startedAt ?? requestedAt) <= Date.parse(finishedAt));
  const validError = typeof error === "string" && error.length > 0 && error.length <= fixedLimits.errorCharacters && !error.includes("\0") ? error : null;

  if (status === "idle" && !hasRequestedAt && !hasStartedAt && !hasFinishedAt && !hasError)
    return { status, requestedAt: null, startedAt: null, finishedAt: null, error: null };
  if (status === "queued" && hasRequestedAt && !hasStartedAt && !hasFinishedAt && !hasError && ordered)
    return { status, requestedAt, startedAt: null, finishedAt: null, error: null };
  if (status === "running" && hasRequestedAt && hasStartedAt && !hasFinishedAt && !hasError && ordered)
    return { status, requestedAt, startedAt, finishedAt: null, error: null };
  if (status === "completed" && hasRequestedAt && hasStartedAt && hasFinishedAt && !hasError && ordered)
    return { status, requestedAt, startedAt, finishedAt, error: null };
  if (
    (status === "failed" || status === "cancelled") &&
    hasRequestedAt &&
    hasFinishedAt &&
    (!hasStartedAt || startedAt !== null) &&
    ordered &&
    validError !== null
  )
    return { status, requestedAt, startedAt, finishedAt, error: validError };
  return unknownCompaction();
}

export function sessionInsightsPanelView(data: unknown): SessionInsightsPanelView {
  const source = ownDataRecord(data);
  if (source === undefined) return { report: null, compaction: unknownCompaction(), malformed: true, limits: { ...fixedLimits } };
  const report = reportView(source);
  const compactionSource = ownDataRecord(source.compaction);
  if (report === undefined || compactionSource === undefined)
    return { report: null, compaction: unknownCompaction(), malformed: true, limits: { ...fixedLimits } };
  const compaction = compactionView(compactionSource);
  return {
    report,
    compaction: compaction ?? unknownCompaction(),
    malformed: compaction === undefined || compaction.status === "unknown",
    limits: { ...fixedLimits },
  };
}
