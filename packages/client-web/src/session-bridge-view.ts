import { ownArray, ownRecord } from "./panel-safe.js";

const defaults = {
  packageBytes: 262_144,
  packageCharacters: 262_144,
  messages: 100,
  messageCharacters: 16_000,
  totalMessageCharacters: 64_000,
  contentParts: 1_000,
  attachments: 100,
  attachmentMarkerCharacters: 256,
  sessionIdCharacters: 256,
  cwdCharacters: 4_096,
  modelFieldCharacters: 256,
  previewTextCharacters: 1_000,
  previewListItems: 8,
  duplicateScanEntries: 10_000,
  operationErrorCharacters: 2_000,
} as const;

function limit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= fallback ? value : fallback;
}

function boundedString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function boundedCount(value: unknown, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function preview(value: unknown, textLimit: number, listLimit: number) {
  const source = ownRecord(value) ?? {};
  const list = (input: unknown): string[] =>
    (ownArray(input, listLimit) ?? [])
      .slice(0, listLimit)
      .map((item) => boundedString(item, textLimit))
      .filter((item) => item !== "");
  return {
    goal: boundedString(source.goal, textLimit),
    currentState: boundedString(source.currentState, textLimit),
    decisions: list(source.decisions),
    keyFiles: list(source.keyFiles),
    nextStep: boundedString(source.nextStep, textLimit),
  };
}

function bridgeSource(value: unknown, limits: typeof defaults) {
  const source = ownRecord(value);
  if (source === undefined) return null;
  const sessionId = boundedString(source.sessionId, limits.sessionIdCharacters);
  const cwd = boundedString(source.cwd, limits.cwdCharacters);
  if (sessionId === "" || cwd === "") return null;
  let model: { provider: string; modelId: string } | undefined;
  const rawModel = ownRecord(source.model);
  if (rawModel !== undefined) {
    const provider = boundedString(rawModel.provider, limits.modelFieldCharacters);
    const modelId = boundedString(rawModel.modelId, limits.modelFieldCharacters);
    if (provider !== "" && modelId !== "") model = { provider, modelId };
  }
  return { sessionId, cwd, ...(model === undefined ? {} : { model }) };
}

function operationStatus(value: unknown, errorLimit: number) {
  const source = ownRecord(value);
  if (source === undefined) return { state: "idle" as const, operation: null, at: null, error: null };
  const state =
    source.state === "idle" || source.state === "running" || source.state === "completed" || source.state === "failed" || source.state === "cancelled"
      ? source.state
      : "idle";
  const operation = source.operation === "export" || source.operation === "preview" || source.operation === "import" ? source.operation : null;
  const at = timestamp(source.at);
  if (state !== "idle" && operation === null) return { state: "idle" as const, operation: null, at: null, error: null };
  if ((state === "completed" || state === "failed" || state === "cancelled") && at === null)
    return { state: "idle" as const, operation: null, at: null, error: null };
  const error = state === "failed" || state === "cancelled" ? boundedString(source.error, errorLimit) || null : null;
  return { state, operation, at, error };
}

export function sessionBridgePanelView(data: unknown) {
  const source = ownRecord(data) ?? {};
  const rawLimits = ownRecord(source.limits) ?? {};
  const limits = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, limit(rawLimits[key], fallback)])) as unknown as typeof defaults;
  const rawLatest = ownRecord(source.latest);
  const direction = rawLatest?.direction === "export" || rawLatest?.direction === "import" ? rawLatest.direction : undefined;
  const latestSessionId = boundedString(rawLatest?.sessionId, limits.sessionIdCharacters);
  const latestMessages = boundedCount(rawLatest?.messages, limits.messages);
  const latestAttachments = boundedCount(rawLatest?.attachments, limits.attachments);
  const latestAt = timestamp(rawLatest?.at);
  const latest =
    direction === undefined || latestSessionId === "" || latestMessages === null || latestAttachments === null || latestAt === null
      ? null
      : { direction, sessionId: latestSessionId, messages: latestMessages, attachments: latestAttachments, at: latestAt };
  const rawLatestPreviewCandidate = ownRecord(source.latestPreview);
  const rawLatestPreview =
    rawLatestPreviewCandidate !== undefined && ownRecord(rawLatestPreviewCandidate.preview) !== undefined ? rawLatestPreviewCandidate : undefined;
  const latestSource = bridgeSource(rawLatestPreview?.source, limits);
  const selectedPreview = rawLatestPreview === undefined ? source.currentPreview : rawLatestPreview.preview;
  return {
    latest,
    source: rawLatestPreview === undefined ? null : latestSource,
    preview: preview(selectedPreview, limits.previewTextCharacters, limits.previewListItems),
    previewAt: rawLatestPreview === undefined ? null : timestamp(rawLatestPreview.at),
    previewTruncated: rawLatestPreview?.truncated === true,
    status: operationStatus(source.status, limits.operationErrorCharacters),
    formatVersion: 1 as const,
    limits,
  };
}
