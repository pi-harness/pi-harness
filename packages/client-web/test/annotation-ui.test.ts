import { describe, expect, test } from "vitest";
import { formatAnnotationPrompt, parseAnnotationPrompt } from "../src/annotation-ui.js";

describe("annotation UI protocol", () => {
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
