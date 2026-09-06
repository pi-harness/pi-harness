import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";
import { applyCapsule } from "../src/plugins/git-time-capsule.js";
import gitTimeCapsulePlugin from "../src/plugins/git-time-capsule.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function waitForFile(path: string, description: string, timeoutMs = 5_000): Promise<string> {
  const startedAt = Date.now();
  while (true) {
    const value = await readFile(path, "utf8").catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("git time capsule restore", () => {
  test("checks and applies a capsule to a real git workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-workspace-"));
    const capsules = await mkdtemp(join(tmpdir(), "pi-harness-capsules-"));
    temporaryDirectories.push(workspace, capsules);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "note.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    const { stdout: patch } = await execFileAsync("git", ["diff", "--binary"], { cwd: workspace });
    const capsule = join(capsules, "restore.patch");
    await writeFile(capsule, patch, "utf8");

    await applyCapsule(workspace, capsule);

    await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("before\n");
  });

  test("rejects a capsule that does not apply cleanly", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-conflict-"));
    const capsules = await mkdtemp(join(tmpdir(), "pi-harness-capsules-conflict-"));
    temporaryDirectories.push(workspace, capsules);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "current\n", "utf8");
    const capsule = join(capsules, "conflict.patch");
    await writeFile(capsule, "diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-old\n+restored\n", "utf8");

    await expect(applyCapsule(workspace, capsule)).rejects.toThrow("does not apply cleanly");
    await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("current\n");
  });

  test("uses the default timeout when direct restore configuration is not finite", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-direct-timeout-workspace-"));
    const capsules = await mkdtemp(join(tmpdir(), "pi-harness-capsule-direct-timeout-input-"));
    temporaryDirectories.push(workspace, capsules);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "note.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    const { stdout: patch } = await execFileAsync("git", ["diff", "--binary"], { cwd: workspace });
    const capsule = join(capsules, "restore.patch");
    await writeFile(capsule, patch, "utf8");

    await applyCapsule(workspace, capsule, Number.NaN);

    await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("before\n");
  });

  test("rejects a symbolic-link capsule before Git reads its target", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-symlink-workspace-"));
    const capsules = await mkdtemp(join(tmpdir(), "pi-harness-capsule-symlink-input-"));
    temporaryDirectories.push(workspace, capsules);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "note.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    const { stdout: patch } = await execFileAsync("git", ["diff", "--binary"], { cwd: workspace });
    const target = join(capsules, "target.patch");
    const link = join(capsules, "restore.patch");
    await writeFile(target, patch, "utf8");
    await symlink(target, link);

    await expect(applyCapsule(workspace, link)).rejects.toThrow(/symbolic link/iu);
    await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("after\n");
  });

  test("rejects an oversized capsule before invoking Git", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-oversized-workspace-"));
    const capsules = await mkdtemp(join(tmpdir(), "pi-harness-capsule-oversized-input-"));
    temporaryDirectories.push(workspace, capsules);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    const capsule = join(capsules, "oversized.patch");
    await writeFile(capsule, Buffer.alloc(8 * 1024 * 1024 + 1, 0x78));

    await expect(applyCapsule(workspace, capsule)).rejects.toThrow(/exceeds.*8388608-byte limit/iu);
  });

  test("preserves caller cancellation while checking a restore", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-apply-cancel-workspace-"));
    const capsules = await mkdtemp(join(tmpdir(), "pi-harness-capsule-apply-cancel-input-"));
    temporaryDirectories.push(workspace, capsules);
    const capsule = join(capsules, "restore.patch");
    await writeFile(capsule, "non-empty patch fixture\n", "utf8");
    const bin = join(workspace, "bin");
    const started = join(workspace, "git-started");
    await mkdir(bin);
    await writeFile(join(bin, "git"), '#!/bin/sh\n: > "$CAPSULE_GIT_STARTED"\nexec sleep 5\n', "utf8");
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    const originalStarted = process.env.CAPSULE_GIT_STARTED;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    process.env.CAPSULE_GIT_STARTED = started;
    const controller = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      pending = applyCapsule(workspace, capsule, 1_000, controller.signal);
      await waitForFile(started, "Git restore check to start");

      controller.abort(new Error("restore caller cancelled"));

      await expect(pending).rejects.toThrow("restore caller cancelled");
    } finally {
      if (!controller.signal.aborted) controller.abort(new Error("restore cancellation test cleanup"));
      await pending?.catch(() => undefined);
      process.env.PATH = originalPath;
      if (originalStarted === undefined) delete process.env.CAPSULE_GIT_STARTED;
      else process.env.CAPSULE_GIT_STARTED = originalStarted;
    }
  });

  test("requires explicit confirmation through the restore tool", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-tool-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const capsuleDirectory = join(agentDir, "capsules");
    await mkdir(capsuleDirectory, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "note.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    const { stdout: patch } = await execFileAsync("git", ["diff", "--binary"], { cwd: workspace });
    await writeFile(join(capsuleDirectory, "restore.patch"), patch, "utf8");
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_restore");
      expect(tool).toBeDefined();
      await expect(tool!.execute("call-1", { name: "restore.patch", confirm: false }, undefined, undefined, {} as never)).rejects.toThrow("confirm=true");
      await expect(tool!.execute("call-2", { name: "restore.patch", confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { restored: true },
      });
      await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("before\n");
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { latest: { action: "restore", status: "completed", files: 1 } } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("reports a completed restore even if the source capsule disappears afterward", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-restore-race-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-restore-race-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const directory = join(agentDir, "capsules");
    await mkdir(directory);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "note.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    const { stdout: patch } = await execFileAsync("git", ["diff", "--binary", "--no-textconv"], { cwd: workspace });
    const capsule = join(directory, "restore-race.patch");
    await writeFile(capsule, patch, "utf8");
    const { stdout: realGit } = await execFileAsync("which", ["git"]);
    const bin = join(workspace, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\n"$CAPSULE_REAL_GIT" "$@"\nstatus=$?\ncase " $* " in\n  *" apply --reverse --binary "*) rm "$CAPSULE_SOURCE" ;;\nesac\nexit "$status"\n',
      "utf8",
    );
    await chmod(join(bin, "git"), 0o700);
    const original = { path: process.env.PATH, realGit: process.env.CAPSULE_REAL_GIT, source: process.env.CAPSULE_SOURCE };
    process.env.PATH = `${bin}${delimiter}${original.path ?? ""}`;
    process.env.CAPSULE_REAL_GIT = realGit.trim();
    process.env.CAPSULE_SOURCE = capsule;
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const restore = tools.snapshot().customTools.find((candidate) => candidate.name === "git_restore")!;

      await expect(
        restore.execute("call-restore-race", { name: "restore-race.patch", confirm: true }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({
        details: { restored: true },
      });
      await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("before\n");
    } finally {
      for (const [name, value] of [
        ["PATH", original.path],
        ["CAPSULE_REAL_GIT", original.realGit],
        ["CAPSULE_SOURCE", original.source],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await context.fiber.dispose();
    }
  });

  test("rejects accessor restore parameters without invoking them", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-restore-params-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-restore-params-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    let accessed = false;
    const rawParams = { name: "restore.patch" } as { name: string; confirm?: boolean };
    Object.defineProperty(rawParams, "confirm", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("accessor executed");
      },
    });
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_restore")!;

      await expect(tool.execute("call-restore-params", rawParams, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(panels.snapshot()).resolves.toMatchObject([
        { data: { latest: { action: "restore", status: "failed", error: "Git restore parameters must use data properties" } } },
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects NUL bytes in restore capsule names before filesystem access", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-restore-nul-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-restore-nul-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_restore")!;

      await expect(tool.execute("call-restore-nul", { name: "restore\0.patch", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
        /name.*must not contain NUL/iu,
      );
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects ambiguous or unsafe restore capsule names before filesystem access", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-restore-name-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-restore-name-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const restore = tools.snapshot().customTools.find((candidate) => candidate.name === "git_restore")!;

      for (const [index, name] of [
        " restore.patch",
        "restore.patch ",
        "folder\\restore.patch",
        "restore\n.patch",
        "restore\u202e.patch",
        `${"😀".repeat(64)}.patch`,
      ].entries())
        await expect(restore.execute(`call-unsafe-name-${index}`, { name, confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
          /safe \.patch filename/iu,
        );
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects restore through a symbolic-link capsule directory", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-restore-directory-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-restore-directory-agent-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-harness-capsule-restore-directory-outside-"));
    temporaryDirectories.push(workspace, agentDir, outside);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "note.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    const { stdout: patch } = await execFileAsync("git", ["diff", "--binary"], { cwd: workspace });
    await writeFile(join(outside, "restore.patch"), patch, "utf8");
    await symlink(outside, join(agentDir, "capsules"));
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_restore")!;

      await expect(tool.execute("call-directory-link", { name: "restore.patch", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
        /directory.*symbolic link/iu,
      );
      await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("after\n");
    } finally {
      await context.fiber.dispose();
    }
  });

  test("creates distinct capsules and excludes untracked files from the recoverable count", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-distinct-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-distinct-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    await writeFile(join(workspace, "untracked.txt"), "not in the patch\n", "utf8");
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot");
      const first = await tool!.execute("call-1", {}, undefined, undefined, {} as never);
      expect(first).toMatchObject({ details: { files: 1 } });
      expect(JSON.stringify(first)).not.toContain(agentDir);
      expect(JSON.stringify(first)).not.toContain(workspace);
      await expect(tool!.execute("call-2", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { files: 1 } });
      await expect(readdir(join(agentDir, "capsules"))).resolves.toHaveLength(2);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("returns detached panel state that cannot mutate the latest capsule", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-panel-clone-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-panel-clone-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;
      await tool.execute("call-panel-clone", {}, undefined, undefined, {} as never);
      const first = await panels.snapshot();
      const firstData = first[0]?.data as { latest: { name: string } };
      const originalName = firstData.latest.name;
      firstData.latest.name = "mutated.patch";

      const second = await panels.snapshot();

      expect((second[0]?.data as { latest: { name: string } }).latest.name).toBe(originalName);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("records a bounded failed capture for the panel", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-failure-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-failure-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;
      await expect(tool.execute("call-failure", {}, undefined, undefined, {} as never)).rejects.toThrow("Git time capsule requires a Git working tree");

      await expect(panels.snapshot()).resolves.toMatchObject([
        {
          id: "git-time-capsule-panel",
          data: { latest: { action: "capture", status: "failed", error: "Git time capsule requires a Git working tree" } },
        },
      ]);
      const snapshot = await panels.snapshot();
      expect((snapshot[0]?.data as { latest: { error: string } }).latest.error.length).toBeLessThanOrEqual(2_000);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("sanitizes tool and panel failures while preserving the original cause", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-safe-error-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-safe-error-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const bin = join(workspace, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$1" = "rev-parse" ]; then printf "true\\n"; exit 0; fi\nprintf "fatal: %s\\342\\200\\256\\001\\n" "$CAPSULE_ERROR_PATH" >&2\nexit 2\n',
      "utf8",
    );
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    const originalErrorPath = process.env.CAPSULE_ERROR_PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    process.env.CAPSULE_ERROR_PATH = workspace;
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;
      let failure: unknown;
      try {
        await tool.execute("call-safe-error", {}, undefined, undefined, {} as never);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message.length).toBeLessThanOrEqual(2_000);
      expect((failure as Error).message).not.toContain(workspace);
      expect((failure as Error).message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
      expect((failure as Error).cause).toBeInstanceOf(Error);
      const data = (await panels.snapshot())[0]?.data as { latest: { error: string } };
      expect(data.latest.error).toBe((failure as Error).message);
    } finally {
      process.env.PATH = originalPath;
      if (originalErrorPath === undefined) delete process.env.CAPSULE_ERROR_PATH;
      else process.env.CAPSULE_ERROR_PATH = originalErrorPath;
      await context.fiber.dispose();
    }
  });

  test("times out a hung Git process while creating a capsule", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-timeout-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-timeout-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const bin = join(workspace, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\nexec sleep 1\n", "utf8");
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin, { timeoutMs: 500 });
      const pending = tools
        .snapshot()
        .customTools.find((candidate) => candidate.name === "git_snapshot")!
        .execute("call-1", {}, undefined, undefined, {} as never);
      await expect(pending).rejects.toThrow(/timed out after 500 ms/iu);
    } finally {
      process.env.PATH = originalPath;
      await context.fiber.dispose();
    }
  });

  test("cancels an in-flight Git snapshot when the caller aborts", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-cancel-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-cancel-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const bin = join(workspace, "bin");
    const started = join(workspace, "git-started");
    await mkdir(bin);
    await writeFile(join(bin, "git"), '#!/bin/sh\necho "$$" > "$CAPSULE_GIT_STARTED"\nexec sleep 5\n', "utf8");
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    const originalStarted = process.env.CAPSULE_GIT_STARTED;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    process.env.CAPSULE_GIT_STARTED = started;
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin, { timeoutMs: 1_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;
      const controller = new AbortController();
      const pending = tool.execute("call-cancel", {}, controller.signal, undefined, {} as never);
      await waitForFile(started, "Git snapshot process to start");

      controller.abort(new Error("snapshot caller cancelled"));

      await expect(pending).rejects.toThrow("snapshot caller cancelled");
    } finally {
      process.env.PATH = originalPath;
      if (originalStarted === undefined) delete process.env.CAPSULE_GIT_STARTED;
      else process.env.CAPSULE_GIT_STARTED = originalStarted;
      await context.fiber.dispose();
    }
  });

  test("records a caller cancellation that arrives before execution starts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-pre-cancel-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-pre-cancel-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled before start"));
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(tool.execute("call-pre-cancel", {}, controller.signal, undefined, {} as never)).rejects.toThrow("caller cancelled before start");
      await expect(panels.snapshot()).resolves.toMatchObject([
        { data: { latest: { action: "capture", status: "cancelled", error: "caller cancelled before start" } } },
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("cancels an in-flight Git snapshot when the plugin is disposed", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-dispose-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-dispose-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const bin = join(workspace, "bin");
    const started = join(workspace, "git-started");
    await mkdir(bin);
    await writeFile(join(bin, "git"), '#!/bin/sh\necho "$$" > "$CAPSULE_GIT_STARTED"\nexec sleep 5\n', "utf8");
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    const originalStarted = process.env.CAPSULE_GIT_STARTED;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    process.env.CAPSULE_GIT_STARTED = started;
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    let disposed = false;
    try {
      await context.plugin(gitTimeCapsulePlugin, { timeoutMs: 1_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;
      const pending = tool.execute("call-dispose", {}, undefined, undefined, {} as never);
      await waitForFile(started, "Git snapshot process to start");

      await context.fiber.dispose();
      disposed = true;

      await expect(pending).rejects.toThrow("Git time capsule plugin disposed");
    } finally {
      process.env.PATH = originalPath;
      if (originalStarted === undefined) delete process.env.CAPSULE_GIT_STARTED;
      else process.env.CAPSULE_GIT_STARTED = originalStarted;
      if (!disposed) await context.fiber.dispose();
    }
  });

  test("serializes concurrent capsule operations", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-serial-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-serial-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    const { stdout } = await execFileAsync("which", ["git"]);
    const bin = join(workspace, "bin");
    const started = join(workspace, "git-started");
    const once = join(workspace, "git-once");
    const lock = join(workspace, "git-lock");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nif mkdir "$CAPSULE_GIT_ONCE" 2>/dev/null; then\n  mkdir "$CAPSULE_GIT_LOCK"\n  : > "$CAPSULE_GIT_STARTED"\n  sleep 1\n  rmdir "$CAPSULE_GIT_LOCK"\nelif [ -d "$CAPSULE_GIT_LOCK" ]; then\n  echo "concurrent Git invocation" >&2\n  exit 92\nfi\nexec "$REAL_GIT" "$@"\n',
      "utf8",
    );
    await chmod(join(bin, "git"), 0o700);
    const environment = {
      PATH: process.env.PATH,
      REAL_GIT: process.env.REAL_GIT,
      CAPSULE_GIT_STARTED: process.env.CAPSULE_GIT_STARTED,
      CAPSULE_GIT_ONCE: process.env.CAPSULE_GIT_ONCE,
      CAPSULE_GIT_LOCK: process.env.CAPSULE_GIT_LOCK,
    };
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    process.env.REAL_GIT = stdout.trim();
    process.env.CAPSULE_GIT_STARTED = started;
    process.env.CAPSULE_GIT_ONCE = once;
    process.env.CAPSULE_GIT_LOCK = lock;
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin, { timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;
      const first = tool.execute("call-serial-1", {}, undefined, undefined, {} as never);
      await waitForFile(started, "first serialized Git operation to start");
      const second = tool.execute("call-serial-2", {}, undefined, undefined, {} as never);

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    } finally {
      for (const [name, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await context.fiber.dispose();
    }
  });

  test("rejects a queued operation promptly when its caller aborts", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-queued-cancel-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-queued-cancel-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const bin = join(workspace, "bin");
    const started = join(workspace, "git-started");
    const rejected = join(workspace, "queued-rejected");
    await mkdir(bin);
    await writeFile(join(bin, "git"), '#!/bin/sh\n: > "$CAPSULE_GIT_STARTED"\nexec sleep 5\n', "utf8");
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    const originalStarted = process.env.CAPSULE_GIT_STARTED;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    process.env.CAPSULE_GIT_STARTED = started;
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    let first: Promise<unknown> | undefined;
    try {
      await context.plugin(gitTimeCapsulePlugin, { timeoutMs: 10_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;
      first = tool.execute("call-blocking", {}, undefined, undefined, {} as never);
      void first.catch(() => undefined);
      await waitForFile(started, "blocking Git operation to start");
      const controller = new AbortController();
      const second = tool.execute("call-queued", {}, controller.signal, undefined, {} as never);
      let rejection: unknown;
      void second.catch(async (error: unknown) => {
        rejection = error;
        await writeFile(rejected, "rejected", "utf8");
      });

      controller.abort(new Error("queued caller cancelled"));

      await waitForFile(rejected, "queued operation cancellation", 500);
      expect(rejection).toMatchObject({ message: "queued caller cancelled" });
    } finally {
      process.env.PATH = originalPath;
      if (originalStarted === undefined) delete process.env.CAPSULE_GIT_STARTED;
      else process.env.CAPSULE_GIT_STARTED = originalStarted;
      await context.fiber.dispose();
      await first?.catch(() => undefined);
    }
  });

  test("omits symbolic links from the recent capsule panel", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-panel-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-panel-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const directory = join(agentDir, "capsules");
    await mkdir(directory);
    const outside = join(workspace, "outside.patch");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(directory, "linked.patch"));
    const context = new Context();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", new PiToolRegistry());
    const panels = new PiPluginUiRegistry();
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin);
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "git-time-capsule-panel", data: { capsules: [] } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects a symbolic-link capsule directory before listing its target", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-panel-directory-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-panel-directory-agent-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-harness-capsule-panel-directory-outside-"));
    temporaryDirectories.push(workspace, agentDir, outside);
    await writeFile(join(outside, "outside.patch"), "outside", "utf8");
    await symlink(outside, join(agentDir, "capsules"));
    const context = new Context();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", new PiToolRegistry());
    const panels = new PiPluginUiRegistry();
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin);

      const snapshot = await panels.snapshot();
      expect(snapshot[0]?.id).toBe("git-time-capsule-panel");
      expect(snapshot[0]?.error).toMatch(/directory.*symbolic link/iu);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("does not expose the private capsule directory through panel read errors", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() === 0) return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-panel-error-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-panel-error-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const directory = join(agentDir, "capsules");
    await mkdir(directory);
    await chmod(directory, 0o000);
    const context = new Context();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", new PiToolRegistry());
    const panels = new PiPluginUiRegistry();
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin);

      const snapshot = await panels.snapshot();
      expect(snapshot[0]?.error).toBeDefined();
      expect(snapshot[0]?.error).not.toContain(agentDir);
      expect(snapshot[0]?.error).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    } finally {
      await chmod(directory, 0o700);
      await context.fiber.dispose();
    }
  });

  test("bounds the capsule inventory before rendering recent entries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-inventory-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-inventory-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const directory = join(agentDir, "capsules");
    await mkdir(directory);
    await Promise.all(Array.from({ length: 257 }, (_, index) => writeFile(join(directory, `${String(index).padStart(4, "0")}.patch`), "x", "utf8")));
    const context = new Context();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", new PiToolRegistry());
    const panels = new PiPluginUiRegistry();
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const snapshot = await panels.snapshot();
      expect(snapshot[0]?.id).toBe("git-time-capsule-panel");
      expect(snapshot[0]?.error).toMatch(/exceeds.*256.*capsule/iu);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("refuses a new capture before the bounded inventory becomes unusable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-full-inventory-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-full-inventory-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const directory = join(agentDir, "capsules");
    await mkdir(directory);
    await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(join(directory, `${String(index).padStart(4, "0")}.patch`), "x", "utf8")));
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const snapshot = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(snapshot.execute("call-full-inventory", {}, undefined, undefined, {} as never)).rejects.toThrow(/inventory.*256.*limit/iu);
      await expect(readdir(directory)).resolves.toHaveLength(256);
      const panelSnapshot = await panels.snapshot();
      expect(panelSnapshot[0]?.error).toBeUndefined();
      expect(panelSnapshot).toMatchObject([{ data: { inventory: { total: 256 } } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("refuses a new capture before exceeding the directory entry scan limit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-full-directory-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-full-directory-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const directory = join(agentDir, "capsules");
    await mkdir(directory);
    await Promise.all(Array.from({ length: 4_096 }, (_, index) => writeFile(join(directory, `entry-${String(index).padStart(4, "0")}.tmp`), "x", "utf8")));
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const snapshot = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(snapshot.execute("call-full-directory", {}, undefined, undefined, {} as never)).rejects.toThrow(/directory.*4096.*limit/iu);
      await expect(readdir(directory)).resolves.toHaveLength(4_096);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("reports when the recent capsule inventory is truncated", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-truncated-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-truncated-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const directory = join(agentDir, "capsules");
    await mkdir(directory);
    await Promise.all(Array.from({ length: 21 }, (_, index) => writeFile(join(directory, `${String(index).padStart(4, "0")}.patch`), "x", "utf8")));
    const context = new Context();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", new PiToolRegistry());
    const panels = new PiPluginUiRegistry();
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin);

      const snapshot = await panels.snapshot();
      expect(snapshot[0]?.id).toBe("git-time-capsule-panel");
      const data = snapshot[0]?.data as { capsules: unknown[]; inventory: Record<string, unknown> };
      expect(data.capsules).toHaveLength(20);
      expect(data.inventory).toEqual({ total: 21, shown: 20, truncated: true, displayLimit: 20 });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("uses the default timeout when configuration is not finite", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-config-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-config-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const context = new Context();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", new PiToolRegistry());
    const panels = new PiPluginUiRegistry();
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(gitTimeCapsulePlugin, { timeoutMs: Number.NaN });

      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "git-time-capsule-panel", data: { timeoutMs: 15_000 } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects unknown configuration before registering tools or panels", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-unknown-config-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-unknown-config-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      let failure: unknown;
      try {
        await context.plugin(gitTimeCapsulePlugin, { timeoutMs: 15_000, unexpected: true } as never);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/unknown.*unexpected/iu);

      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toEqual([]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rolls back both tools when panel registration fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-panel-conflict-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-panel-conflict-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    panels.register({ id: "git-time-capsule-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });
    try {
      await expect(context.plugin(gitTimeCapsulePlugin)).rejects.toThrow(/panel is already registered: git-time-capsule-panel/iu);

      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "git-time-capsule-panel", pluginId: "fixture" }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects a clean worktree instead of creating an unusable empty capsule", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-clean-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-clean-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "clean\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(tool.execute("call-clean", {}, undefined, undefined, {} as never)).rejects.toThrow(/no tracked git changes/iu);
      await expect(readdir(join(agentDir, "capsules"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("does not capture staged changes that restore cannot safely remove from the index", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-staged-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-staged-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "staged\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(tool.execute("call-staged", {}, undefined, undefined, {} as never)).rejects.toThrow(/staged.*excluded/iu);
      const { stdout: staged } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: workspace });
      expect(staged.trim()).toBe("tracked.txt");
      await expect(readdir(join(agentDir, "capsules"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("does not write snapshots through a symbolic-link capsule directory", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-snapshot-directory-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-snapshot-directory-agent-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-harness-capsule-snapshot-directory-outside-"));
    temporaryDirectories.push(workspace, agentDir, outside);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    await symlink(outside, join(agentDir, "capsules"));
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(tool.execute("call-directory-link", {}, undefined, undefined, {} as never)).rejects.toThrow(/directory.*symbolic link/iu);
      await expect(readdir(outside)).resolves.toEqual([]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects unexpected raw snapshot parameters without invoking accessors", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-snapshot-params-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-snapshot-params-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    let accessed = false;
    const rawParams = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(rawParams, "unexpected", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("accessor executed");
      },
    });
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(tool.execute("call-params", rawParams, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*unknown property/iu);
      expect(accessed).toBe(false);
      await expect(panels.snapshot()).resolves.toMatchObject([
        { data: { latest: { action: "capture", status: "failed", error: "Git snapshot parameters contains an unknown property" } } },
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects inaccessible or non-plain tool parameter objects", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-hostile-params-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-hostile-params-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const snapshot = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;
      const restore = tools.snapshot().customTools.find((candidate) => candidate.name === "git_restore")!;

      await expect(snapshot.execute("call-revoked", revocable.proxy, undefined, undefined, {} as never)).rejects.toThrow(
        /parameters.*accessible plain object/iu,
      );
      await expect(restore.execute("call-array", [], undefined, undefined, {} as never)).rejects.toThrow(/parameters.*object/iu);
      await expect(snapshot.execute("call-instance", new Date(), undefined, undefined, {} as never)).rejects.toThrow(/parameters.*plain object/iu);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("publishes sequential tools with closed parameter schemas", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-tool-contract-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-tool-contract-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);

      expect(tools.snapshot().customTools).toMatchObject([
        { name: "git_snapshot", executionMode: "sequential", parameters: { additionalProperties: false } },
        { name: "git_restore", executionMode: "sequential", parameters: { additionalProperties: false } },
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("counts tracked changes without invoking git status or scanning untracked files", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-no-status-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-no-status-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    await mkdir(join(workspace, "untracked"));
    await writeFile(join(workspace, "untracked", "ignored.txt"), "not captured\n", "utf8");
    const { stdout } = await execFileAsync("which", ["git"]);
    const bin = join(workspace, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$1" = "status" ]; then echo "git status must not be used" >&2; exit 91; fi\nexec "$REAL_GIT" "$@"\n',
      "utf8",
    );
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    const originalRealGit = process.env.REAL_GIT;
    process.env.REAL_GIT = stdout.trim();
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(tool.execute("call-no-status", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { files: 1 } });
    } finally {
      process.env.PATH = originalPath;
      if (originalRealGit === undefined) delete process.env.REAL_GIT;
      else process.env.REAL_GIT = originalRealGit;
      await context.fiber.dispose();
    }
  });

  test("counts files from the captured patch instead of a racing worktree query", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-count-race-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-count-race-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    const { stdout: realGit } = await execFileAsync("which", ["git"]);
    const bin = join(workspace, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), '#!/bin/sh\ncase " $* " in\n  *" --name-only "*) exit 0 ;;\nesac\nexec "$CAPSULE_REAL_GIT" "$@"\n', "utf8");
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    const originalRealGit = process.env.CAPSULE_REAL_GIT;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    process.env.CAPSULE_REAL_GIT = realGit.trim();
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(tool.execute("call-count-race", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { files: 1 } });
    } finally {
      process.env.PATH = originalPath;
      if (originalRealGit === undefined) delete process.env.CAPSULE_REAL_GIT;
      else process.env.CAPSULE_REAL_GIT = originalRealGit;
      await context.fiber.dispose();
    }
  });

  test("captures an applyable patch without invoking repository textconv drivers", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-textconv-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-textconv-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    const driver = join(workspace, "textconv-driver");
    const invoked = join(workspace, "textconv-invoked");
    await writeFile(driver, '#!/bin/sh\n: > "$CAPSULE_TEXTCONV_INVOKED"\ncat "$1"\n', "utf8");
    await chmod(driver, 0o700);
    await execFileAsync("git", ["config", "diff.capsule-fixture.textconv", driver], { cwd: workspace });
    await writeFile(join(workspace, ".gitattributes"), "*.data diff=capsule-fixture\n", "utf8");
    await writeFile(join(workspace, "tracked.data"), "before\n", "utf8");
    await execFileAsync("git", ["add", ".gitattributes", "tracked.data"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.data"), "after\n", "utf8");
    const originalInvoked = process.env.CAPSULE_TEXTCONV_INVOKED;
    process.env.CAPSULE_TEXTCONV_INVOKED = invoked;
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const snapshot = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;
      const restore = tools.snapshot().customTools.find((candidate) => candidate.name === "git_restore")!;

      await expect(snapshot.execute("call-textconv-capture", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { files: 1 } });
      await expect(readFile(invoked, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const names = await readdir(join(agentDir, "capsules"));
      await restore.execute("call-textconv-restore", { name: names[0], confirm: true }, undefined, undefined, {} as never);
      await expect(readFile(join(workspace, "tracked.data"), "utf8")).resolves.toBe("before\n");
    } finally {
      if (originalInvoked === undefined) delete process.env.CAPSULE_TEXTCONV_INVOKED;
      else process.env.CAPSULE_TEXTCONV_INVOKED = originalInvoked;
      await context.fiber.dispose();
    }
  });

  test("does not let inherited Git environment redirect capsule commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-env-workspace-"));
    const decoy = await mkdtemp(join(tmpdir(), "pi-harness-capsule-env-decoy-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-env-agent-"));
    temporaryDirectories.push(workspace, decoy, agentDir);
    for (const repository of [workspace, decoy]) {
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repository });
      await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
      await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: repository });
    }
    await writeFile(join(workspace, "workspace.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "workspace.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "workspace.txt"), "after\n", "utf8");
    await writeFile(join(decoy, "decoy.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "decoy.txt"], { cwd: decoy });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: decoy });
    await writeFile(join(decoy, "decoy.txt"), "after\n", "utf8");
    const originalGitDir = process.env.GIT_DIR;
    const originalGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(decoy, ".git");
    process.env.GIT_WORK_TREE = decoy;
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(tool.execute("call-env", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { files: 1 } });
      const names = await readdir(join(agentDir, "capsules"));
      expect(names).toHaveLength(1);
      const patch = await readFile(join(agentDir, "capsules", names[0]!), "utf8");
      expect(patch).toContain("workspace.txt");
      expect(patch).not.toContain("decoy.txt");
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = originalGitDir;
      if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = originalGitWorkTree;
      await context.fiber.dispose();
    }
  });

  test("does not let inherited Git config injection block a valid restore", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-config-env-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-config-env-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: workspace });
    await writeFile(join(workspace, "workspace.txt"), "before  \n", "utf8");
    await execFileAsync("git", ["add", "workspace.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "workspace.txt"), "after\n", "utf8");
    const original = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "apply.whitespace";
    process.env.GIT_CONFIG_VALUE_0 = "error-all";
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const snapshot = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;
      const restore = tools.snapshot().customTools.find((candidate) => candidate.name === "git_restore")!;

      await expect(snapshot.execute("call-config-env", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { files: 1 } });
      const names = await readdir(join(agentDir, "capsules"));
      await expect(restore.execute("call-config-env-restore", { name: names[0], confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { restored: true },
      });
      await expect(readFile(join(workspace, "workspace.txt"), "utf8")).resolves.toBe("before  \n");
    } finally {
      for (const [name, value] of [
        ["GIT_CONFIG_COUNT", original.count],
        ["GIT_CONFIG_KEY_0", original.key],
        ["GIT_CONFIG_VALUE_0", original.value],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await context.fiber.dispose();
    }
  });

  test("round-trips patches containing non-UTF-8 Git path bytes", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-path-bytes-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-path-bytes-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const bin = join(workspace, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$1" = "rev-parse" ]; then printf "true\\n"; exit 0; fi\ncase " $* " in\n  *" --name-only "*) printf "fixture.txt\\000" ;;\n  *) printf "diff-prefix\\377diff-suffix\\n" ;;\nesac\n',
      "utf8",
    );
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const snapshot = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await snapshot.execute("call-path-bytes-capture", {}, undefined, undefined, {} as never);
      const names = await readdir(join(agentDir, "capsules"));
      expect(names).toHaveLength(1);
      await expect(readFile(join(agentDir, "capsules", names[0]!))).resolves.toEqual(
        Buffer.from([...Buffer.from("diff-prefix"), 0xff, ...Buffer.from("diff-suffix\n")]),
      );
    } finally {
      process.env.PATH = originalPath;
      await context.fiber.dispose();
    }
  });

  test("does not publish a capsule when the captured patch cannot be validated", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-invalid-capture-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-invalid-capture-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const bin = join(workspace, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$1" = "rev-parse" ]; then printf "true\\n"; exit 0; fi\ncase " $* " in\n  *" apply --numstat "*) printf "invalid captured patch\\n" >&2; exit 3 ;;\n  *) printf "not a valid patch\\n" ;;\nesac\n',
      "utf8",
    );
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const snapshot = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(snapshot.execute("call-invalid-capture", {}, undefined, undefined, {} as never)).rejects.toThrow(/invalid captured patch/iu);
      await expect(readdir(join(agentDir, "capsules"))).resolves.toEqual([]);
    } finally {
      process.env.PATH = originalPath;
      await context.fiber.dispose();
    }
  });

  test("does not overwrite a capsule created concurrently at publication", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "pi-harness-capsule-publish-race-workspace-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-capsule-publish-race-agent-"));
    temporaryDirectories.push(workspace, agentDir);
    const bin = join(workspace, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$1" = "rev-parse" ]; then printf "true\\n"; exit 0; fi\ncase " $* " in\n  *" apply --numstat "*)\n    for argument do temporary="$argument"; done\n    directory=${temporary%/*}\n    base=${temporary##*/}\n    remainder=${base#.}\n    name=${remainder%.*.tmp}\n    printf "concurrent capsule\\n" > "$directory/$name"\n    printf "1\\t1\\tfixture.txt\\n"\n    exit 0\n    ;;\n  *) printf "captured patch\\n" ;;\nesac\n',
      "utf8",
    );
    await chmod(join(bin, "git"), 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    const context = new Context();
    const tools = new PiToolRegistry();
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(gitTimeCapsulePlugin);
      const snapshot = tools.snapshot().customTools.find((candidate) => candidate.name === "git_snapshot")!;

      await expect(snapshot.execute("call-publish-race", {}, undefined, undefined, {} as never)).rejects.toThrow(/exist/iu);
      const names = await readdir(join(agentDir, "capsules"));
      expect(names).toHaveLength(1);
      await expect(readFile(join(agentDir, "capsules", names[0]!), "utf8")).resolves.toBe("concurrent capsule\n");
    } finally {
      process.env.PATH = originalPath;
      await context.fiber.dispose();
    }
  });
});
