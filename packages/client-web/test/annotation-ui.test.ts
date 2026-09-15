import { describe, expect, test } from "vitest";
import * as annotationUi from "../src/annotation-ui.js";
import { formatAnnotationPrompt, parseAnnotationPrompt } from "../src/annotation-ui.js";

describe("annotation UI protocol", () => {
  test("keeps a stored draft while a URL-selected session is still restoring", () => {
    const candidate = (annotationUi as unknown as Record<string, unknown>).annotationDraftDuringSessionRestore;
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;
    const annotationDraftDuringSessionRestore = candidate as (
      state: { sessionId?: string; annotations: unknown[]; selection: string; note: string },
      restored: { sessionId?: string; annotations: unknown[]; selection: string; note: string },
      sessionId: string,
      restorePending: boolean,
    ) => { sessionId?: string; annotations: unknown[]; selection: string; note: string };
    const stored = {
      sessionId: "url-session",
      annotations: [{ id: 1, quote: "keep me", note: "" }],
      selection: "",
      note: "",
    };

    const temporary = { sessionId: "temporary-runtime-session", annotations: [], selection: "", note: "" };
    expect(annotationDraftDuringSessionRestore(stored, temporary, "temporary-runtime-session", true)).toBe(stored);
    expect(annotationDraftDuringSessionRestore(stored, temporary, "temporary-runtime-session", false)).toEqual({
      sessionId: "temporary-runtime-session",
      annotations: [],
      selection: "",
      note: "",
    });
  });

  test("restores a pending annotation draft after a page reload", () => {
    const readCandidate = (annotationUi as unknown as Record<string, unknown>).readStoredAnnotationDraft;
    const writeCandidate = (annotationUi as unknown as Record<string, unknown>).writeStoredAnnotationDraft;
    expect(typeof readCandidate).toBe("function");
    expect(typeof writeCandidate).toBe("function");
    if (typeof readCandidate !== "function" || typeof writeCandidate !== "function") return;
    const readStoredAnnotationDraft = readCandidate as (
      storage: { getItem: (key: string) => string | null },
      sessionId: string,
    ) => {
      sessionId?: string;
      annotations: unknown[];
      selection: string;
      note: string;
    };
    const writeStoredAnnotationDraft = writeCandidate as (
      storage: { removeItem: (key: string) => boolean; setItem: (key: string, value: string) => Map<string, string> },
      draft: { sessionId: string; annotations: unknown[]; selection: string; note: string },
    ) => void;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const draft = {
      sessionId: "session-one",
      annotations: [{ id: 1, quote: "runtime mount fix", note: "verify after reload" }],
      selection: "next selected passage",
      note: "next note",
    };

    writeStoredAnnotationDraft(storage, draft);

    expect(readStoredAnnotationDraft(storage, draft.sessionId)).toEqual(draft);
  });

  test("keeps stored drafts isolated when another session becomes active", () => {
    const readCandidate = (annotationUi as unknown as Record<string, unknown>).readStoredAnnotationDraft;
    const writeCandidate = (annotationUi as unknown as Record<string, unknown>).writeStoredAnnotationDraft;
    expect(typeof readCandidate).toBe("function");
    expect(typeof writeCandidate).toBe("function");
    if (typeof readCandidate !== "function" || typeof writeCandidate !== "function") return;
    const readStoredAnnotationDraft = readCandidate as (
      storage: { getItem: (key: string) => string | null },
      sessionId: string,
    ) => { sessionId?: string; annotations: unknown[]; selection: string; note: string };
    const writeStoredAnnotationDraft = writeCandidate as (
      storage: { removeItem: (key: string) => boolean; setItem: (key: string, value: string) => Map<string, string> },
      draft: { sessionId: string; annotations: unknown[]; selection: string; note: string },
    ) => void;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const first = {
      sessionId: "session-one",
      annotations: [{ id: 1, quote: "private first-session text", note: "" }],
      selection: "",
      note: "",
    };

    writeStoredAnnotationDraft(storage, first);
    writeStoredAnnotationDraft(storage, { sessionId: "session-two", annotations: [], selection: "", note: "" });

    expect(readStoredAnnotationDraft(storage, "session-one")).toEqual(first);
    expect(readStoredAnnotationDraft(storage, "session-two")).toEqual({ sessionId: "session-two", annotations: [], selection: "", note: "" });
  });

  test("clears the submitted session from storage after navigation moved elsewhere", () => {
    const clearCandidate = (annotationUi as unknown as Record<string, unknown>).clearStoredAnnotationDraft;
    const readCandidate = (annotationUi as unknown as Record<string, unknown>).readStoredAnnotationDraft;
    const writeCandidate = (annotationUi as unknown as Record<string, unknown>).writeStoredAnnotationDraft;
    expect(typeof clearCandidate).toBe("function");
    expect(typeof readCandidate).toBe("function");
    expect(typeof writeCandidate).toBe("function");
    if (typeof clearCandidate !== "function" || typeof readCandidate !== "function" || typeof writeCandidate !== "function") return;
    const clearStoredAnnotationDraft = clearCandidate as (storage: { removeItem: (key: string) => boolean }, sessionId: string) => void;
    const readStoredAnnotationDraft = readCandidate as (
      storage: { getItem: (key: string) => string | null },
      sessionId: string,
    ) => { sessionId?: string; annotations: unknown[]; selection: string; note: string };
    const writeStoredAnnotationDraft = writeCandidate as (
      storage: { removeItem: (key: string) => boolean; setItem: (key: string, value: string) => Map<string, string> },
      draft: { sessionId: string; annotations: unknown[]; selection: string; note: string },
    ) => void;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    writeStoredAnnotationDraft(storage, {
      sessionId: "submitted-session",
      annotations: [{ id: 1, quote: "already sent", note: "" }],
      selection: "",
      note: "",
    });

    clearStoredAnnotationDraft(storage, "submitted-session");

    expect(readStoredAnnotationDraft(storage, "submitted-session")).toEqual({
      sessionId: "submitted-session",
      annotations: [],
      selection: "",
      note: "",
    });
  });

  test("discards corrupt or structurally invalid stored drafts", () => {
    const candidate = (annotationUi as unknown as Record<string, unknown>).readStoredAnnotationDraft;
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;
    const readStoredAnnotationDraft = candidate as (
      storage: { getItem: () => string | null },
      sessionId: string,
    ) => {
      sessionId?: string;
      annotations: unknown[];
      selection: string;
      note: string;
    };
    const empty = { sessionId: "session-one", annotations: [], selection: "", note: "" };

    expect(readStoredAnnotationDraft({ getItem: () => "{" }, "session-one")).toEqual(empty);
    expect(
      readStoredAnnotationDraft({ getItem: () => JSON.stringify({ sessionId: "session-one", annotations: "bad", selection: "", note: "" }) }, "session-one"),
    ).toEqual(empty);
    expect(
      readStoredAnnotationDraft(
        { getItem: () => JSON.stringify({ sessionId: "session-one", annotations: [{ id: 1, quote: 42, note: "" }], selection: "", note: "" }) },
        "session-one",
      ),
    ).toEqual(empty);
  });

  test("keeps the composer usable when browser storage access fails", () => {
    const readCandidate = (annotationUi as unknown as Record<string, unknown>).readStoredAnnotationDraft;
    const writeCandidate = (annotationUi as unknown as Record<string, unknown>).writeStoredAnnotationDraft;
    expect(typeof readCandidate).toBe("function");
    expect(typeof writeCandidate).toBe("function");
    if (typeof readCandidate !== "function" || typeof writeCandidate !== "function") return;
    const readStoredAnnotationDraft = readCandidate as (storage: { getItem: () => string | null }, sessionId: string) => unknown;
    const writeStoredAnnotationDraft = writeCandidate as (
      storage: { removeItem: () => void; setItem: () => void },
      draft: { sessionId: string; annotations: unknown[]; selection: string; note: string },
    ) => void;
    const blocked = () => {
      throw new Error("storage blocked");
    };

    expect(readStoredAnnotationDraft({ getItem: blocked }, "session-one")).toEqual({ sessionId: "session-one", annotations: [], selection: "", note: "" });
    expect(() =>
      writeStoredAnnotationDraft(
        { removeItem: blocked, setItem: blocked },
        { sessionId: "session-one", annotations: [{ id: 1, quote: "keep", note: "" }], selection: "", note: "" },
      ),
    ).not.toThrow();
    expect(() =>
      writeStoredAnnotationDraft({ removeItem: blocked, setItem: blocked }, { sessionId: "session-one", annotations: [], selection: "", note: "" }),
    ).not.toThrow();
  });

  test("drops browser annotation drafts when the active session changes", () => {
    const candidate = (annotationUi as unknown as Record<string, unknown>).annotationDraftForSession;
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;
    const annotationDraftForSession = candidate as (
      state: { sessionId?: string; annotations: unknown[]; selection: string; note: string },
      sessionId?: string,
    ) => { sessionId?: string; annotations: unknown[]; selection: string; note: string };
    const previous = {
      sessionId: "session-one",
      annotations: [{ id: 1, quote: "private session one text", note: "private note" }],
      selection: "private selection",
      note: "private draft note",
    };

    expect(annotationDraftForSession(previous, "session-one")).toBe(previous);
    const second = annotationDraftForSession(previous, "session-two");
    expect(second).toEqual({
      sessionId: "session-two",
      annotations: [],
      selection: "",
      note: "",
    });
    expect(annotationDraftForSession(second, "session-one")).toEqual({ sessionId: "session-one", annotations: [], selection: "", note: "" });
    expect(annotationDraftForSession(previous, undefined)).toEqual({ sessionId: undefined, annotations: [], selection: "", note: "" });
  });

  test("drops a selection captured by an animation frame from an old session", () => {
    const candidate = (annotationUi as unknown as Record<string, unknown>).captureSelectionForSession;
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;
    const captureSelectionForSession = candidate as (
      state: { sessionId?: string; annotations: unknown[]; selection: string; note: string },
      scheduledSessionId: string | undefined,
      activeSessionId: string | undefined,
      selection: string,
    ) => { sessionId?: string; annotations: unknown[]; selection: string; note: string };
    const active = { sessionId: "session-two", annotations: [], selection: "", note: "" };

    expect(captureSelectionForSession(active, "session-one", "session-two", "private old selection")).toBe(active);
    expect(captureSelectionForSession(active, "session-two", "session-two", "current selection")).toEqual({ ...active, selection: "current selection" });
  });

  test("does not let an old prompt completion clear a replacement session draft", () => {
    const candidate = (annotationUi as unknown as Record<string, unknown>).clearSubmittedAnnotations;
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;
    const clearSubmittedAnnotations = candidate as <T extends { sessionId?: string; annotations: unknown[] }>(
      state: T,
      sessionId: string,
      submitted: unknown[],
    ) => T;
    const replacement = {
      sessionId: "session-two",
      annotations: [{ id: 1, quote: "new session text", note: "" }],
      selection: "new selection",
      note: "new note",
    };

    expect(clearSubmittedAnnotations(replacement, "session-one", replacement.annotations)).toBe(replacement);
    expect(clearSubmittedAnnotations(replacement, "session-two", replacement.annotations)).toEqual({ ...replacement, annotations: [] });
  });

  test("formats numbered annotations and restores the visible question", () => {
    const prompt = formatAnnotationPrompt(
      [
        { id: 1, quote: "streaming output", note: "keep incremental updates" },
        { id: 2, quote: "Markdown block", note: "" },
      ],
      "How should this be fixed?",
    );
    expect(prompt).toContain("[Pi Harness annotations]");
    expect(prompt).toContain("Annotation 1：、Annotation 2：");
    expect(parseAnnotationPrompt(prompt)).toEqual({ question: "How should this be fixed?", count: 2 });
  });

  test("leaves ordinary user prompts untouched", () => {
    expect(parseAnnotationPrompt("hello\n\n提问：still ordinary")).toEqual({ question: "hello\n\n提问：still ordinary", count: 0 });
  });
});

describe("annotation submission snapshots", () => {
  const sent = { id: 1, quote: "sent quote", note: "sent note", revision: "sent-version" };
  const newer = { id: 2, quote: "next quote", note: "next note", revision: "next-version" };
  test("removes only submitted annotations and preserves an unfinished selection", () => {
    const state = { sessionId: "one", annotations: [sent, newer], selection: "unfinished selection", note: "unfinished note" };
    expect(annotationUi.clearSubmittedAnnotations(state, "one", [sent])).toEqual({ ...state, annotations: [newer] });
    expect(annotationUi.clearSubmittedAnnotations(state, "two", [sent])).toBe(state);
  });
  test("does not remove a recreated annotation that reused the visible number and text", () => {
    const replacement = { ...sent, revision: "replacement-version" };
    const state = { sessionId: "one", annotations: [replacement], selection: "", note: "" };
    expect(annotationUi.clearSubmittedAnnotations(state, "one", [sent])).toBe(state);
  });
  test("preserves newer stored annotations after the submitted session is no longer active", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const state = { sessionId: "one", annotations: [sent, newer], selection: "unfinished selection", note: "unfinished note" };
    annotationUi.writeStoredAnnotationDraft(storage, state);
    annotationUi.clearStoredSubmittedAnnotations(storage, "one", [sent]);
    expect(annotationUi.readStoredAnnotationDraft(storage, "one")).toEqual({ ...state, annotations: [newer] });
  });
});

test("keeps multiple pending annotation snapshots independent of new text drafts", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const first = { id: 1, quote: "first", note: "", revision: "first-version" };
  const second = { id: 2, quote: "second", note: "", revision: "second-version" };
  annotationUi.rememberAnnotationSubmission(storage, "one", "request-one", [first]);
  storage.setItem("pi-harness.prompt-draft.one", JSON.stringify({ sessionId: "one", draft: "new text draft", revision: "new-draft" }));
  annotationUi.rememberAnnotationSubmission(storage, "one", "request-two", [first, second]);
  expect(annotationUi.readStoredAnnotationSubmissions(storage, "one")).toEqual([
    { requestId: "request-one", annotations: [first] },
    { requestId: "request-two", annotations: [first, second] },
  ]);
  expect(annotationUi.readStoredAnnotationSubmissions(storage, "two")).toEqual([]);
  annotationUi.forgetAnnotationSubmission(storage, "one", "request-one");
  expect(annotationUi.readStoredAnnotationSubmissions(storage, "one")).toEqual([{ requestId: "request-two", annotations: [first, second] }]);
  annotationUi.forgetAnnotationSubmission(storage, "one", "request-two");
  expect(annotationUi.readStoredAnnotationSubmissions(storage, "one")).toEqual([]);
  expect(JSON.parse(values.get("pi-harness.prompt-draft.one")!)).toMatchObject({ draft: "new text draft" });
});
