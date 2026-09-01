import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import z from "@deepseek-ai/schemastery";

type CompressionState = { enabled: boolean; thresholdPercent: number; compactions: number; lastUsagePercent: number | null; lastError: string | null };
export interface HistoryCompressorPluginConfig {
  enabled?: boolean;
  thresholdPercent?: number;
}
export const Config: z<HistoryCompressorPluginConfig> = z.object({ enabled: z.boolean().default(true), thresholdPercent: z.number().default(85) });

export default {
  name: "pi-history-compressor",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: HistoryCompressorPluginConfig) {
    const enabled = config.enabled !== false;
    const thresholdPercent = Math.max(1, Math.min(100, config.thresholdPercent ?? 85));
    const state: CompressionState = { enabled, thresholdPercent, compactions: 0, lastUsagePercent: null, lastError: null };
    let inFlight = false;
    const runtime = () => context.get("piRuntime");
    const compact = async (automatic: boolean): Promise<{ compacted: boolean; automatic: boolean }> => {
      const service = runtime();
      if (service === undefined) throw new Error("Pi runtime is not ready");
      if (automatic && !enabled) return { compacted: false, automatic };
      if (inFlight) return { compacted: false, automatic };
      inFlight = true;
      try {
        await service.session.compact();
        state.compactions += 1;
        state.lastError = null;
        return { compacted: true, automatic };
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        inFlight = false;
      }
    };
    const inspectAndMaybeCompact = (): void => {
      const service = runtime();
      const usage = service?.session.getContextUsage();
      state.lastUsagePercent = typeof usage?.percent === "number" ? usage.percent : null;
      if (enabled && state.lastUsagePercent !== null && state.lastUsagePercent >= thresholdPercent) void compact(true).catch(() => undefined);
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      if ((event as { type?: string }).type === "agent_end") inspectAndMaybeCompact();
    });
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "compress_history",
        label: "Compress history",
        description: "Compact the current Pi session after explicit confirmation.",
        promptSnippet: "compact the current conversation history",
        parameters: Type.Object({ confirm: Type.Boolean({ description: "Must be true to compact history" }) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ compacted: boolean; automatic: boolean }>> {
          if (params.confirm !== true) throw new Error("History compaction requires confirm=true");
          const result = await compact(false);
          return {
            content: [{ type: "text", text: result.compacted ? "Session history compacted." : "Session compaction is already running." }],
            details: result,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "history-compressor-panel",
      pluginId: "@pi-harness/core/plugins/history-compressor",
      title: "History Compressor",
      description: "在上下文接近阈值时自动压缩历史消息。",
      icon: "↯",
      read: () => ({ ...state }),
    });
    context.effect(() => () => {
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
