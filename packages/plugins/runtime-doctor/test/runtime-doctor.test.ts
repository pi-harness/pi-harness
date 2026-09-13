import { Context } from "@deepseek-ai/cordis";
import { PiToolRegistry, PiPluginUiRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/index.js";
import { describe, expect, test, vi } from "vitest";
import { diagnoseRuntime } from "../src/index.js";

describe("runtime doctor", () => {
  test("reports actionable failures and warnings", () => {
    const report = diagnoseRuntime({
      cwd: "/workspace",
      agentDir: "/agent",
      cwdDirectory: true,
      agentDirDirectory: false,
      model: { provider: "everyapi", id: "deepseek-v4-flash" },
      runtimeReady: true,
      mcpServers: 2,
      mcpRunning: 2,
      extensionErrors: 1,
    });
    expect(report.status).toBe("error");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        { id: "workspace", status: "ok", detail: "/workspace" },
        { id: "agent-dir", status: "error", detail: "/agent 不是可访问的目录" },
        { id: "model", status: "ok", detail: "everyapi/deepseek-v4-flash" },
        { id: "runtime", status: "ok", detail: "运行时服务已注册（未探测模型请求）" },
        { id: "mcp", status: "ok", detail: "2/2 个 MCP 服务处于 running 状态" },
        { id: "extensions", status: "warning", detail: "1 个扩展错误" },
      ]),
    );
    expect(report.recommendations).toContain("检查 agent 目录路径和权限。");
    expect(report.recommendations).toContain("查看扩展错误并禁用失败的扩展。");
  });

  test("stays healthy when all runtime boundaries are ready", () => {
    const report = diagnoseRuntime({
      cwd: "/workspace",
      agentDir: "/agent",
      cwdDirectory: true,
      agentDirDirectory: true,
      model: { provider: "everyapi", id: "deepseek-v4-flash" },
      runtimeReady: true,
      mcpServers: 0,
      mcpRunning: 0,
      extensionErrors: 0,
    });
    expect(report).toEqual({
      status: "ok",
      checks: [
        { id: "workspace", status: "ok", detail: "/workspace" },
        { id: "agent-dir", status: "ok", detail: "/agent" },
        { id: "model", status: "ok", detail: "everyapi/deepseek-v4-flash" },
        { id: "runtime", status: "ok", detail: "运行时服务已注册（未探测模型请求）" },
        { id: "mcp", status: "ok", detail: "未配置 MCP 服务（可选）" },
        { id: "extensions", status: "ok", detail: "没有扩展错误" },
      ],
      recommendations: [],
    });
  });
});

test("uses the active session model and workspace, rejects files as directories and reports stopped MCP", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-doctor-"));
  const file = join(root, "not-a-directory");
  await writeFile(file, "data");
  const context = new Context(),
    tools = new PiToolRegistry(),
    panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: file, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  context.provide("piModels", { model: { provider: "stale", id: "old" } } as never);
  context.provide("piRuntime", {
    session: { model: { provider: "active", id: "new" }, sessionManager: { getCwd: () => root, getSessionId: () => "active" } },
  } as never);
  context.provide("piMcp", { snapshot: () => ({ servers: [{ id: "stopped", command: [], status: "stopped", startedAt: 0 }] }) });
  try {
    await context.plugin(plugin);
    const report = (await tools.snapshot().customTools[0]!.execute("inspect", {}, undefined, undefined, {} as never)).details as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    expect(report.checks.find((x) => x.id === "agent-dir")?.status).toBe("error");
    expect(report.checks.find((x) => x.id === "model")?.detail).toBe("active/new");
    expect(report.checks.find((x) => x.id === "mcp")?.status).toBe("warning");
    const caller = new AbortController();
    caller.abort();
    const tool = tools.snapshot().customTools[0]!;
    await expect(tool.execute("cancel", {}, caller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
    await context.fiber.dispose();
    await expect(tool.execute("disposed", {}, undefined, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("rolls back tool registration when the panel cannot register", () => {
  const context = new Context(),
    tools = new PiToolRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", {
    register() {
      throw new Error("panel unavailable");
    },
  } as never);
  expect(() => plugin.apply(context)).toThrow("panel unavailable");
  expect(tools.snapshot().customTools).toHaveLength(0);
});

test("rejects an in-flight cancellation and session replacement, without falling back to a stale model", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-doctor-switch-"));
  const context = new Context(),
    tools = new PiToolRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", new PiPluginUiRegistry());
  const manager = { getCwd: () => root, getSessionId: () => "before" };
  context.provide("piRuntime", { session: { model: undefined, sessionManager: manager } } as never);
  context.provide("piModels", { model: { provider: "stale", id: "old" } } as never);
  try {
    await context.plugin(plugin);
    const tool = tools.snapshot().customTools[0]!;
    const call = (signal?: AbortSignal) => tool.execute("inspect", {}, signal, undefined, {} as never);
    const report = (await call()).details as { checks: Array<{ id: string; status: string }> };
    expect(report.checks.find((x) => x.id === "model")?.status).toBe("error");
    const caller = new AbortController();
    const pending = call(caller.signal);
    caller.abort();
    await expect(pending).rejects.toThrow(/cancelled/iu);
    const changed = call();
    vi.spyOn(manager, "getSessionId").mockReturnValue("after");
    await expect(changed).rejects.toThrow(/session changed/iu);
    await expect(tool.execute("invalid", { extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/parameters/iu);
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
