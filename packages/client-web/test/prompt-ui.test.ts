import { describe, expect, test } from "vitest";
import * as promptUi from "../src/prompt-ui.js";

describe("prompt UI state", () => {
  test("allows a steering submission while the original prompt request is still busy", () => {
    expect(promptUi.promptDelivery(false, "ready")).toBe("prompt");
    expect(promptUi.promptDelivery(true, "ready")).toBeUndefined();
    expect(promptUi.promptDelivery(true, "running")).toBe("steer");
    expect(promptUi.promptDelivery(false, "running")).toBe("steer");
  });

  test("clears private composer state when the active session changes", () => {
    const previous = {
      sessionId: "session-one",
      draft: "private unfinished prompt",
      pendingPrompt: "private pending prompt",
      busy: true,
      error: "private error",
      submissionId: 4,
    };

    expect(promptUi.promptUiForSession(previous, "session-one")).toBe(previous);
    const second = promptUi.promptUiForSession(previous, "session-two");
    expect(second).toEqual({
      sessionId: "session-two",
      draft: "",
      pendingPrompt: "",
      busy: false,
      error: "",
    });
    expect(promptUi.promptUiForSession(second, "session-one")).toEqual({
      sessionId: "session-one",
      draft: "",
      pendingPrompt: "",
      busy: false,
      error: "",
    });
    expect(promptUi.promptUiForSession(previous, undefined)).toEqual({ sessionId: undefined, draft: "", pendingPrompt: "", busy: false, error: "" });
  });

  test("ignores completion from a submission discarded by navigation", () => {
    const submitted = promptUi.startPromptSubmission(
      { sessionId: "session-one", draft: "question", pendingPrompt: "", busy: false, error: "" },
      "session-one",
      7,
      "question",
    );
    expect(submitted).toEqual({ sessionId: "session-one", draft: "", pendingPrompt: "question", busy: true, error: "", submissionId: 7 });

    const replacement = promptUi.promptUiForSession(submitted, "session-two");
    expect(promptUi.failPromptSubmission(replacement, 7, "question", "old failure")).toBe(replacement);
    expect(promptUi.finishPromptSubmission(replacement, 7)).toBe(replacement);

    const returned = promptUi.promptUiForSession(replacement, "session-one");
    expect(promptUi.failPromptSubmission(returned, 7, "question", "old failure")).toBe(returned);
    expect(promptUi.finishPromptSubmission(returned, 7)).toBe(returned);
  });

  test("restores a rejected prompt only when its current draft is empty", () => {
    const submitted = promptUi.startPromptSubmission(
      { sessionId: "session-one", draft: "question", pendingPrompt: "", busy: false, error: "" },
      "session-one",
      8,
      "question",
    );
    expect(promptUi.failPromptSubmission(submitted, 8, "question", "rejected")).toEqual({
      sessionId: "session-one",
      draft: "question",
      pendingPrompt: "",
      busy: false,
      error: "rejected",
    });

    const withReplacementDraft = { ...submitted, draft: "new draft" };
    expect(promptUi.failPromptSubmission(withReplacementDraft, 8, "question", "rejected")).toEqual({
      sessionId: "session-one",
      draft: "new draft",
      pendingPrompt: "",
      busy: false,
      error: "rejected",
    });
  });

  test("a stable draft writer follows the latest session instead of its creation session", () => {
    let sessionId: string | undefined = "session-one";
    let state = { sessionId, draft: "", pendingPrompt: "", busy: false, error: "" };
    const stableWrite = (value: string) => {
      state = promptUi.updatePromptDraft(state, sessionId, value);
    };

    sessionId = "session-two";
    stableWrite("/review ");

    expect(state).toEqual({ sessionId: "session-two", draft: "/review ", pendingPrompt: "", busy: false, error: "" });
  });

  test("does not report a successful prompt as rejected when its refresh fails", async () => {
    const events: string[] = [];

    await promptUi.runPromptSubmission(
      () => Promise.resolve(),
      () => Promise.reject(new Error("refresh failed")),
      {
        accepted: () => events.push("accepted"),
        rejected: () => events.push("rejected"),
        refreshRejected: () => events.push("refresh-rejected"),
        settled: () => events.push("settled"),
      },
    );

    expect(events).toEqual(["accepted", "refresh-rejected", "settled"]);
  });
});
