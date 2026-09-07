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
  readonly cwdExists: boolean;
  readonly agentDirExists: boolean;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly runtimeReady: boolean;
  readonly mcpServers: number;
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
      status: input.cwdExists ? "ok" : "error",
      detail: input.cwdExists ? input.cwd : `${input.cwd} 不存在`,
    },
    {
      id: "agent-dir",
      status: input.agentDirExists ? "ok" : "error",
      detail: input.agentDirExists ? input.agentDir : `${input.agentDir} 不存在`,
    },
    {
      id: "model",
      status: input.model === undefined ? "error" : "ok",
      detail: input.model === undefined ? "未配置模型" : `${input.model.provider}/${input.model.id}`,
    },
    {
      id: "runtime",
      status: input.runtimeReady ? "ok" : "error",
      detail: input.runtimeReady ? "运行时已就绪" : "运行时尚未就绪",
    },
    {
      id: "mcp",
      status: "ok",
      detail: input.mcpServers > 0 ? `${input.mcpServers} 个 MCP 服务` : "没有运行中的 MCP 服务",
    },
    {
      id: "extensions",
      status: input.extensionErrors > 0 ? "warning" : "ok",
      detail: input.extensionErrors > 0 ? `${input.extensionErrors} 个扩展错误` : "没有扩展错误",
    },
  ];
  const recommendations: string[] = [];
  if (!input.cwdExists) recommendations.push("检查当前工作区路径和权限。");
  if (!input.agentDirExists) recommendations.push("检查 agent 目录路径和权限。");
  if (input.model === undefined) recommendations.push("在设置中配置一个可用的 provider 和 model。");
  if (!input.runtimeReady) recommendations.push("等待运行时启动完成后重试。");
  if (input.extensionErrors > 0) recommendations.push("查看扩展错误并禁用失败的扩展。");
  const status = checks.some((check) => check.status === "error") ? "error" : recommendations.length > 0 ? "warning" : "ok";
  return { status, checks, recommendations };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
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
    const inspect = async (): Promise<RuntimeDoctorReport> => {
      const [cwdExists, agentDirExists] = await Promise.all([pathExists(context.piHarnessLaunch.cwd), pathExists(context.piHarnessLaunch.agentDir)]);
      const models = context.get("piModels");
      const runtime = context.get("piRuntime");
      const mcp = context.get("piMcp");
      const model = models?.model;
      return diagnoseRuntime({
        cwd: context.piHarnessLaunch.cwd,
        agentDir: context.piHarnessLaunch.agentDir,
        cwdExists,
        agentDirExists,
        ...(model === undefined ? {} : { model: { provider: model.provider, id: model.id } }),
        runtimeReady: runtime !== undefined,
        mcpServers: mcp?.snapshot().servers.length ?? 0,
        extensionErrors,
      });
    };
    const unsubscribe = context.on("pi/extension-error", () => {
      extensionErrors += 1;
    });
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "runtime_doctor",
        label: "Runtime doctor",
        description: "Audit workspace, agent directory, model, runtime, MCP servers, and extension errors in one read-only report.",
        promptSnippet: "diagnose whether the Pi Harness runtime is ready",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(): Promise<AgentToolResult<RuntimeDoctorReport>> {
          const report = await inspect();
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
      read: inspect,
    });
    context.effect(() => () => {
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
