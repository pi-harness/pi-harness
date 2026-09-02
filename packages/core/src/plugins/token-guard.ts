import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

export interface TokenGuardPluginConfig {
  maxPercent?: number;
}

export const Config: z<TokenGuardPluginConfig> = z.object({ maxPercent: z.number().default(90) });

export default {
  name: "pi-token-guard",
  inject: ["piRuntime", "piPluginUi"],
  Config,
  apply(context: Context, config: TokenGuardPluginConfig) {
    const maxPercent = Math.max(1, Math.min(100, config.maxPercent ?? 90));
    let abortCount = 0;
    let lastPercent: number | null = null;
    let lastTokens: number | null = null;
    let lastContextWindow = 0;
    let lastExceeded = false;
    let abortIssued = false;
    const inspect = (): void => {
      const usage = context.piRuntime.session.getContextUsage();
      lastPercent = usage?.percent ?? null;
      lastTokens = usage?.tokens ?? null;
      lastContextWindow = usage?.contextWindow ?? 0;
      lastExceeded = lastPercent !== null && lastPercent >= maxPercent;
      if (!lastExceeded) abortIssued = false;
      if (lastExceeded && context.piRuntime.session.isStreaming && !abortIssued) {
        abortIssued = true;
        abortCount += 1;
        void context.piRuntime.abort();
      }
    };
    const unsubscribe = context.on("pi/session-event", inspect);
    const disposePanel = context.piPluginUi.register({
      id: "token-guard-panel",
      pluginId: "@pi-harness/core/plugins/token-guard",
      title: "Token Guard",
      description: "在上下文达到预算阈值时自动停止当前运行，避免继续消耗上下文。",
      icon: "◌",
      read: () => {
        inspect();
        return { maxPercent, percent: lastPercent, tokens: lastTokens, contextWindow: lastContextWindow, exceeded: lastExceeded, aborts: abortCount };
      },
    });
    context.effect(() => () => {
      unsubscribe();
      disposePanel();
    });
  },
};
