import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";
import { applyCapsule } from "../src/plugins/git-time-capsule.js";
import gitTimeCapsulePlugin from "../src/plugins/git-time-capsule.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

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
    } finally {
      await context.fiber.dispose();
    }
  });
});
