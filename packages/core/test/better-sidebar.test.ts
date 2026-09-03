import { describe, expect, test } from "vitest";
import { summarizeSidebar } from "../src/plugins/better-sidebar.js";

describe("better sidebar", () => {
  test("summarizes workspace, Git, and session context without exposing full paths", () => {
    const report = summarizeSidebar({
      cwd: "/workspace/project",
      gitAvailable: true,
      branch: "feature/sidebar",
      clean: false,
      changedFiles: [
        { path: "src/app.tsx", status: " M" },
        { path: "README.md", status: "??" },
      ],
      directoryCount: 4,
      fileCount: 18,
      truncated: true,
      sessionId: "session-1234567890",
    });
    expect(report).toEqual({
      cwd: "/workspace/project",
      gitAvailable: true,
      branch: "feature/sidebar",
      clean: false,
      changedFiles: [
        { path: "src/app.tsx", status: " M" },
        { path: "README.md", status: "??" },
      ],
      directoryCount: 4,
      fileCount: 18,
      truncated: true,
      sessionId: "session-1234567890",
      changedCount: 2,
      summary: "feature/sidebar · 2 个变更",
    });
  });

  test("reports a clean non-Git workspace clearly", () => {
    expect(
      summarizeSidebar({
        cwd: "/tmp/project",
        gitAvailable: false,
        branch: null,
        clean: false,
        changedFiles: [],
        directoryCount: 0,
        fileCount: 0,
        truncated: false,
        sessionId: "session",
      }),
    ).toMatchObject({
      summary: "非 Git 工作区 · 无变更",
      changedCount: 0,
    });
  });

  test("distinguishes detached HEAD and counts changes before truncating details", () => {
    const report = summarizeSidebar({
      cwd: "/workspace/project",
      gitAvailable: true,
      branch: null,
      clean: false,
      changedFiles: Array.from({ length: 20 }, (_, index) => ({ path: `file-${index}.ts`, status: " M" })),
      directoryCount: 1,
      fileCount: 20,
      truncated: false,
      sessionId: "session",
    });
    expect(report.summary).toBe("detached HEAD · 20 个变更");
    expect(report.changedCount).toBe(20);
    expect(report.changedFiles).toHaveLength(12);
  });
});
