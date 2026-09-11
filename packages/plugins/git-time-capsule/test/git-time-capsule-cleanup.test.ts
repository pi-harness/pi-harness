import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { Context } from "@deepseek-ai/cordis";
import { PiToolRegistry, PiPluginUiRegistry } from "@pi-harness/plugin-api";
import { expect, test, vi } from "vitest";
import plugin, { applyCapsule } from "../src/index.js";

const cleanup = vi.hoisted(() => ({
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
  failure: undefined as Error | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      await fs.rm(...args);
      // Delay only the restore's owned temporary-directory cleanup, after real I/O.
      if (typeof args[0] === "string" && basename(args[0]).startsWith("pi-harness-capsule-") && cleanup.release !== undefined) {
        cleanup.entered?.();
        await cleanup.release;
        if (cleanup.failure !== undefined) throw cleanup.failure;
      }
    },
  };
});

test.each(["tool", "direct", "direct-cleanup-error"])("reports uncertain workspace after %s restore cleanup interruption", async (mode) => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-restore-cleanup-race-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-restore-cleanup-agent-"));
  const git = promisify(execFile);
  const context = new Context(),
    tools = new PiToolRegistry(),
    panels = new PiPluginUiRegistry();
  const controller = new AbortController();
  let release: (() => void) | undefined;
  try {
    await git("git", ["init", "-q"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "before\n");
    await git("git", ["add", "tracked.txt"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "after\n");
    context.provide("piHarnessLaunch", { cwd: workspace, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(plugin);
    const snapshot = tools.snapshot().customTools.find((tool) => tool.name === "git_snapshot")!;
    const capture = await snapshot.execute("capture", {}, undefined, undefined, {} as never);
    const { name } = capture.details as { name: string };
    const entered = new Promise<void>((resolve) => {
      cleanup.entered = resolve;
    });
    cleanup.release = new Promise<void>((resolve) => {
      release = resolve;
    });
    const restore = tools.snapshot().customTools.find((tool) => tool.name === "git_restore")!;
    const pending =
      mode !== "tool"
        ? applyCapsule(workspace, join(agentDir, "capsules", name), 15000, controller.signal)
        : restore.execute("restore", { name, confirm: true }, controller.signal, undefined, {} as never);
    void pending.catch(() => undefined);
    await entered;
    if (mode === "direct-cleanup-error") cleanup.failure = new Error("owned cleanup failure");
    else controller.abort(new Error("caller cancelled during cleanup"));
    if (mode === "tool") await expect(pending).rejects.toThrow("Inspect the workspace before retrying");
    release!();
    // Drain the released cleanup's promise continuations before reading activity.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(pending).rejects.toThrow("Inspect the workspace before retrying");
    expect(await readFile(join(workspace, "tracked.txt"), "utf8")).toBe("before\n");
    if (mode === "tool") await expect(panels.snapshot()).resolves.toMatchObject([{ data: { latest: { action: "restore", status: "cancelled" } } }]);
  } finally {
    release?.();
    cleanup.entered = undefined;
    cleanup.release = undefined;
    cleanup.failure = undefined;
    controller.abort();
    await context.fiber.dispose();
    await rm(workspace, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});
