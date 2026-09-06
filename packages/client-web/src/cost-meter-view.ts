export interface CostMeterHistoryItem {
  readonly sessionId: string;
  readonly utcDate: string;
  readonly dailyCost: number;
  readonly sessionCost: number;
  readonly tokens: number;
  readonly messages: number;
}

export interface CostMeterPanelView {
  readonly dayBasis: "UTC";
  readonly entryLimit: number | null;
  readonly lastError: string | null;
  readonly entries: readonly CostMeterHistoryItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function historyItem(value: unknown): CostMeterHistoryItem | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId.trim() === "" ||
    value.sessionId.length > 512 ||
    !finiteNonNegative(value.cost) ||
    !finiteNonNegative(value.sessionCost) ||
    !Number.isSafeInteger(value.tokens) ||
    (value.tokens as number) < 0 ||
    !Number.isSafeInteger(value.messages) ||
    (value.messages as number) < 0 ||
    typeof value.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(value.recordedAt))
  )
    return undefined;
  return {
    sessionId: value.sessionId,
    utcDate: new Date(value.recordedAt).toISOString().slice(0, 10),
    dailyCost: value.cost,
    sessionCost: value.sessionCost,
    tokens: value.tokens as number,
    messages: value.messages as number,
  };
}

export function costMeterPanelView(data: unknown): CostMeterPanelView {
  const source = isRecord(data) ? data : {};
  const entryLimit =
    Number.isSafeInteger(source.entryLimit) && (source.entryLimit as number) >= 1 && (source.entryLimit as number) <= 2_000
      ? (source.entryLimit as number)
      : null;
  const lastError = typeof source.lastError === "string" && source.lastError.trim() !== "" ? source.lastError.slice(0, 2_048) : null;
  const entries = (Array.isArray(source.entries) ? source.entries.slice(0, 20) : [])
    .map(historyItem)
    .filter((entry): entry is CostMeterHistoryItem => entry !== undefined)
    .slice(0, 5);
  return { dayBasis: "UTC", entryLimit, lastError, entries };
}
