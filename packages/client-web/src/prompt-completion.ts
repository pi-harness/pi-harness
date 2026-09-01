export type PromptCompletionKind = "command" | "file";

export interface PromptCompletion {
  readonly kind: PromptCompletionKind;
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

export function getPromptCompletion(text: string, caret: number): PromptCompletion | null {
  const position = Math.max(0, Math.min(caret, text.length));
  const tokenStart = Math.max(text.lastIndexOf(" ", position - 1), text.lastIndexOf("\n", position - 1)) + 1;
  const token = text.slice(tokenStart, position);
  const trigger = token[0];
  if (trigger !== "/" && trigger !== "@") return null;
  const query = token.slice(1);
  if (/\s/.test(query)) return null;
  return { kind: trigger === "/" ? "command" : "file", query, start: tokenStart, end: position };
}

export function replacePromptCompletion(text: string, completion: PromptCompletion, value: string): { text: string; caret: number } {
  const nextText = `${text.slice(0, completion.start)}${value}${text.slice(completion.end)}`;
  return { text: nextText, caret: completion.start + value.length };
}
