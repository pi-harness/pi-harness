import { stat } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "@pi-harness/plugin-api";

export type RuntimeDoctorCheckStatus = "ok" | "warning" | "error";
export interface RuntimeDoctorCheck {
  readonly id: "workspace" | "agent-dir" | "model" | "runtime" | "mcp" | "extensions";
  readonly status: RuntimeDoctorCheckStatus;
  readonly detail: string;
}

export interface RuntimeDoctorInput {
  readonly cwd: string;
  readonly agentDir: string;
  readonly cwdDirectory: boolean;
  readonly agentDirDirectory: boolean;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly runtimeReady: boolean;
  readonly mcpServers: number;
  readonly mcpRunning: number;
  readonly extensionErrors: number;
}

export interface RuntimeDoctorReport {
  readonly status: "ok" | "warning" | "error";
  readonly checks: readonly RuntimeDoctorCheck[];
  readonly recommendations: readonly string[];
}

export function diagnoseRuntime(input: RuntimeDoctorInput): RuntimeDoctorReport {
  const checks: RuntimeDoctorCheck[] = [
    {
      id: "workspace",
      status: input.cwdDirectory ? "ok" : "error",
      detail: input.cwdDirectory ? input.cwd : `${input.cwd} 不是可访问的目录`,
    },
    {
      id: "agent-dir",
      status: input.agentDirDirectory ? "ok" : "error",
      detail: input.agentDirDirectory ? input.agentDir : `${input.agentDir} 不是可访问的目录`,
    },
    {
      id: "model",
      status: input.model === undefined ? "error" : "ok",
      detail: input.model === undefined ? "未配置模型" : `${input.model.provider}/${input.model.id}`,
    },
    {
      id: "runtime",
      status: input.runtimeReady ? "ok" : "error",
      detail: input.runtimeReady ? "运行时服务已注册（未探测模型请求）" : "运行时服务未注册",
    },
    {
      id: "mcp",
      status: input.mcpRunning < input.mcpServers ? "warning" : "ok",
      detail: input.mcpServers > 0 ? `${input.mcpRunning}/${input.mcpServers} 个 MCP 服务处于 running 状态` : "未配置 MCP 服务（可选）",
    },
    {
      id: "extensions",
      status: input.extensionErrors > 0 ? "warning" : "ok",
      detail: input.extensionErrors > 0 ? `${input.extensionErrors} 个扩展错误` : "没有扩展错误",
    },
  ];
  const recommendations: string[] = [];
  if (!input.cwdDirectory) recommendations.push("检查当前工作区路径和权限。");
  if (!input.agentDirDirectory) recommendations.push("检查 agent 目录路径和权限。");
  if (input.model === undefined) recommendations.push("在设置中配置一个可用的 provider 和 model。");
  if (!input.runtimeReady) recommendations.push("等待运行时启动完成后重试。");
  if (input.mcpRunning < input.mcpServers) recommendations.push("检查未运行的 MCP 服务；未使用的服务可保持停止。");
  if (input.extensionErrors > 0) recommendations.push("查看扩展错误并禁用失败的扩展。");
  const status = checks.some((check) => check.status === "error") ? "error" : recommendations.length > 0 ? "warning" : "ok";
  return { status, checks, recommendations };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export default {
  name: "pi-runtime-doctor",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let extensionErrors = 0;
    const lifecycle = new AbortController();
    const checkCancelled = (signal: AbortSignal) => {
      if (signal.aborted) throw new Error("Runtime diagnosis was cancelled");
    };
    const inspect = async (signal = lifecycle.signal): Promise<RuntimeDoctorReport> => {
      checkCancelled(signal);
      const runtime = context.get("piRuntime");
      const session = runtime?.session;
      const manager = session?.sessionManager;
      const sessionId = manager?.getSessionId();
      const cwd = manager?.getCwd() ?? context.piHarnessLaunch.cwd;
      const agentDir = context.piHarnessLaunch.agentDir;
      const [cwdDirectory, agentDirDirectory] = await Promise.all([isDirectory(cwd), isDirectory(agentDir)]);
      checkCancelled(signal);
      if (
        context.get("piRuntime") !== runtime ||
        runtime?.session !== session ||
        manager?.getSessionId() !== sessionId ||
        (manager !== undefined && manager.getCwd() !== cwd)
      )
        throw new Error("Runtime session changed during diagnosis; retry");
      const model = session === undefined ? context.get("piModels")?.model : session.model;
      const servers = context.get("piMcp")?.snapshot().servers ?? [];
      return diagnoseRuntime({
        cwd,
        agentDir,
        cwdDirectory,
        agentDirDirectory,
        ...(model === undefined ? {} : { model: { provider: model.provider, id: model.id } }),
        runtimeReady: runtime !== undefined,
        mcpServers: servers.length,
        mcpRunning: servers.filter((server) => server.status === "running").length,
        extensionErrors,
      });
    };
    const unsubscribe = context.on("pi/extension-error", () => {
      extensionErrors += 1;
    });
    let unregisterTool = () => {};
    try {
      unregisterTool = context.piTools.register(
        defineTool({
          name: "runtime_doctor",
          label: "Runtime doctor",
          description: "Audit workspace, agent directory, model, runtime, MCP servers, and extension errors in one read-only report.",
          promptSnippet: "diagnose whether the Pi Harness runtime is ready",
          parameters: Type.Object({}, { additionalProperties: false }),
          executionMode: "sequential",
          async execute(_toolCallId, params, callerSignal): Promise<AgentToolResult<RuntimeDoctorReport>> {
            const signal = callerSignal === undefined ? lifecycle.signal : AbortSignal.any([callerSignal, lifecycle.signal]);
            checkCancelled(signal);
            if (params === null || typeof params !== "object" || Array.isArray(params) || Reflect.ownKeys(params).length !== 0)
              throw new Error("Runtime doctor parameters must be an empty object");
            const report = await inspect(signal);
            return {
              content: [{ type: "text", text: `${report.status}: ${report.checks.filter((check) => check.status !== "ok").length} checks need attention.` }],
              details: report,
            };
          },
        }),
      );
      const disposePanel = context.piPluginUi.register({
        id: "runtime-doctor-panel",
        pluginId: "@pi-harness/plugin-runtime-doctor",
        title: "Runtime Doctor",
        description: "一次检查工作区、模型、运行时、MCP 和扩展错误。",
        icon: "⊙",
        read: () => inspect(),
      });
      context.effect(() => () => {
        lifecycle.abort();
        unsubscribe();
        unregisterTool();
        disposePanel();
      });
    } catch (error) {
      lifecycle.abort();
      unsubscribe();
      unregisterTool();
      throw error;
    }
  },
};
