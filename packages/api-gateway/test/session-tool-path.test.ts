import { describe, expect, test } from "vitest";
import { normalizeSessionToolPath } from "../src/session-tool-path.js";

describe("session tool path normalization", () => {
  test("matches Pi path prefixes, Unicode spaces, tilde expansion, and file URLs", () => {
    expect(normalizeSessionToolPath("@notes.md", "darwin", "/Users/tester")).toBe("notes.md");
    expect(normalizeSessionToolPath("unicode\u00a0space.md", "darwin", "/Users/tester")).toBe("unicode space.md");
    expect(normalizeSessionToolPath("~/notes.md", "darwin", "/Users/tester")).toBe("/Users/tester/notes.md");
    expect(normalizeSessionToolPath("file:///tmp/notes%20file.md", "darwin", "/Users/tester")).toBe("/tmp/notes file.md");
    expect(normalizeSessionToolPath("~\\notes.md", "win32", "C:\\Users\\tester")).toBe("C:\\Users\\tester\\notes.md");
    expect(normalizeSessionToolPath("file:///C:/work/file.txt", "win32", "C:\\Users\\tester")).toBe("C:\\work\\file.txt");
  });

  test.each([
    ["/c/work/file.txt", "C:\\work\\file.txt"],
    ["/mnt/d/work/file.txt", "D:\\work\\file.txt"],
    ["/cygdrive/e/work/file.txt", "E:\\work\\file.txt"],
    ["//server/share/file.txt", "//server/share/file.txt"],
    ["C:\\work\\file.txt", "C:\\work\\file.txt"],
  ])("matches Pi Windows shell path normalization for %s", (input, expected) => {
    expect(normalizeSessionToolPath(input, "win32", "C:\\Users\\tester")).toBe(expected);
  });
});
