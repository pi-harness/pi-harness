export interface ClientAnnotation {
  id: number;
  quote: string;
  note: string;
  revision?: string;
}

export function isClientAnnotation(entry: unknown): entry is ClientAnnotation {
  if (entry === null || typeof entry !== "object") return false;
  const value = entry as Partial<ClientAnnotation>;
  return (
    Number.isSafeInteger(value.id) &&
    typeof value.quote === "string" &&
    typeof value.note === "string" &&
    (value.revision === undefined || (typeof value.revision === "string" && value.revision.length > 0 && value.revision.length <= 128))
  );
}

export function sameAnnotation(left: ClientAnnotation, right: ClientAnnotation): boolean {
  return left.id === right.id && left.quote === right.quote && left.note === right.note && left.revision === right.revision;
}

export interface ClientAnnotationDraft {
  readonly sessionId: string | undefined;
  readonly annotations: readonly ClientAnnotation[];
  readonly selection: string;
  readonly note: string;
}

const annotationHeader = "[Pi Harness annotations]";
const annotationFooter = "[/Pi Harness annotations]";
const questionMarker = "\n\n提问：";
const annotationDraftStorageKeyPrefix = "pi-harness.annotation-draft";

const emptyAnnotationDraft = (sessionId?: string): ClientAnnotationDraft => ({ sessionId, annotations: [], selection: "", note: "" });

export function readStoredAnnotationDraft(storage: Pick<Storage, "getItem"> | undefined, sessionId: string | undefined): ClientAnnotationDraft {
  if (sessionId === undefined) return emptyAnnotationDraft();
  try {
    const raw = storage?.getItem(`${annotationDraftStorageKeyPrefix}.${sessionId}`);
    if (raw === null || raw === undefined) return emptyAnnotationDraft(sessionId);
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return emptyAnnotationDraft(sessionId);
    const candidate = parsed as Partial<ClientAnnotationDraft>;
    if (candidate.sessionId !== sessionId || !Array.isArray(candidate.annotations)) return emptyAnnotationDraft(sessionId);
    if (typeof candidate.selection !== "string" || typeof candidate.note !== "string") return emptyAnnotationDraft(sessionId);
    const annotations = candidate.annotations.filter(isClientAnnotation);
    if (annotations.length !== candidate.annotations.length) return emptyAnnotationDraft(sessionId);
    return { sessionId: candidate.sessionId, annotations, selection: candidate.selection, note: candidate.note };
  } catch {
    return emptyAnnotationDraft(sessionId);
  }
}

export function writeStoredAnnotationDraft(storage: Pick<Storage, "removeItem" | "setItem"> | undefined, draft: ClientAnnotationDraft): void {
  if (storage === undefined) return;
  const sessionId = draft.sessionId;
  if (sessionId === undefined) return;
  try {
    if (draft.annotations.length === 0 && draft.selection === "" && draft.note === "") {
      clearStoredAnnotationDraft(storage, sessionId);
      return;
    }
    storage.setItem(`${annotationDraftStorageKeyPrefix}.${sessionId}`, JSON.stringify(draft));
  } catch {
    // A blocked or full storage area must not prevent the composer from working in memory.
  }
}

export function clearStoredAnnotationDraft(storage: Pick<Storage, "removeItem"> | undefined, sessionId: string | undefined): void {
  if (storage === undefined || sessionId === undefined) return;
  try {
    storage.removeItem(`${annotationDraftStorageKeyPrefix}.${sessionId}`);
  } catch {
    // A blocked storage area must not prevent an accepted prompt from completing.
  }
}

export interface StoredAnnotationSubmission {
  readonly requestId: string;
  readonly annotations: readonly ClientAnnotation[];
}

const annotationSubmissionStorageKeyPrefix = "pi-harness.annotation-submissions";

export function readStoredAnnotationSubmissions(
  storage: Pick<Storage, "getItem"> | undefined,
  sessionId: string | undefined,
): readonly StoredAnnotationSubmission[] {
  if (storage === undefined || sessionId === undefined) return [];
  try {
    const raw = storage.getItem(`${annotationSubmissionStorageKeyPrefix}.${sessionId}`);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return [];
    const value = parsed as { sessionId?: unknown; submissions?: unknown };
    if (value.sessionId !== sessionId || !Array.isArray(value.submissions)) return [];
    const submissions: StoredAnnotationSubmission[] = [];
    for (const item of value.submissions) {
      if (item === null || typeof item !== "object") return [];
      const submission = item as { requestId?: unknown; annotations?: unknown };
      if (
        typeof submission.requestId !== "string" ||
        submission.requestId.length === 0 ||
        submission.requestId.length > 128 ||
        !Array.isArray(submission.annotations) ||
        !submission.annotations.every(isClientAnnotation)
      )
        return [];
      submissions.push({ requestId: submission.requestId, annotations: submission.annotations });
    }
    return submissions;
  } catch {
    return [];
  }
}

function writeStoredAnnotationSubmissions(
  storage: Pick<Storage, "removeItem" | "setItem"> | undefined,
  sessionId: string | undefined,
  submissions: readonly StoredAnnotationSubmission[],
): void {
  if (storage === undefined || sessionId === undefined) return;
  try {
    const key = `${annotationSubmissionStorageKeyPrefix}.${sessionId}`;
    if (submissions.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ sessionId, submissions }));
  } catch {
    // Browser storage may be blocked or full; the live submission still retains its annotation snapshot.
  }
}

export function rememberAnnotationSubmission(
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem"> | undefined,
  sessionId: string | undefined,
  requestId: string,
  annotations: readonly ClientAnnotation[],
): void {
  if (annotations.length === 0) return;
  const previous = readStoredAnnotationSubmissions(storage, sessionId).filter(
    (submission) => submission.requestId !== requestId && submission.annotations.some((sent) => annotations.some((current) => sameAnnotation(current, sent))),
  );
  writeStoredAnnotationSubmissions(storage, sessionId, [...previous, { requestId, annotations }]);
}

export function forgetAnnotationSubmission(
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem"> | undefined,
  sessionId: string | undefined,
  requestId: string,
): void {
  const previous = readStoredAnnotationSubmissions(storage, sessionId);
  const next = previous.filter((submission) => submission.requestId !== requestId);
  if (previous.length !== next.length) writeStoredAnnotationSubmissions(storage, sessionId, next);
}

export function annotationDraftForSession(state: ClientAnnotationDraft, sessionId: string | undefined): ClientAnnotationDraft {
  return state.sessionId === sessionId ? state : { sessionId, annotations: [], selection: "", note: "" };
}

export function annotationDraftDuringSessionRestore(
  state: ClientAnnotationDraft,
  restored: ClientAnnotationDraft,
  sessionId: string,
  restorePending: boolean,
): ClientAnnotationDraft {
  if (restorePending || state.sessionId === sessionId) return state;
  return annotationDraftForSession(restored, sessionId);
}

export function clearSubmittedAnnotations(
  state: ClientAnnotationDraft,
  submittedSessionId: string | undefined,
  submitted: readonly ClientAnnotation[],
): ClientAnnotationDraft {
  if (state.sessionId !== submittedSessionId || submitted.length === 0) return state;
  const annotations = state.annotations.filter((annotation) => !submitted.some((sent) => sameAnnotation(annotation, sent)));
  return annotations.length === state.annotations.length ? state : { ...state, annotations };
}

export function clearStoredSubmittedAnnotations(
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem"> | undefined,
  submittedSessionId: string | undefined,
  submitted: readonly ClientAnnotation[],
): void {
  if (submitted.length === 0) return;
  const current = readStoredAnnotationDraft(storage, submittedSessionId);
  const next = clearSubmittedAnnotations(current, submittedSessionId, submitted);
  if (next !== current) writeStoredAnnotationDraft(storage, next);
}

export function captureSelectionForSession(
  state: ClientAnnotationDraft,
  scheduledSessionId: string | undefined,
  activeSessionId: string | undefined,
  selection: string,
): ClientAnnotationDraft {
  if (scheduledSessionId !== activeSessionId) return state;
  return { ...annotationDraftForSession(state, activeSessionId), selection };
}

export function formatAnnotationPrompt(annotations: readonly ClientAnnotation[], question: string): string {
  const lines = annotations.flatMap((annotation) => [
    `${annotation.id}. ${annotation.quote}`,
    ...(annotation.note === "" ? [] : [`   批注：${annotation.note}`]),
  ]);
  const instruction = annotations.map((annotation) => `Annotation ${annotation.id}：`).join("、");
  return `${annotationHeader}\n${lines.join("\n")}\n${annotationFooter}\n\n请逐条回应 ${instruction}${questionMarker}${question.trim()}`;
}

export function parseAnnotationPrompt(text: string): { question: string; count: number } {
  const marker = text.lastIndexOf(questionMarker);
  if (marker < 0) return { question: text, count: 0 };
  const header = text.lastIndexOf(annotationHeader, marker);
  const footer = text.indexOf(annotationFooter, header);
  if (header < 0 || footer < header) return { question: text, count: 0 };
  const block = text.slice(header + annotationHeader.length, footer);
  const count = block.split("\n").filter((line) => /^\d+\.\s+/u.test(line)).length;
  return { question: text.slice(marker + questionMarker.length), count };
}
