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

export function annotationDraftForSession(state: ClientAnnotationDraft, sessionId: string | undefined): ClientAnnotationDraft {
  return state.sessionId === sessionId ? state : { sessionId, annotations: [], selection: "", note: "" };
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
