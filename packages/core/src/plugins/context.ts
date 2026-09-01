import type { Context } from "@deepseek-ai/cordis";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

type RuntimeEvent = AgentSessionEvent & { readonly type?: string };

export default {
  name: "pi-context",
  inject: ["piRuntime", "piPluginUi"],
  apply(context: Context) {
    let eventCount = 0;
    let compactionCount = 0;
    const onEvent = (event: RuntimeEvent) => {
      eventCount += 1;
      if (event.type?.startsWith("compaction_")) compactionCount += 1;
    };
    const unsubscribe = context.on("pi/session-event", onEvent);
    const disposePanel = context.piPluginUi.register({
      id: "context-insight-panel",
      pluginId: "@pi-harness/core/plugins/context",
      title: "上下文洞察",
      description: "查看当前上下文占用、消息规模和压缩事件。",
      icon: "◒",
      read: () => {
        const usage = context.piRuntime.session.getContextUsage();
        return {
          tokens: usage?.tokens ?? null,
          contextWindow: usage?.contextWindow ?? null,
          percent: usage?.percent ?? null,
          messages: context.piRuntime.session.messages.length,
          events: eventCount,
          compactions: compactionCount,
        };
      },
    });
    context.effect(() => () => {
      unsubscribe();
      disposePanel();
    });
  },
};
