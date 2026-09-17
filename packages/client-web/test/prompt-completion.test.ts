import { describe, expect, it } from "vitest";
import { getPromptCompletion, replacePromptCompletion } from "../src/prompt-completion.js";

describe("prompt completion", () => {
  it("detects a slash command token at the start of the prompt", () => {
    expect(getPromptCompletion("/subagents-do", 13)).toEqual({ kind: "command", query: "subagents-do", start: 0, end: 13 });
  });

  // The runtime expands a command only when the prompt begins with it; offered mid-text the list promised an execution that could not happen and the whole line was billed as chat.
  it("offers no command for a slash the runtime would send as prose", () => {
    expect(getPromptCompletion("请检查 /subagents-do", 17)).toBeNull();
    expect(getPromptCompletion("fix the bug /pl", 15)).toBeNull();
    expect(getPromptCompletion("\n/plan", 6)).toBeNull();
  });

  it("detects an at-file token at the caret, wherever the caret is", () => {
    expect(getPromptCompletion("修改 @packages/client", 19)).toEqual({ kind: "file", query: "packages/client", start: 3, end: 19 });
    expect(getPromptCompletion("@calc", 5)).toEqual({ kind: "file", query: "calc", start: 0, end: 5 });
  });

  it("replaces only the active token and returns the next caret", () => {
    const completion = getPromptCompletion("/subagents-do 后续", 13);
    expect(completion).not.toBeNull();
    expect(replacePromptCompletion("/subagents-do 后续", completion!, "/subagents-doctor")).toEqual({
      text: "/subagents-doctor 后续",
      caret: 17,
    });
  });
});
