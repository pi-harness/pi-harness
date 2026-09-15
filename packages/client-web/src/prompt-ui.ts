import { isClientAnnotation, sameAnnotation, type ClientAnnotation } from "./annotation-ui.js";
export class AcceptedPromptError extends Error {
  override readonly name = "AcceptedPromptError";
}

export function acceptedPromptReceipt(
  entries: readonly unknown[],
  sessionId: string | undefined,
  requestId: string | undefined,
): { persistenceError?: string } | undefined {
  if (sessionId === undefined || requestId === undefined) return undefined;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (candidate.type !== "custom" || candidate.customType !== "pi-harness.prompt-receipt" || candidate.data === null || typeof candidate.data !== "object")
      continue;
    const data = candidate.data as { sessionId?: unknown; requestId?: unknown; persistenceError?: unknown };
    if (data.sessionId === sessionId && data.requestId === requestId)
      return typeof data.persistenceError === "string" ? { persistenceError: data.persistenceError } : {};
  }
  return undefined;
}

export function hasAcceptedPromptReceipt(entries: readonly unknown[], sessionId: string | undefined, requestId: string | undefined): boolean {
  return acceptedPromptReceipt(entries, sessionId, requestId) !== undefined;
}

export interface ClientPromptUiState {
  readonly sessionId: string | undefined;
  readonly draft: string;
  readonly pendingPrompt: string;
  readonly busy: boolean;
  readonly error: string;
  readonly draftRevision?: string;
  readonly submissionId?: number;
}

const promptDraftStorageKeyPrefix = "pi-harness.prompt-draft";
const maxStoredPromptDraftCharacters = 128_000;
const maxStoredPromptDraftPayloadCharacters = maxStoredPromptDraftCharacters * 12 + 512;
let nextPromptDraftRevision = 0;

export interface StoredPromptDraft {
  readonly sessionId: string;
  readonly draft: string;
  readonly revision: string;
  readonly submission?: { readonly prompt: string; readonly delivery: "prompt" | "steer"; readonly annotations?: readonly ClientAnnotation[] };
}

export function createPromptDraftRevision(): string {
  nextPromptDraftRevision += 1;
  try {
    const revision = globalThis.crypto?.randomUUID?.();
    if (revision) return revision;
  } catch {
    // The monotonic fallback still distinguishes edits when secure randomness is unavailable.
  }
  return `${Date.now().toString(36)}-${nextPromptDraftRevision.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function readStoredPromptDraftSnapshot(storage: Pick<Storage, "getItem"> | undefined, sessionId: string | undefined): StoredPromptDraft | undefined {
  if (storage === undefined || sessionId === undefined) return undefined;
  try {
    const raw = storage.getItem(`${promptDraftStorageKeyPrefix}.${sessionId}`);
    if (raw === null || raw.length > maxStoredPromptDraftPayloadCharacters) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const candidate = parsed as { sessionId?: unknown; draft?: unknown; revision?: unknown; submission?: unknown };
    if (candidate.sessionId !== sessionId || typeof candidate.draft !== "string" || typeof candidate.revision !== "string") return undefined;
    if (candidate.draft.length > maxStoredPromptDraftCharacters || candidate.revision.length === 0 || candidate.revision.length > 128) return undefined;
    let submission: StoredPromptDraft["submission"];
    if (candidate.submission !== undefined) {
      if (candidate.submission === null || typeof candidate.submission !== "object") return undefined;
      const value = candidate.submission as { prompt?: unknown; delivery?: unknown; annotations?: unknown };
      if (
        typeof value.prompt !== "string" ||
        value.prompt.length > maxStoredPromptDraftCharacters ||
        (value.delivery !== "prompt" && value.delivery !== "steer")
      )
        return undefined;
      if (value.annotations !== undefined && (!Array.isArray(value.annotations) || !value.annotations.every(isClientAnnotation))) return undefined;
      submission = {
        prompt: value.prompt,
        delivery: value.delivery,
        ...(value.annotations === undefined ? {} : { annotations: value.annotations }),
      };
    }
    return { sessionId, draft: candidate.draft, revision: candidate.revision, ...(submission === undefined ? {} : { submission }) };
  } catch {
    return undefined;
  }
}

export function readStoredPromptDraft(storage: Pick<Storage, "getItem"> | undefined, sessionId: string | undefined): string {
  try {
    return readStoredPromptDraftSnapshot(storage, sessionId)?.draft ?? "";
  } catch {
    return "";
  }
}

export function writeStoredPromptDraft(
  storage: Pick<Storage, "removeItem" | "setItem"> | undefined,
  sessionId: string | undefined,
  draft: string,
  draftRevision = createPromptDraftRevision(),
  submission?: StoredPromptDraft["submission"],
): string | undefined {
  if (storage === undefined || sessionId === undefined) return undefined;
  try {
    if ((draft === "" && submission === undefined) || draft.length > maxStoredPromptDraftCharacters) {
      clearStoredPromptDraft(storage, sessionId);
      return undefined;
    }
    const payload = JSON.stringify({ sessionId, draft, revision: draftRevision, ...(submission === undefined ? {} : { submission }) });
    if (payload.length > maxStoredPromptDraftPayloadCharacters) {
      clearStoredPromptDraft(storage, sessionId);
      return undefined;
    }
    storage.setItem(`${promptDraftStorageKeyPrefix}.${sessionId}`, payload);
    return draftRevision;
  } catch {
    // A blocked or full storage area must not prevent the composer from working in memory.
    return undefined;
  }
}

export function clearStoredPromptDraft(storage: Pick<Storage, "removeItem"> | undefined, sessionId: string | undefined): void {
  if (storage === undefined || sessionId === undefined) return;
  try {
    storage.removeItem(`${promptDraftStorageKeyPrefix}.${sessionId}`);
  } catch {
    // A blocked storage area must not prevent an accepted prompt from completing.
  }
}

export function clearSubmittedPromptDraft(
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined,
  sessionId: string | undefined,
  submittedRevision: string | undefined,
): boolean {
  if (submittedRevision === undefined) return false;
  try {
    if (readStoredPromptDraftSnapshot(storage, sessionId)?.revision !== submittedRevision) return false;
    clearStoredPromptDraft(storage, sessionId);
    return true;
  } catch {
    return false;
  }
}

export function restoreRejectedPromptDraft(
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem"> | undefined,
  sessionId: string | undefined,
  submittedRevision: string | undefined,
  submittedDraft: string,
  submission?: StoredPromptDraft["submission"],
): void {
  try {
    const current = readStoredPromptDraftSnapshot(storage, sessionId);
    if (current === undefined) writeStoredPromptDraft(storage, sessionId, submittedDraft, submittedRevision, submission);
    else if (current.revision === submittedRevision) return;
  } catch {
    // A blocked storage area must not prevent a rejection from restoring the in-memory draft.
  }
}

export function promptSubmissionIdentity(
  saved: StoredPromptDraft | undefined,
  draft: string,
  prompt: string,
  delivery: "prompt" | "steer",
  annotations: readonly ClientAnnotation[] = [],
): { revision: string; delivery: "prompt" | "steer" } {
  const savedAnnotations = saved?.submission?.annotations ?? [];
  const unchangedAnnotations =
    savedAnnotations.length === annotations.length && annotations.every((annotation, index) => sameAnnotation(annotation, savedAnnotations[index]));
  return saved?.draft === draft && saved.submission?.prompt === prompt && unchangedAnnotations
    ? { revision: saved.revision, delivery: saved.submission.delivery }
    : { revision: createPromptDraftRevision(), delivery };
}

export function promptDelivery(promptBusy: boolean, runtimeStatus: string | undefined): "prompt" | "steer" | undefined {
  if (runtimeStatus === "running") return "steer";
  return promptBusy ? undefined : "prompt";
}

export function promptUiForSession(state: ClientPromptUiState, sessionId: string | undefined): ClientPromptUiState {
  return state.sessionId === sessionId ? state : { sessionId, draft: "", pendingPrompt: "", busy: false, error: "" };
}

export function promptUiDuringSessionRestore(
  state: ClientPromptUiState,
  storedDraft: StoredPromptDraft | undefined,
  sessionId: string,
  restorePending: boolean,
): ClientPromptUiState {
  if (restorePending || state.sessionId === sessionId) return state;
  return {
    sessionId,
    draft: storedDraft?.draft ?? "",
    pendingPrompt: "",
    busy: false,
    error: "",
    ...(storedDraft === undefined ? {} : { draftRevision: storedDraft.revision }),
  };
}

export function clearAcceptedPromptDraft(
  state: ClientPromptUiState,
  submittedSessionId: string | undefined,
  submittedDraftRevision: string | undefined,
  submittedVersionCleared: boolean,
): ClientPromptUiState {
  if (!submittedVersionCleared || state.sessionId !== submittedSessionId || state.draftRevision !== submittedDraftRevision) return state;
  const cleared = { ...state };
  delete cleared.draftRevision;
  return { ...cleared, draft: "" };
}

export function updatePromptDraft(
  state: ClientPromptUiState,
  sessionId: string | undefined,
  value: string | ((current: string) => string),
  draftRevision?: string,
): ClientPromptUiState {
  const scoped = promptUiForSession(state, sessionId);
  const draft = typeof value === "function" ? value(scoped.draft) : value;
  const updated = { ...scoped };
  delete updated.draftRevision;
  return { ...updated, draft, ...(draft === "" || draftRevision === undefined ? {} : { draftRevision }) };
}

export function startPromptSubmission(
  state: ClientPromptUiState,
  sessionId: string | undefined,
  submissionId: number,
  prompt: string,
  submittedDraftRevision?: string,
): ClientPromptUiState {
  return {
    ...promptUiForSession(state, sessionId),
    draft: "",
    pendingPrompt: prompt,
    busy: true,
    error: "",
    submissionId,
    ...(submittedDraftRevision === undefined ? {} : { draftRevision: submittedDraftRevision }),
  };
}

export function failPromptSubmission(
  state: ClientPromptUiState,
  submissionId: number,
  question: string,
  error: string,
  submittedRevision?: string,
): ClientPromptUiState {
  if (state.submissionId !== submissionId) return state;
  const failed = { ...state };
  delete failed.submissionId;
  return {
    ...failed,
    draft: state.draft || question,
    ...(state.draft || submittedRevision === undefined ? {} : { draftRevision: submittedRevision }),
    pendingPrompt: "",
    busy: false,
    error,
  };
}

export function finishPromptSubmission(state: ClientPromptUiState, submissionId: number): ClientPromptUiState {
  if (state.submissionId !== submissionId) return state;
  const finished = { ...state };
  delete finished.submissionId;
  return { ...finished, pendingPrompt: "", busy: false };
}

export function reportPromptRefreshFailure(state: ClientPromptUiState, submissionId: number, error: string): ClientPromptUiState {
  return state.submissionId === submissionId ? { ...state, error } : state;
}

export interface PromptSubmissionHandlers {
  readonly accepted: () => void;
  readonly rejected: (cause: unknown) => void;
  readonly refreshRejected: (cause: unknown) => void;
  readonly settled: () => void;
}

export async function runPromptSubmission(submit: () => Promise<unknown>, refresh: () => Promise<unknown>, handlers: PromptSubmissionHandlers): Promise<void> {
  try {
    await submit();
  } catch (cause: unknown) {
    if (cause instanceof AcceptedPromptError) {
      handlers.accepted();
      try {
        await refresh();
      } catch {
        /* The original runtime failure remains the actionable error. */
      }
      handlers.refreshRejected(cause);
    } else handlers.rejected(cause);
    handlers.settled();
    return;
  }
  handlers.accepted();
  try {
    await refresh();
  } catch (cause: unknown) {
    handlers.refreshRejected(cause);
  }
  handlers.settled();
}
