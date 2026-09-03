import type { Context } from "@deepseek-ai/cordis";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type RuntimeEvent = AgentSessionEvent & { readonly type?: string };
type MessageRole = "user" | "assistant" | "toolResult" | "system" | "other";
type ContextComposition = Record<MessageRole, number>;
type ContextInsightReport = {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  messages: number;
  events: number;
  compactions: number;
  composition: ContextComposition;
  eventTypes: Record<string, number>;
  recentEvents: { type: string; at: number }[];
};

function messageRole(message: unknown): MessageRole {
  if (typeof message !== "object" || message === null) return "other";
  const role = (message as { role?: unknown }).role;
  if (role === "user" || role === "assistant" || role === "toolResult" || role === "system") return role;
  return "other";
}

export default {
  name: "pi-context",
  inject: ["piPluginUi", "piTools"],
  apply(context: Context) {
    let eventCount = 0;
    let compactionCount = 0;
    const eventTypes = new Map<string, number>();
    const recentEvents: { type: string; at: number }[] = [];
    const onEvent = (event: RuntimeEvent) => {
      eventCount += 1;
      const type = event.type ?? "unknown";
      eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
      recentEvents.push({ type, at: Date.now() });
      if (recentEvents.length > 50) recentEvents.shift();
      if (type.startsWith("compaction_")) compactionCount += 1;
    };
    const unsubscribe = context.on("pi/session-event", onEvent);
    const report = (): ContextInsightReport => {
      const runtime = context.get("piRuntime");
      if (runtime === undefined) {
        return {
          tokens: null,
          contextWindow: null,
          percent: null,
          messages: 0,
          events: eventCount,
          compactions: compactionCount,
          composition: { user: 0, assistant: 0, toolResult: 0, system: 0, other: 0 },
          eventTypes: Object.fromEntries(eventTypes),
          recentEvents: recentEvents.map((event) => ({ ...event })),
        };
      }
      const usage = runtime.session.getContextUsage();
      const composition: ContextComposition = { user: 0, assistant: 0, toolResult: 0, system: 0, other: 0 };
      for (const message of runtime.session.messages) composition[messageRole(message)] += 1;
      return {
        tokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? null,
        percent: usage?.percent ?? null,
        messages: runtime.session.messages.length,
        events: eventCount,
        compactions: compactionCount,
        composition,
        eventTypes: Object.fromEntries(eventTypes),
        recentEvents: recentEvents.map((event) => ({ ...event })),
      };
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "context_inspect",
        label: "Context inspect",
        description: "Inspect current context usage, message composition, and recent lifecycle events.",
        promptSnippet: "inspect the current context composition and recent events",
        parameters: Type.Object({}),
        execute(): Promise<AgentToolResult<ContextInsightReport>> {
          const details = report();
          return Promise.resolve({ content: [{ type: "text", text: `${details.messages} messages, ${details.events} context events.` }], details });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "context-insight-panel",
      pluginId: "@pi-harness/core/plugins/context",
      title: "上下文洞察",
      description: "查看当前上下文占用、消息规模和压缩事件。",
      icon: "◒",
      read: report,
    });
    context.effect(() => () => {
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
