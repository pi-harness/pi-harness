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
  // The runtime only expands a command when the whole prompt starts with "/", and a slash anywhere else is sent to the model as prose. Offering the command list mid-text therefore promised an execution that could not happen and billed the turn as chat instead. A file reference has no such rule and stays available at any caret.
  if (trigger === "/" && tokenStart !== 0) return null;
  const query = token.slice(1);
  if (/\s/.test(query)) return null;
  return { kind: trigger === "/" ? "command" : "file", query, start: tokenStart, end: position };
}

export function replacePromptCompletion(text: string, completion: PromptCompletion, value: string): { text: string; caret: number } {
  // The value carries the separator the caret lands after, so it must not be doubled when what follows the replaced token already begins with one: the runtime hands a command everything after the first space as its arguments, which means a second space is not cosmetic but the first character of the argument the handler receives.
  const tail = text.slice(completion.end);
  const nextText = `${text.slice(0, completion.start)}${value}${value.endsWith(" ") && tail.startsWith(" ") ? tail.slice(1) : tail}`;
  return { text: nextText, caret: completion.start + value.length };
}
