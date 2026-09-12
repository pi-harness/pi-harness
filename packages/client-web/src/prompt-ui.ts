export interface ClientPromptUiState {
  readonly sessionId: string | undefined;
  readonly draft: string;
  readonly pendingPrompt: string;
  readonly busy: boolean;
  readonly error: string;
  readonly submissionId?: number;
}

export function promptUiForSession(state: ClientPromptUiState, sessionId: string | undefined): ClientPromptUiState {
  return state.sessionId === sessionId ? state : { sessionId, draft: "", pendingPrompt: "", busy: false, error: "" };
}

export function updatePromptDraft(
  state: ClientPromptUiState,
  sessionId: string | undefined,
  value: string | ((current: string) => string),
): ClientPromptUiState {
  const scoped = promptUiForSession(state, sessionId);
  return { ...scoped, draft: typeof value === "function" ? value(scoped.draft) : value };
}

export function startPromptSubmission(state: ClientPromptUiState, sessionId: string | undefined, submissionId: number, prompt: string): ClientPromptUiState {
  return {
    ...promptUiForSession(state, sessionId),
    draft: "",
    pendingPrompt: prompt,
    busy: true,
    error: "",
    submissionId,
  };
}

export function failPromptSubmission(state: ClientPromptUiState, submissionId: number, question: string, error: string): ClientPromptUiState {
  if (state.submissionId !== submissionId) return state;
  return {
    sessionId: state.sessionId,
    draft: state.draft || question,
    pendingPrompt: "",
    busy: false,
    error,
  };
}

export function finishPromptSubmission(state: ClientPromptUiState, submissionId: number): ClientPromptUiState {
  if (state.submissionId !== submissionId) return state;
  return { sessionId: state.sessionId, draft: state.draft, pendingPrompt: "", busy: false, error: state.error };
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
    handlers.rejected(cause);
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
