import { describe, expect, test } from "vitest";
import { summarizeSidebar } from "../src/plugins/better-sidebar.js";

describe("better sidebar", () => {
  test("summarizes workspace, Git, and session context without exposing full paths", () => {
    const report = summarizeSidebar({
      cwd: "/workspace/project",
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
});
