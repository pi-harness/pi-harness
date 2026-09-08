import { t } from "./i18n.js";

const defaults = {
  candidates: 50,
  displayCandidates: 8,
  scannedEntries: 4_096,
  contentParts: 1_000,
  previewCharacters: 500,
  entryIdCharacters: 200,
  editorTextCharacters: 4_096,
  errorCharacters: 2_000,
} as const;

function dataProperty(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function limit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= fallback ? value : fallback;
}

function count(value: unknown, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
}

function text(value: unknown, maximum: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.slice(0, maximum).replaceAll("\0", "�") || fallback;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function candidate(value: unknown, limits: { entryIdCharacters: number; previewCharacters: number }) {
  return {
    entryId: text(dataProperty(value, "entryId"), limits.entryIdCharacters, "unknown"),
    text: text(dataProperty(value, "text"), limits.previewCharacters, t("未命名轮次")),
  };
}

function listedCandidate(value: unknown, limits: { entryIdCharacters: number; previewCharacters: number }) {
  const entryId = dataProperty(value, "entryId");
  const candidateText = dataProperty(value, "text");
  if (typeof entryId !== "string" || typeof candidateText !== "string") return undefined;
  const normalized = {
    entryId: text(entryId, limits.entryIdCharacters),
    text: text(candidateText, limits.previewCharacters),
  };
  return normalized.entryId === "" || normalized.text === "" ? undefined : normalized;
}

type OperationStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

function operation(value: unknown, limits: { entryIdCharacters: number; previewCharacters: number; editorTextCharacters: number; errorCharacters: number }) {
  const rawStatus = dataProperty(value, "status");
  const status: OperationStatus | undefined =
    rawStatus === "queued" || rawStatus === "running" || rawStatus === "completed" || rawStatus === "failed" || rawStatus === "cancelled"
      ? rawStatus
      : undefined;
  if (status === undefined) return null;
  return {
    status,
    target: candidate(dataProperty(value, "target"), limits),
    cancelled: dataProperty(value, "cancelled") === true,
    summarized: dataProperty(value, "summarized") === true,
    editorText: text(dataProperty(value, "editorText"), limits.editorTextCharacters) || null,
    error: status === "failed" || status === "cancelled" ? text(dataProperty(value, "error"), limits.errorCharacters) || null : null,
    requestedAt: timestamp(dataProperty(value, "requestedAt")),
    startedAt: timestamp(dataProperty(value, "startedAt")),
    finishedAt: timestamp(dataProperty(value, "finishedAt")),
  };
}

export function turnRewindPanelView(data: unknown) {
  const rawLimits = dataProperty(data, "limits");
  const limits = {
    candidates: limit(dataProperty(rawLimits, "candidates"), defaults.candidates),
    displayCandidates: defaults.displayCandidates,
    scannedEntries: limit(dataProperty(rawLimits, "scannedEntries"), defaults.scannedEntries),
    contentParts: limit(dataProperty(rawLimits, "contentParts"), defaults.contentParts),
    previewCharacters: limit(dataProperty(rawLimits, "previewCharacters"), defaults.previewCharacters),
    entryIdCharacters: limit(dataProperty(rawLimits, "entryIdCharacters"), defaults.entryIdCharacters),
    editorTextCharacters: limit(dataProperty(rawLimits, "editorTextCharacters"), defaults.editorTextCharacters),
    errorCharacters: limit(dataProperty(rawLimits, "errorCharacters"), defaults.errorCharacters),
  };
  const rawCandidates = dataProperty(data, "candidates");
  const visibleCandidates: Array<{ entryId: string; text: string }> = [];
  if (Array.isArray(rawCandidates)) {
    const start = Math.max(0, rawCandidates.length - Math.min(limits.candidates, limits.displayCandidates));
    for (let index = start; index < rawCandidates.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(rawCandidates, String(index));
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const normalized = listedCandidate(descriptor.value, limits);
      if (normalized !== undefined) visibleCandidates.push(normalized);
    }
  }
  const rawInventory = dataProperty(data, "inventory");
  const displayTruncated = Array.isArray(rawCandidates) && rawCandidates.length > visibleCandidates.length;
  const scanTruncated = dataProperty(rawInventory, "scanTruncated") === true;
  const candidateTruncated = dataProperty(rawInventory, "candidateTruncated") === true;
  return {
    candidates: visibleCandidates,
    inventory: {
      scannedEntries: count(dataProperty(rawInventory, "scannedEntries"), limits.scannedEntries),
      shown: count(dataProperty(rawInventory, "shown"), limits.candidates),
      truncated: dataProperty(rawInventory, "truncated") === true || scanTruncated || candidateTruncated || displayTruncated,
      scanTruncated,
      candidateTruncated,
      displayTruncated,
    },
    latest: operation(dataProperty(data, "latest"), limits),
    limits,
  };
}
