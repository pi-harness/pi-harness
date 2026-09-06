import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import betterSidebarPlugin, { createSidebarInspector, summarizeSidebar } from "../src/plugins/better-sidebar.js";
import type { WorkspaceGitStatus } from "../src/plugins/workspace-navigator.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "../src/services.js";

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
    expect(report.truncated).toBe(true);
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

  test("retries a failed workspace scan on the next refresh", async () => {
    let treeReads = 0;
    const inspect = createSidebarInspector({
      cwd: "/workspace/project",
      getSessionId: () => "session",
      listNodes() {
        treeReads += 1;
        return treeReads === 1
          ? Promise.reject(new Error("temporary scan failure"))
          : Promise.resolve({ nodes: [], directoryCount: 1, fileCount: 2, truncated: false });
      },
      readGitStatus: () => Promise.resolve({ available: false, branch: null, clean: false, entries: [] }),
    });

    await expect(inspect()).rejects.toThrow(/temporary scan failure/iu);
    await expect(inspect()).resolves.toMatchObject({ directoryCount: 1, fileCount: 2 });
    expect(treeReads).toBe(2);
  });

  test("reuses a successful workspace scan when only Git refresh fails", async () => {
    let treeReads = 0;
    let gitReads = 0;
    const inspect = createSidebarInspector({
      cwd: "/workspace/project",
      getSessionId: () => "session",
      listNodes() {
        treeReads += 1;
        return Promise.resolve({ nodes: [], directoryCount: 1, fileCount: 2, truncated: false });
      },
      readGitStatus() {
        gitReads += 1;
        return gitReads === 1
          ? Promise.reject(new Error("temporary Git failure"))
          : Promise.resolve({ available: true, branch: "main", clean: true, entries: [] });
      },
    });

    await expect(inspect()).rejects.toThrow(/temporary Git failure/iu);
    await expect(inspect()).resolves.toMatchObject({ branch: "main", directoryCount: 1, fileCount: 2 });
    expect(treeReads).toBe(1);
    expect(gitReads).toBe(2);
  });

  test("registers the overview tool and panel for the current session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-better-sidebar-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      await writeFile(join(root, "README.md"), "# workspace\n", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piSession", { manager: { getSessionId: () => "session-sidebar" } } as never);
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(betterSidebarPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "sidebar_overview");
      if (tool === undefined) throw new Error("sidebar_overview was not registered");
      expect(tool.executionMode).toBe("sequential");
      expect(tool.parameters).toMatchObject({ additionalProperties: false });

      const result = await tool.execute("inspect", {}, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ cwd: root, gitAvailable: false, fileCount: 1, sessionId: "session-sidebar" });
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("非 Git 工作区");
      await expect(panels.snapshot()).resolves.toMatchObject([
        { id: "better-sidebar-panel", data: { gitAvailable: false, fileCount: 1, sessionId: "session-sidebar" } },
      ]);

      await context.fiber.dispose();
      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toEqual([]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not alias concurrent tool and panel results", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-better-sidebar-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      await writeFile(join(root, "README.md"), "# workspace\n", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piSession", { manager: { getSessionId: () => "session-sidebar" } } as never);
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(betterSidebarPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "sidebar_overview");
      if (tool === undefined) throw new Error("sidebar_overview was not registered");

      const [result, snapshot] = await Promise.all([tool.execute("inspect", {}, undefined, undefined, {} as never), panels.snapshot()]);
      (result.details as { cwd: string }).cwd = "mutated";

      expect((snapshot[0]?.data as { cwd: string }).cwd).toBe(root);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
