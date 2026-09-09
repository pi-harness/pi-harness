export interface TokenGuardPanelView {
  readonly maxPercent: number;
  readonly maxRunTokens: number;
  readonly percent: number | null;
  readonly tokens: number | null;
  readonly contextWindow: number | null;
  readonly runTokens: number | null;
  readonly runExceeded: boolean;
  readonly exceeded: boolean;
  readonly aborts: number;
  readonly lastError: string | null;
  readonly limits: {
    readonly maxRunTokens: number;
    readonly errorCharacters: number;
    readonly streamingUpdateInterval: number;
  };
}

const defaults = {
  maxPercent: 90,
  maxRunTokens: 10_000_000,
  errorCharacters: 2_000,
  streamingUpdateInterval: 32,
  maxCount: Number.MAX_SAFE_INTEGER,
} as const;

function dataProperty(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function count(value: unknown, maximum: number = defaults.maxCount): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function boundedText(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.replaceAll("\0", "�").slice(0, defaults.errorCharacters);
}

export function tokenGuardPanelView(data: unknown): TokenGuardPanelView {
  const rawMaxPercent = dataProperty(data, "maxPercent");
  const maxPercent =
    typeof rawMaxPercent === "number" && Number.isFinite(rawMaxPercent) && rawMaxPercent >= 1 && rawMaxPercent <= 100 ? rawMaxPercent : defaults.maxPercent;
  const maxRunTokens = count(dataProperty(data, "maxRunTokens"), defaults.maxRunTokens) ?? 0;
  const rawPercent = dataProperty(data, "percent");
  const percent = typeof rawPercent === "number" && Number.isFinite(rawPercent) && rawPercent >= 0 ? rawPercent : null;
  const tokens = count(dataProperty(data, "tokens"));
  const contextWindowValue = count(dataProperty(data, "contextWindow"));
  const contextWindow = contextWindowValue !== null && contextWindowValue > 0 ? contextWindowValue : null;
  const runTokens = count(dataProperty(data, "runTokens"));
  const runExceeded = maxRunTokens > 0 && runTokens !== null && runTokens >= maxRunTokens;
  return {
    maxPercent,
    maxRunTokens,
    percent,
    tokens,
    contextWindow,
    runTokens,
    runExceeded,
    exceeded: (percent !== null && percent >= maxPercent) || runExceeded,
    aborts: count(dataProperty(data, "aborts")) ?? 0,
    lastError: boundedText(dataProperty(data, "lastError")),
    limits: {
      maxRunTokens: defaults.maxRunTokens,
      errorCharacters: defaults.errorCharacters,
      streamingUpdateInterval: defaults.streamingUpdateInterval,
    },
  };
}
