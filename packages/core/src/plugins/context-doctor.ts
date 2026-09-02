import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type ContextDoctorReport = {
  status: "ok" | "warning";
  usagePercent: number | null;
  tokens: number | null;
  contextWindow: number | null;
  messageCount: number;
  oversizedMessages: number;
  toolErrors: number;
  recommendations: string[];
};

export interface ContextDoctorPluginConfig {
  warnPercent?: number;
  maxMessageBytes?: number;
}

export const Config: z<ContextDoctorPluginConfig> = z.object({ warnPercent: z.number().default(75), maxMessageBytes: z.number().default(64 * 1024) });

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

function inspectMessages(
  messages: readonly unknown[],
  usage: { percent?: number | null; tokens?: number | null; contextWindow?: number | null } | undefined,
  warnPercent: number,
  maxMessageBytes: number,
): ContextDoctorReport {
  const oversizedMessages = messages.filter((message) => byteLength(message) > maxMessageBytes).length;
  const toolErrors = messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as Record<string, unknown>).role === "toolResult" &&
      (message as Record<string, unknown>).isError === true,
  ).length;
  const usagePercent = typeof usage?.percent === "number" ? usage.percent : null;
  const recommendations: string[] = [];
  if (usagePercent !== null && usagePercent >= warnPercent) recommendations.push("压缩较早的会话历史，释放上下文空间。");
  if (oversizedMessages > 0) recommendations.push(`检查 ${oversizedMessages} 条超大消息，优先引用摘要或文件路径。`);
  if (toolErrors > 0) recommendations.push(`处理 ${toolErrors} 个工具错误后再继续长任务。`);
  return {
    status: recommendations.length === 0 ? "ok" : "warning",
    usagePercent,
    tokens: typeof usage?.tokens === "number" ? usage.tokens : null,
    contextWindow: typeof usage?.contextWindow === "number" ? usage.contextWindow : null,
    messageCount: messages.length,
    oversizedMessages,
    toolErrors,
    recommendations,
  };
}

export default {
  name: "pi-context-doctor",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: ContextDoctorPluginConfig) {
    const warnPercent = Math.max(1, Math.min(100, config.warnPercent ?? 75));
    const maxMessageBytes = Math.max(1024, Math.min(1024 * 1024, Math.trunc(config.maxMessageBytes ?? 64 * 1024)));
    const runtime = () => context.get("piRuntime");
    const report = (): ContextDoctorReport => {
      const service = runtime();
      if (service === undefined) return inspectMessages([], undefined, warnPercent, maxMessageBytes);
      return inspectMessages(service.session.messages, service.session.getContextUsage(), warnPercent, maxMessageBytes);
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "context_doctor",
        label: "Context doctor",
        description: "Audit context pressure, oversized messages, and tool errors; optionally compact after confirmation.",
        promptSnippet: "audit context pressure and recommend safe cleanup",
        parameters: Type.Object({
          compact: Type.Optional(Type.Boolean({ description: "Compact the session after the audit" })),
          confirm: Type.Optional(Type.Boolean({ description: "Must be true when compact is requested" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<ContextDoctorReport & { compacted: boolean }>> {
          if (params.compact === true && params.confirm !== true) throw new Error("Context compaction requires confirm=true");
          const service = runtime();
          if (service === undefined) throw new Error("Pi runtime is not ready");
          if (params.compact === true) await service.session.compact();
          const details = { ...report(), compacted: params.compact === true };
          return {
            content: [
              {
                type: "text",
                text: `${details.status}: ${details.messageCount} messages, ${details.oversizedMessages} oversized, ${details.toolErrors} tool errors.`,
              },
            ],
            details,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "context-doctor-panel",
      pluginId: "@pi-harness/core/plugins/context-doctor",
      title: "Context Doctor",
      description: "审计上下文压力、超大消息和工具错误，并给出压缩建议。",
      icon: "⌁",
      read: report,
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
