export interface HistoryCompressorPanelView {
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly thresholdPercent: number | null;
  readonly compactions: number;
  readonly lastUsagePercent: number | null;
  readonly queued: boolean;
  readonly lastError: string | null;
  readonly malformed: boolean;
}

const keys = new Set(["sessionId", "enabled", "thresholdPercent", "compactions", "lastUsagePercent", "queued", "lastError"]);

function malformedView(): HistoryCompressorPanelView {
  return {
    sessionId: "",
    enabled: false,
    thresholdPercent: null,
    compactions: 0,
    lastUsagePercent: null,
    queued: false,
    lastError: null,
    malformed: true,
  };
}

function ownDataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key))) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

export function historyCompressorPanelView(data: unknown, activeSessionId?: string): HistoryCompressorPanelView {
  const source = ownDataRecord(data);
  if (source === undefined) return malformedView();
  const sessionId = source.sessionId;
  const thresholdPercent = source.thresholdPercent;
  const compactions = source.compactions;
  const lastUsagePercent = source.lastUsagePercent;
  const lastError = source.lastError;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > 512 ||
    /[\0\p{Cc}]/u.test(sessionId) ||
    (activeSessionId !== undefined && sessionId !== activeSessionId) ||
    typeof source.enabled !== "boolean" ||
    typeof thresholdPercent !== "number" ||
    !Number.isFinite(thresholdPercent) ||
    thresholdPercent < 1 ||
    thresholdPercent > 100 ||
    typeof compactions !== "number" ||
    !Number.isSafeInteger(compactions) ||
    compactions < 0 ||
    (lastUsagePercent !== null &&
      (typeof lastUsagePercent !== "number" || !Number.isFinite(lastUsagePercent) || lastUsagePercent < 0 || lastUsagePercent > 1_000_000)) ||
    typeof source.queued !== "boolean" ||
    (lastError !== null && (typeof lastError !== "string" || lastError.length === 0 || lastError.length > 2_000 || lastError.includes("\0")))
  )
    return malformedView();
  return {
    sessionId,
    enabled: source.enabled,
    thresholdPercent,
    compactions,
    lastUsagePercent,
    queued: source.queued,
    lastError,
    malformed: false,
  };
}
