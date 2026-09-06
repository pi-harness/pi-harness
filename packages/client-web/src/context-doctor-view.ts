const defaults = {
  scannedMessages: 10_000,
  jsonDepth: 64,
  jsonNodesPerMessage: 10_000,
  jsonNodesPerAudit: 100_000,
  errorCharacters: 2_000,
  recommendationCharacters: 500,
  displayRecommendations: 4,
  warnPercent: 75,
  maxMessageBytes: 64 * 1024,
  messageCount: 4_294_967_295,
} as const;

function dataProperty(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function limit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= fallback ? value : fallback;
}

function count(value: unknown, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
}

function nullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum).replaceAll("\0", "�") : "";
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function arrayLength(value: readonly unknown[]): number {
  const length = dataProperty(value, "length");
  return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : 0;
}

type CompactionStatus = "idle" | "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";

function compactionView(value: unknown, errorCharacters: number) {
  const rawStatus = dataProperty(value, "status");
  const status: CompactionStatus =
    rawStatus === "idle" ||
    rawStatus === "queued" ||
    rawStatus === "running" ||
    rawStatus === "completed" ||
    rawStatus === "failed" ||
    rawStatus === "cancelled"
      ? rawStatus
      : "unknown";
  const error = status === "failed" || status === "cancelled" ? boundedText(dataProperty(value, "error"), errorCharacters) || null : null;
  return {
    status,
    error,
    requestedAt: timestamp(dataProperty(value, "requestedAt")),
    startedAt: timestamp(dataProperty(value, "startedAt")),
    finishedAt: timestamp(dataProperty(value, "finishedAt")),
  };
}

export function contextDoctorPanelView(data: unknown) {
  const rawLimits = dataProperty(data, "limits");
  const limits = {
    scannedMessages: limit(dataProperty(rawLimits, "scannedMessages"), defaults.scannedMessages),
    jsonDepth: limit(dataProperty(rawLimits, "jsonDepth"), defaults.jsonDepth),
    jsonNodesPerMessage: limit(dataProperty(rawLimits, "jsonNodesPerMessage"), defaults.jsonNodesPerMessage),
    jsonNodesPerAudit: limit(dataProperty(rawLimits, "jsonNodesPerAudit"), defaults.jsonNodesPerAudit),
    errorCharacters: limit(dataProperty(rawLimits, "errorCharacters"), defaults.errorCharacters),
    recommendationCharacters: defaults.recommendationCharacters,
    displayRecommendations: defaults.displayRecommendations,
  };
  const rawStatus = dataProperty(data, "status");
  const status = rawStatus === "ok" || rawStatus === "warning" ? rawStatus : "unknown";
  const rawUsagePercent = dataProperty(data, "usagePercent");
  const usagePercent = typeof rawUsagePercent === "number" && Number.isFinite(rawUsagePercent) && rawUsagePercent >= 0 ? rawUsagePercent : null;
  const messageCount = count(dataProperty(data, "messageCount"), defaults.messageCount);
  const scannedMessages = count(dataProperty(data, "scannedMessages"), Math.min(messageCount, limits.scannedMessages));
  const oversizedMessages = count(dataProperty(data, "oversizedMessages"), scannedMessages);
  const uninspectableMessages = count(dataProperty(data, "uninspectableMessages"), oversizedMessages);
  const toolErrors = count(dataProperty(data, "toolErrors"), scannedMessages);
  const rawWarnPercent = dataProperty(data, "warnPercent");
  const warnPercent =
    typeof rawWarnPercent === "number" && Number.isFinite(rawWarnPercent) && rawWarnPercent >= 1 && rawWarnPercent <= 100
      ? rawWarnPercent
      : defaults.warnPercent;
  const maxMessageBytes = limit(dataProperty(data, "maxMessageBytes"), 1024 * 1024);
  const normalizedMaxMessageBytes =
    maxMessageBytes === 1024 * 1024 && dataProperty(data, "maxMessageBytes") !== 1024 * 1024 ? defaults.maxMessageBytes : maxMessageBytes;

  const rawRecommendations = dataProperty(data, "recommendations");
  const recommendations: string[] = [];
  let recommendationsTruncated = false;
  if (Array.isArray(rawRecommendations)) {
    const length = arrayLength(rawRecommendations);
    for (let index = 0; index < Math.min(length, limits.displayRecommendations); index += 1) {
      const recommendation = boundedText(dataProperty(rawRecommendations, String(index)), limits.recommendationCharacters);
      if (recommendation === "") {
        recommendationsTruncated = true;
        continue;
      }
      recommendations.push(recommendation);
    }
    recommendationsTruncated ||= length > recommendations.length;
  }

  return {
    status,
    usagePercent,
    tokens: nullableCount(dataProperty(data, "tokens")),
    contextWindow: nullableCount(dataProperty(data, "contextWindow")),
    messageCount,
    scannedMessages,
    messagesTruncated: dataProperty(data, "messagesTruncated") === true || messageCount > scannedMessages,
    oversizedMessages,
    uninspectableMessages,
    toolErrors,
    warnPercent,
    maxMessageBytes: normalizedMaxMessageBytes,
    recommendations,
    recommendationsTruncated,
    compaction: compactionView(dataProperty(data, "compaction"), limits.errorCharacters),
    limits,
  };
}
