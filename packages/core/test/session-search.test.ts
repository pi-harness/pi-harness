import { describe, expect, test } from "vitest";
import { searchSessionEntries } from "../src/plugins/session-search.js";

describe("session search", () => {
  test("returns matching message previews with session context", () => {
    const result = searchSessionEntries(
      [
        { type: "message", message: { role: "user", content: "fix the auth flow" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will inspect auth.ts" }] } },
        { type: "message", message: { role: "user", content: "unrelated" } },
      ],
      "auth",
    );
    expect(result).toEqual([
      { role: "user", text: "fix the auth flow" },
      { role: "assistant", text: "I will inspect auth.ts" },
    ]);
  });

  test("rejects empty or overlong queries", () => {
    expect(() => searchSessionEntries([], "")).toThrow("Session search query must contain 1-120 characters");
    expect(() => searchSessionEntries([], "x".repeat(121))).toThrow("Session search query must contain 1-120 characters");
  });
});
