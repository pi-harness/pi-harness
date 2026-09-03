import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

export interface TokenGuardPluginConfig {
  maxPercent?: number;
  maxRunTokens?: number;
}

export const Config: z<TokenGuardPluginConfig> = z.object({ maxPercent: z.number().default(90), maxRunTokens: z.number().default(0) });

export default {
  name: "pi-token-guard",
  inject: ["piRuntime", "piPluginUi"],
  Config,
  apply(context: Context, config: TokenGuardPluginConfig) {
    const maxPercent = Math.max(1, Math.min(100, config.maxPercent ?? 90));
    const maxRunTokens = Math.max(0, Math.min(10_000_000, Math.trunc(config.maxRunTokens ?? 0)));
    let abortCount = 0;
    let lastPercent: number | null = null;
    let lastTokens: number | null = null;
    let lastContextWindow = 0;
    let lastExceeded = false;
    let abortIssued = false;
    let runStartTokens: number | null = null;
    let runTokens: number | null = null;
    let runExceeded = false;
    const sessionTokens = (): number | null => {
      const stats = context.piRuntime.session.getSessionStats?.();
      const total = stats?.tokens?.total;
      return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
    };
    const inspect = (): void => {
      const usage = context.piRuntime.session.getContextUsage();
      lastPercent = usage?.percent ?? null;
      lastTokens = usage?.tokens ?? null;
      lastContextWindow = usage?.contextWindow ?? 0;
      lastExceeded = lastPercent !== null && lastPercent >= maxPercent;
      const currentTokens = sessionTokens();
      runTokens = runStartTokens === null || currentTokens === null ? null : Math.max(0, currentTokens - runStartTokens);
      runExceeded = maxRunTokens > 0 && runTokens !== null && runTokens >= maxRunTokens;
      lastExceeded = lastExceeded || runExceeded;
      if (!lastExceeded) abortIssued = false;
      if (lastExceeded && context.piRuntime.session.isStreaming && !abortIssued) {
        abortIssued = true;
        abortCount += 1;
        void context.piRuntime.abort();
      }
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      if (event.type === "agent_start") {
        runStartTokens = sessionTokens();
        runTokens = runStartTokens === null ? null : 0;
        runExceeded = false;
        abortIssued = false;
      }
      inspect();
    });
    const disposePanel = context.piPluginUi.register({
      id: "token-guard-panel",
      pluginId: "@pi-harness/core/plugins/token-guard",
      title: "Token Guard",
      description: "在上下文达到预算阈值时自动停止当前运行，避免继续消耗上下文。",
      icon: "◌",
      read: () => {
        inspect();
        return {
          maxPercent,
          maxRunTokens,
          percent: lastPercent,
          tokens: lastTokens,
          contextWindow: lastContextWindow,
          runTokens,
          runExceeded,
          exceeded: lastExceeded,
          aborts: abortCount,
        };
      },
    });
    context.effect(() => () => {
      unsubscribe();
      disposePanel();
    });
  },
};
