export interface ClientAnnotation {
  id: number;
  quote: string;
  note: string;
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
    const annotations = candidate.annotations.filter(
      (entry): entry is ClientAnnotation =>
        entry !== null &&
        typeof entry === "object" &&
        Number.isSafeInteger((entry as Partial<ClientAnnotation>).id) &&
        typeof (entry as Partial<ClientAnnotation>).quote === "string" &&
        typeof (entry as Partial<ClientAnnotation>).note === "string",
    );
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

export function clearSubmittedAnnotations(state: ClientAnnotationDraft, submittedSessionId: string | undefined): ClientAnnotationDraft {
  return state.sessionId === submittedSessionId ? { ...state, annotations: [] } : state;
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
