export interface FailureView {
  readonly time: string | null;
  readonly source: string;
  readonly message: string;
  readonly occurrences: number;
}

export interface FailLoggerPanelView {
  readonly total: number;
  readonly observed: number;
  readonly dropped: number;
  readonly capacity: number;
  readonly failures: readonly FailureView[];
  readonly truncated: boolean;
}

const failureLimit = 50;
const sourceLimit = 64;
const messageLimit = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function dataProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? ownDataProperty(value, key) : undefined;
}

function arrayLength(value: unknown): number | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
  } catch {
    return undefined;
  }
  const length = ownDataProperty(value, "length");
  return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function positiveCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function capacity(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= failureLimit ? value : failureLimit;
}

function failure(value: unknown): { readonly value: FailureView; readonly truncated: boolean } | undefined {
  if (!isRecord(value)) return undefined;
  const rawSource = dataProperty(value, "source");
  const rawMessage = dataProperty(value, "message");
  if (typeof rawSource !== "string" || typeof rawMessage !== "string") return undefined;
  const rawTime = dataProperty(value, "time");
  const time = typeof rawTime === "string" && rawTime.length <= 64 && Number.isFinite(Date.parse(rawTime)) ? new Date(rawTime).toISOString() : null;
  const normalizedSource = (rawSource.trim() || "runtime").replaceAll("\0", "�");
  const normalizedMessage = (rawMessage.trim() || "未知错误").replaceAll("\0", "�");
  return {
    value: {
      time,
      source: normalizedSource.slice(0, sourceLimit),
      message: normalizedMessage.slice(0, messageLimit),
      occurrences: positiveCount(dataProperty(value, "occurrences"), 1),
    },
    truncated: normalizedSource.length > sourceLimit || normalizedMessage.length > messageLimit || rawSource.includes("\0") || rawMessage.includes("\0"),
  };
}

export function failLoggerPanelView(data: unknown): FailLoggerPanelView {
  const source = isRecord(data) ? data : {};
  const sourceFailures = dataProperty(source, "failures");
  const rawLength = arrayLength(sourceFailures) ?? 0;
  const inspectedLength = Math.min(rawLength, failureLimit);
  const failures: FailureView[] = [];
  let truncated = rawLength > failureLimit;
  for (let index = 0; index < inspectedLength; index += 1) {
    const item = failure(ownDataProperty(sourceFailures, String(index)));
    if (item === undefined) {
      truncated = true;
      continue;
    }
    failures.push(item.value);
    if (item.truncated) truncated = true;
  }
  const total = count(dataProperty(source, "total"), failures.length);
  const observed = Math.max(total, count(dataProperty(source, "observed"), total));
  return {
    total,
    observed,
    dropped: count(dataProperty(source, "dropped"), 0),
    capacity: capacity(dataProperty(source, "capacity")),
    failures,
    truncated,
  };
}
