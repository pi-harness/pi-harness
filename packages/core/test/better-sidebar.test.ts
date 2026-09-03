import { describe, expect, test } from "vitest";
import { createSidebarInspector, summarizeSidebar } from "../src/plugins/better-sidebar.js";
import type { WorkspaceGitStatus } from "../src/plugins/workspace-navigator.js";

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

  test("refreshes live Git state while reusing the bounded workspace tree", async () => {
    let treeReads = 0;
    let gitReads = 0;
    const inspect = createSidebarInspector({
      cwd: "/workspace/project",
      getSessionId: () => "session",
      listNodes() {
        treeReads += 1;
        return Promise.resolve({ nodes: [], directoryCount: 4, fileCount: 18, truncated: false });
      },
      readGitStatus() {
        gitReads += 1;
        return Promise.resolve(
          gitReads === 1
            ? { available: true, branch: "feature/old", clean: false, entries: [{ path: "src/app.ts", status: " M" }] }
            : { available: true, branch: "main", clean: true, entries: [] },
        );
      },
    });

    await expect(inspect()).resolves.toMatchObject({ branch: "feature/old", changedCount: 1 });
    await expect(inspect()).resolves.toMatchObject({ branch: "main", changedCount: 0, clean: true });
    expect(treeReads).toBe(1);
    expect(gitReads).toBe(2);
  });

  test("coalesces overlapping sidebar refreshes", async () => {
    let resolveGit!: (status: WorkspaceGitStatus) => void;
    let gitReads = 0;
    const inspect = createSidebarInspector({
      cwd: "/workspace/project",
      getSessionId: () => "session",
      listNodes() {
        return Promise.resolve({ nodes: [], directoryCount: 0, fileCount: 0, truncated: false });
      },
      readGitStatus: () => {
        gitReads += 1;
        return new Promise((resolve) => {
          resolveGit = resolve;
        });
      },
    });

    const first = inspect();
    const second = inspect();
    expect(second).toBe(first);
    resolveGit({ available: true, branch: "main", clean: true, entries: [] });
    await expect(first).resolves.toMatchObject({ branch: "main" });
    expect(gitReads).toBe(1);
  });
});
