import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

export interface AnchoredStandardPluginConfig {
  maxToolCalls?: number;
}

export const Config: z<AnchoredStandardPluginConfig> = z.object({ maxToolCalls: z.number().default(64) });
type AnchorStatus = "idle" | "anchored" | "violated";
type Violation = { code: "orphan_tool" | "nested_run" | "tool_budget" | "orphan_end"; message: string };
type AnchorReport = { status: AnchorStatus; events: number; toolCalls: number; maxToolCalls: number; violations: Violation[] };

export default {
  name: "pi-anchored-standard",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: AnchoredStandardPluginConfig) {
    const maxToolCalls = Math.max(1, Math.min(512, Math.trunc(config.maxToolCalls ?? 64)));
    let active = false;
    let events = 0;
    let toolCalls = 0;
    const violations: Violation[] = [];
    const record = (violation: Violation): void => {
      if (!violations.some((item) => item.code === violation.code)) violations.push(violation);
    };
    const inspect = (event: { type: string }): void => {
      events += 1;
      if (event.type === "agent_start") {
        if (active) record({ code: "nested_run", message: "检测到未结束的 Agent 运行被再次启动。" });
        active = true;
        toolCalls = 0;
      } else if (event.type === "agent_end") {
        if (!active) record({ code: "orphan_end", message: "检测到没有对应启动事件的 Agent 结束事件。" });
        active = false;
      } else if (event.type === "tool_execution_start") {
        toolCalls += 1;
        if (!active) record({ code: "orphan_tool", message: "工具调用发生在 Agent 运行锚点之外。" });
        if (toolCalls > maxToolCalls) record({ code: "tool_budget", message: `单次运行工具调用超过 ${maxToolCalls} 次上限。` });
      }
    };
    const report = (): AnchorReport => ({
      status: violations.length > 0 ? "violated" : active ? "anchored" : "idle",
      events,
      toolCalls,
      maxToolCalls,
      violations: [...violations],
    });
    const unsubscribe = context.on("pi/session-event", inspect);
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "trajectory_anchor_check",
        label: "Trajectory anchor check",
        description: "Audit Agent lifecycle and tool-call ordering against the anchored execution standard.",
        promptSnippet: "audit the current agent trajectory for lifecycle violations",
        parameters: Type.Object({}),
        async execute(): Promise<AgentToolResult<AnchorReport>> {
          const result = report();
          return {
            content: [
              { type: "text", text: `${result.status}: ${result.events} events, ${result.toolCalls} tool calls, ${result.violations.length} violation(s).` },
            ],
            details: result,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "anchored-standard-panel",
      pluginId: "@pi-harness/core/plugins/anchored-standard",
      title: "Anchored Standard",
      description: "审计 Agent 生命周期和工具调用顺序，发现脱离运行锚点的执行。",
      icon: "⌁",
      read: report,
    });
    context.effect(() => () => {
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
