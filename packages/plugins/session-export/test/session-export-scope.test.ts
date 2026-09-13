import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test, vi } from "vitest";
import type * as PluginApi from "@pi-harness/plugin-api";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const writeGate = vi.hoisted(() => {
  let markEntered!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      markEntered = resolve;
    }),
    releasePromise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    markEntered,
    release: () => release(),
  };
});

vi.mock("@pi-harness/plugin-api", async (importOriginal) => {
  const actual = await importOriginal<typeof PluginApi>();
  return {
    ...actual,
    atomicWriteFile: async (...args: Parameters<typeof actual.atomicWriteFile>): Promise<void> => {
      writeGate.markEntered();
      await writeGate.releasePromise;
      return actual.atomicWriteFile(...args);
    },
  };
});

const { default: sessionExportPlugin } = await import("../src/index.js");

describe("session export session scope", () => {
  test("rejects a write that completes after the native session changes", async () => {
    const firstWorkspace = await mkdtemp(join(tmpdir(), "pi-harness-export-scope-first-"));
    const secondWorkspace = await mkdtemp(join(tmpdir(), "pi-harness-export-scope-second-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    const firstManager = { getCwd: () => firstWorkspace, getSessionId: () => "first" };
    const secondManager = { getCwd: () => secondWorkspace, getSessionId: () => "second" };
    const runtime = {
      session: { sessionManager: firstManager, messages: [{ role: "user", content: "first session" }] },
    };
    provideLaunchContext(context, { cwd: firstWorkspace, agentDir: firstWorkspace, args: [], requestExit() {} });
    context.provide("piRuntime", runtime as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(sessionExportPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_export");
      if (tool === undefined) throw new Error("session_export was not registered");
      const pending = tool.execute("scope", { path: "scope.md" }, undefined, undefined, {} as never);
      await writeGate.entered;
      runtime.session = { sessionManager: secondManager, messages: [{ role: "user", content: "second session" }] };
      writeGate.release();
      await expect(pending).rejects.toThrow(/session changed/iu);
      await expect(readFile(join(firstWorkspace, "scope.md"))).rejects.toThrow();
      await expect(readFile(join(secondWorkspace, "scope.md"))).rejects.toThrow();
      expect((await panels.snapshot())[0]?.data).toMatchObject({ latest: null });
    } finally {
      writeGate.release();
      await context.fiber.dispose();
      await Promise.all([rm(firstWorkspace, { recursive: true, force: true }), rm(secondWorkspace, { recursive: true, force: true })]);
    }
  });
});
