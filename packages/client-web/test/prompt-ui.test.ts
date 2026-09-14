import { describe, expect, test } from "vitest";
import * as promptUi from "../src/prompt-ui.js";

describe("prompt UI state", () => {
  test("restores a session-scoped prompt draft after navigation and reload", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    promptUi.writeStoredPromptDraft(storage, "session-one", "private first-session draft");
    promptUi.writeStoredPromptDraft(storage, "session-two", "private second-session draft");

    expect(promptUi.readStoredPromptDraft(storage, "session-one")).toBe("private first-session draft");
    expect(promptUi.readStoredPromptDraft(storage, "session-two")).toBe("private second-session draft");
  });

  test("waits for URL session restoration before applying a stored prompt draft", () => {
    const urlSession = { sessionId: "url-session", draft: "keep me", pendingPrompt: "", busy: false, error: "" };

    expect(
      promptUi.promptUiDuringSessionRestore(
        urlSession,
        { sessionId: "temporary-runtime-session", draft: "wrong draft", revision: "wrong-revision" },
        "temporary-runtime-session",
        true,
      ),
    ).toBe(urlSession);
    expect(
      promptUi.promptUiDuringSessionRestore(
        urlSession,
        { sessionId: "target-session", draft: "restored target draft", revision: "target-revision" },
        "target-session",
        false,
      ),
    ).toEqual({
      sessionId: "target-session",
      draft: "restored target draft",
      draftRevision: "target-revision",
      pendingPrompt: "",
      busy: false,
      error: "",
    });
  });

  test("clears empty drafts and discards invalid or oversized stored prompt data", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    promptUi.writeStoredPromptDraft(storage, "session-one", "saved");
    promptUi.writeStoredPromptDraft(storage, "session-one", "");
    expect(promptUi.readStoredPromptDraft(storage, "session-one")).toBe("");

    promptUi.writeStoredPromptDraft(storage, "session-one", "saved again");
    promptUi.clearStoredPromptDraft(storage, "session-one");
    expect(promptUi.readStoredPromptDraft(storage, "session-one")).toBe("");
    expect(promptUi.readStoredPromptDraft({ getItem: () => "{" }, "session-one")).toBe("");
    expect(promptUi.readStoredPromptDraft({ getItem: () => JSON.stringify({ sessionId: "wrong-session", draft: "leak" }) }, "session-one")).toBe("");
    expect(promptUi.readStoredPromptDraft({ getItem: () => JSON.stringify({ sessionId: "session-one", draft: 42 }) }, "session-one")).toBe("");
    expect(promptUi.readStoredPromptDraft({ getItem: () => JSON.stringify({ sessionId: "session-one", draft: "x".repeat(128_001) }) }, "session-one")).toBe("");

    const escapedDraft = "\n".repeat(100_000);
    promptUi.writeStoredPromptDraft(storage, "session-one", escapedDraft);
    expect(promptUi.readStoredPromptDraft(storage, "session-one")).toBe(escapedDraft);

    promptUi.writeStoredPromptDraft(storage, "session-one", "saved before oversized input");
    promptUi.writeStoredPromptDraft(storage, "session-one", "x".repeat(128_001));
    expect(promptUi.readStoredPromptDraft(storage, "session-one")).toBe("");
  });

  test("keeps the composer usable when prompt draft storage is blocked", () => {
    const blocked = () => {
      throw new Error("storage blocked");
    };

    expect(promptUi.readStoredPromptDraft({ getItem: blocked }, "session-one")).toBe("");
    expect(() => promptUi.writeStoredPromptDraft({ removeItem: blocked, setItem: blocked }, "session-one", "keep in memory")).not.toThrow();
    expect(() => promptUi.writeStoredPromptDraft({ removeItem: blocked, setItem: blocked }, "session-one", "")).not.toThrow();
  });

  test("keeps the submitted draft stored while delivery is pending across navigation", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const draft = "retry this request if delivery fails";
    const submittedRevision = promptUi.writeStoredPromptDraft(storage, "session-one", draft);

    const submitted = promptUi.startPromptSubmission({ sessionId: "session-one", draft, pendingPrompt: "", busy: false, error: "" }, "session-one", 9, draft);
    promptUi.promptUiForSession(submitted, "session-two");

    expect(promptUi.readStoredPromptDraft(storage, "session-one")).toBe(draft);
    promptUi.clearStoredPromptDraft(storage, "session-one");
    promptUi.restoreRejectedPromptDraft(storage, "session-one", submittedRevision, draft);
    expect(promptUi.readStoredPromptDraft(storage, "session-one")).toBe(draft);

    const storageKey = [...values.keys()][0];
    expect(storageKey).toBeDefined();
    if (storageKey === undefined) return;
    values.set(storageKey, "{");
    promptUi.restoreRejectedPromptDraft(storage, "session-one", submittedRevision, draft);
    expect(promptUi.readStoredPromptDraft(storage, "session-one")).toBe(draft);
  });

  test("clears only the submitted stored version after acceptance", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    const submittedRevision = promptUi.writeStoredPromptDraft(storage, "session-one", "submitted draft");
    const submitted = promptUi.startPromptSubmission(
      { sessionId: "session-one", draft: "submitted draft", pendingPrompt: "", busy: false, error: "" },
      "session-one",
      11,
      "submitted draft",
      submittedRevision,
    );
    const otherSession = promptUi.promptUiForSession(submitted, "session-two");
    const restored = promptUi.promptUiDuringSessionRestore(otherSession, promptUi.readStoredPromptDraftSnapshot(storage, "session-one"), "session-one", false);
    const submittedVersionCleared = promptUi.clearSubmittedPromptDraft(storage, "session-one", submittedRevision);
    expect(promptUi.readStoredPromptDraft(storage, "session-one")).toBe("");
    expect(promptUi.clearAcceptedPromptDraft(restored, "session-one", submittedRevision, submittedVersionCleared)).toEqual({
      sessionId: "session-one",
      draft: "",
      pendingPrompt: "",
      busy: false,
      error: "",
    });

    const replacementRevision = promptUi.createPromptDraftRevision();
    const sameTextReplacement = { ...restored, draft: "submitted draft", draftRevision: replacementRevision };
    promptUi.writeStoredPromptDraft(storage, "session-one", sameTextReplacement.draft, replacementRevision);
    const replacementVersionCleared = promptUi.clearSubmittedPromptDraft(storage, "session-one", submittedRevision);
    expect(replacementVersionCleared).toBe(false);
    expect(promptUi.readStoredPromptDraft(storage, "session-one")).toBe("submitted draft");
    expect(promptUi.clearAcceptedPromptDraft(sameTextReplacement, "session-one", submittedRevision, replacementVersionCleared)).toBe(sameTextReplacement);
  });

  test("preserves an in-memory replacement when its storage write fails", () => {
    const revisionCandidate = (promptUi as unknown as Record<string, unknown>).createPromptDraftRevision;
    expect(typeof revisionCandidate).toBe("function");
    if (typeof revisionCandidate !== "function") return;
    const createPromptDraftRevision = revisionCandidate as () => string;
    const values = new Map<string, string>();
    let blockWrites = false;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blockWrites) throw new Error("quota full");
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    };
    const draft = "same text can still be a replacement";
    const submittedRevision = promptUi.writeStoredPromptDraft(storage, "session-one", draft);
    expect(submittedRevision).toBeDefined();
    if (submittedRevision === undefined) return;
    const submitted = promptUi.startPromptSubmission(
      { sessionId: "session-one", draft, draftRevision: submittedRevision, pendingPrompt: "", busy: false, error: "" },
      "session-one",
      12,
      draft,
    );

    const replacementRevision = createPromptDraftRevision();
    blockWrites = true;
    promptUi.writeStoredPromptDraft(storage, "session-one", draft, replacementRevision);
    const replacement = promptUi.updatePromptDraft(submitted, "session-one", draft, replacementRevision);
    blockWrites = false;
    const submittedVersionCleared = promptUi.clearSubmittedPromptDraft(storage, "session-one", submittedRevision);

    expect(promptUi.clearAcceptedPromptDraft(replacement, "session-one", submittedRevision, submittedVersionCleared)).toBe(replacement);
  });

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

  test("restores the exact rejected draft including surrounding whitespace", () => {
    const submitted = promptUi.startPromptSubmission(
      { sessionId: "session-one", draft: "  question with spacing  ", pendingPrompt: "", busy: false, error: "" },
      "session-one",
      10,
      "question with spacing",
    );
    expect(promptUi.failPromptSubmission(submitted, 10, "  question with spacing  ", "rejected").draft).toBe("  question with spacing  ");
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
