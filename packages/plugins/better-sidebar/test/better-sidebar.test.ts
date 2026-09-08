import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import betterSidebarPlugin, { createSidebarInspector, summarizeSidebar } from "../src/index.js";
import type { WorkspaceGitStatus } from "@pi-harness/plugin-workspace-navigator";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

describe("better sidebar", () => {
  test("summarizes workspace, Git, and session context without exposing full paths", () => {
    const report = summarizeSidebar({
      cwd: "/workspace/project",
      gitAvailable: true,
      branch: "feature/sidebar",
      clean: false,
      changedCount: 2,
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
        changedCount: 0,
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
      changedCount: 20,
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

  test("uses the upstream changed count when Git entries are truncated", async () => {
    const inspect = createSidebarInspector({
      cwd: "/workspace/project",
      getSessionId: () => "session",
      listNodes: () => Promise.resolve({ nodes: [], scannedEntries: 0, directoryCount: 0, fileCount: 0, truncated: false }),
      readGitStatus: () =>
        Promise.resolve({ available: true, branch: "main", clean: false, entries: [{ path: "first.txt", status: "??" }], changedCount: 600, truncated: true }),
    });
    await expect(inspect()).resolves.toMatchObject({ changedCount: 600, truncated: true, summary: "main · 600 个变更" });
  });

  test("refreshes live Git state while reusing the bounded workspace tree within the cache window", async () => {
    let treeReads = 0;
    let gitReads = 0;
    const inspect = createSidebarInspector({
      cwd: "/workspace/project",
      getSessionId: () => "session",
      listNodes() {
        treeReads += 1;
        return Promise.resolve({ nodes: [], scannedEntries: 0, directoryCount: 4, fileCount: 18, truncated: false });
      },
      readGitStatus() {
        gitReads += 1;
        return Promise.resolve(
          gitReads === 1
            ? { available: true, branch: "feature/old", clean: false, entries: [{ path: "src/app.ts", status: " M" }], changedCount: 1, truncated: false }
            : { available: true, branch: "main", clean: true, entries: [], changedCount: 0, truncated: false },
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
        return Promise.resolve({ nodes: [], scannedEntries: 0, directoryCount: 0, fileCount: 0, truncated: false });
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
    resolveGit({ available: true, branch: "main", clean: true, entries: [], changedCount: 0, truncated: false });
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
          : Promise.resolve({ nodes: [], scannedEntries: 0, directoryCount: 1, fileCount: 2, truncated: false });
      },
      readGitStatus: () => Promise.resolve({ available: false, branch: null, clean: false, entries: [], changedCount: 0, truncated: false }),
    });

    await expect(inspect()).rejects.toThrow(/temporary scan failure/iu);
    await expect(inspect()).resolves.toMatchObject({ directoryCount: 1, fileCount: 2 });
    expect(treeReads).toBe(2);
  });

  test("reuses a fresh workspace scan when only Git refresh fails", async () => {
    let treeReads = 0;
    let gitReads = 0;
    const inspect = createSidebarInspector({
      cwd: "/workspace/project",
      getSessionId: () => "session",
      listNodes() {
        treeReads += 1;
        return Promise.resolve({ nodes: [], scannedEntries: 0, directoryCount: 1, fileCount: 2, truncated: false });
      },
      readGitStatus() {
        gitReads += 1;
        return gitReads === 1
          ? Promise.reject(new Error("temporary Git failure"))
          : Promise.resolve({ available: true, branch: "main", clean: true, entries: [], changedCount: 0, truncated: false });
      },
    });

    await expect(inspect()).rejects.toThrow(/temporary Git failure/iu);
    await expect(inspect()).resolves.toMatchObject({ branch: "main", directoryCount: 1, fileCount: 2 });
    expect(treeReads).toBe(1);
    expect(gitReads).toBe(2);
  });

  test("rescans the workspace tree once the cache window has elapsed", async () => {
    let treeReads = 0;
    let clock = 1_000;
    const inspect = createSidebarInspector({
      cwd: "/workspace/project",
      getSessionId: () => "session",
      now: () => clock,
      listNodes() {
        treeReads += 1;
        return Promise.resolve(
          treeReads === 1
            ? { nodes: [], scannedEntries: 0, directoryCount: 1, fileCount: 3, truncated: false }
            : { nodes: [], scannedEntries: 0, directoryCount: 7, fileCount: 43, truncated: true },
        );
      },
      readGitStatus: () => Promise.resolve({ available: false, branch: null, clean: false, entries: [], changedCount: 0, truncated: false }),
    });

    await expect(inspect()).resolves.toMatchObject({ directoryCount: 1, fileCount: 3, truncated: false });
    clock += 4_999;
    await expect(inspect()).resolves.toMatchObject({ directoryCount: 1, fileCount: 3, truncated: false });
    expect(treeReads).toBe(1);
    clock += 1;
    await expect(inspect()).resolves.toMatchObject({ directoryCount: 7, fileCount: 43, truncated: true });
    expect(treeReads).toBe(2);
  });

  test("reports files added to the workspace after the cache window", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-better-sidebar-"));
    let clock = 0;
    try {
      await writeFile(join(root, "README.md"), "# workspace\n", "utf8");
      const inspect = createSidebarInspector({
        cwd: root,
        getSessionId: () => "session",
        now: () => clock,
        readGitStatus: () => Promise.resolve({ available: false, branch: null, clean: false, entries: [], changedCount: 0, truncated: false }),
      });
      await expect(inspect()).resolves.toMatchObject({ directoryCount: 0, fileCount: 1 });

      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "index.ts"), "export {};\n", "utf8");
      clock += 5_000;
      await expect(inspect()).resolves.toMatchObject({ directoryCount: 1, fileCount: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("registers the overview tool and panel for the current session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-better-sidebar-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      await writeFile(join(root, "README.md"), "# workspace\n", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piSession", { manager: { getHeader: () => null, getCwd: () => root, getSessionId: () => "session-sidebar" } } as never);
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
      context.provide("piSession", { manager: { getHeader: () => null, getCwd: () => root, getSessionId: () => "session-sidebar" } } as never);
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

test("follows native cwd and rejects obsolete, cancelled and disposed overview requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "sidebar-native-"));
  const activeCwd = join(root, "active");
  const context = new Context(),
    tools = new PiToolRegistry(),
    panels = new PiPluginUiRegistry();
  const launch = SessionManager.inMemory(root),
    active = SessionManager.inMemory(activeCwd);
  const runtime = { session: { sessionManager: launch } };
  try {
    await mkdir(activeCwd);
    await writeFile(join(activeCwd, "current.txt"), "current");
    await writeFile(join(root, "launch.txt"), "launch");
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piSession", { manager: launch });
    context.provide("piRuntime", runtime as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(betterSidebarPlugin);
    const tool = tools.snapshot().customTools[0]!;
    const call = (signal?: AbortSignal) => tool.execute("native", {}, signal, undefined, {} as never);
    expect((await call()).details).toMatchObject({ cwd: root, fileCount: 2 });
    runtime.session.sessionManager = active;
    expect((await call()).details).toMatchObject({ cwd: activeCwd, fileCount: 1, sessionId: active.getSessionId() });
    const pending = call();
    active.newSession();
    await expect(pending).rejects.toThrow(/session changed/);
    expect((await panels.snapshot())[0]!.data).toMatchObject({ cwd: activeCwd, sessionId: active.getSessionId() });
    const caller = new AbortController();
    const cancelled = call(caller.signal);
    caller.abort(new Error("caller cancelled"));
    await expect(cancelled).rejects.toThrow(/cancelled/);
    await context.fiber.dispose();
    await expect(call()).rejects.toThrow(/disposed/);
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
