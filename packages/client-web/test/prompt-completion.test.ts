import { describe, expect, it } from "vitest";
import { getPromptCompletion, replacePromptCompletion } from "../src/prompt-completion.js";

describe("prompt completion", () => {
  it("detects a slash command token at the caret", () => {
    expect(getPromptCompletion("请检查 /subagents-do", 17)).toEqual({ kind: "command", query: "subagents-do", start: 4, end: 17 });
  });

  it("detects an at-file token at the caret", () => {
    expect(getPromptCompletion("修改 @packages/client", 19)).toEqual({ kind: "file", query: "packages/client", start: 3, end: 19 });
  });

  it("replaces only the active token and returns the next caret", () => {
    const completion = getPromptCompletion("请检查 /subagents-do 后续", 17);
    expect(completion).not.toBeNull();
    expect(replacePromptCompletion("请检查 /subagents-do 后续", completion!, "/subagents-doctor")).toEqual({
      text: "请检查 /subagents-doctor 后续",
      caret: 21,
    });
  });
});
