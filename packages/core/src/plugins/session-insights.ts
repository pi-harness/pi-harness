import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type SessionStats } from "@earendil-works/pi-coding-agent";

export default {
  name: "pi-session-insights",
  inject: ["piPluginUi", "piTools"],
  apply(context: Context) {
    const runtime = () => context.get("piRuntime");
    const readStats = (): SessionStats => {
      const service = runtime();
      if (service === undefined) throw new Error("Pi runtime is not ready");
      return service.session.getSessionStats();
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "session_report",
        label: "Session report",
        description: "Inspect the current session token, message, tool, cost, and context statistics.",
        promptSnippet: "inspect current session usage and context statistics",
        parameters: Type.Object({ compact: Type.Optional(Type.Boolean({ description: "Compact the session when true" })) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<SessionStats>> {
          const service = runtime();
          if (service === undefined) throw new Error("Pi runtime is not ready");
          if (params.compact === true) await service.session.compact();
          const report = readStats();
          return {
            content: [{ type: "text", text: `Session has ${report.totalMessages} messages and ${report.tokens.total} tracked tokens.` }],
            details: report,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "session-insights-panel",
      pluginId: "@pi-harness/core/plugins/session-insights",
      title: "Session Insights",
      description: "查看当前会话的消息、工具、token、成本和上下文统计，并可触发压缩。",
      icon: "▥",
      read: readStats,
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
