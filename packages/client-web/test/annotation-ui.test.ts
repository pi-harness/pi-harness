import { describe, expect, test } from "vitest";
import * as annotationUi from "../src/annotation-ui.js";
import { formatAnnotationPrompt, parseAnnotationPrompt } from "../src/annotation-ui.js";

describe("annotation UI protocol", () => {
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
    const clearSubmittedAnnotations = candidate as <T extends { sessionId?: string; annotations: unknown[] }>(state: T, sessionId?: string) => T;
    const replacement = {
      sessionId: "session-two",
      annotations: [{ id: 1, quote: "new session text", note: "" }],
      selection: "new selection",
      note: "new note",
    };

    expect(clearSubmittedAnnotations(replacement, "session-one")).toBe(replacement);
    expect(clearSubmittedAnnotations(replacement, "session-two")).toEqual({ ...replacement, annotations: [] });
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
