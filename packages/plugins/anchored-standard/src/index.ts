import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

const maxAllowedTools = 512;
const maxToolNameLength = 128;

export interface AnchoredStandardPluginConfig {
  maxToolCalls?: number;
  allowedTools?: string[];
}

export const Config: z<AnchoredStandardPluginConfig> = z.object({
  maxToolCalls: z.number().default(64),
  allowedTools: z.array(z.string().min(1).max(maxToolNameLength).pattern(/\S/u)).max(maxAllowedTools).default([]),
});
type AnchorStatus = "idle" | "anchored" | "violated";
type Violation = { code: "orphan_tool" | "nested_run" | "tool_budget" | "orphan_end" | "disallowed_tool"; message: string };
type AnchorReport = { status: AnchorStatus; events: number; toolCalls: number; maxToolCalls: number; allowedTools: string[]; violations: Violation[] };

export default {
  name: "pi-anchored-standard",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: AnchoredStandardPluginConfig) {
    assertKnownConfigKeys("anchored-standard", config, ["maxToolCalls", "allowedTools"]);
    const configuredMaxToolCalls = config.maxToolCalls ?? 64;
    const maxToolCalls = Number.isFinite(configuredMaxToolCalls) ? Math.max(1, Math.min(512, Math.trunc(configuredMaxToolCalls))) : 64;
    if ((config.allowedTools?.length ?? 0) > maxAllowedTools) throw new Error(`Anchored-standard allows at most ${maxAllowedTools} tool names`);
    if ((config.allowedTools ?? []).some((tool) => tool.trim() === "")) throw new Error("Anchored-standard tool names must contain non-whitespace characters");
    if ((config.allowedTools ?? []).some((tool) => tool.trim().length > maxToolNameLength))
      throw new Error(`Anchored-standard tool names must contain at most ${maxToolNameLength} characters`);
    const allowedTools = [...new Set((config.allowedTools ?? []).map((tool) => tool.trim()).filter(Boolean))];
    const allowedToolSet = new Set(allowedTools);
    let active = false;
    let events = 0;
    let toolCalls = 0;
    const violations: Violation[] = [];
    const record = (violation: Violation): void => {
      if (!violations.some((item) => item.code === violation.code)) violations.push(violation);
    };
    const inspect = (event: { type: string; toolName?: unknown }): void => {
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
        const toolName = typeof event.toolName === "string" ? event.toolName.trim() : "";
        if (allowedToolSet.size > 0 && !allowedToolSet.has(toolName))
          record({ code: "disallowed_tool", message: `工具 ${toolName || "<unknown>"} 不在当前运行的允许列表中。` });
      }
    };
    const report = (): AnchorReport => ({
      status: violations.length > 0 ? "violated" : active ? "anchored" : "idle",
      events,
      toolCalls,
      maxToolCalls,
      allowedTools: [...allowedTools],
      violations: [...violations],
    });
    const unsubscribe = context.on("pi/session-event", inspect);
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "trajectory_anchor_check",
        label: "Trajectory anchor check",
        description: "Audit Agent lifecycle and tool-call ordering against the anchored execution standard.",
        promptSnippet: "audit the current agent trajectory for lifecycle violations",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        execute(): Promise<AgentToolResult<AnchorReport>> {
          return Promise.resolve().then(() => {
            const result = report();
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${result.status}: ${result.events} events, ${result.toolCalls} tool calls, ${result.violations.length} violation(s).`,
                },
              ],
              details: result,
            };
          });
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "anchored-standard-panel",
        pluginId: "@pi-harness/plugin-anchored-standard",
        title: "Anchored Standard",
        description: "审计 Agent 生命周期和工具调用顺序，发现脱离运行锚点的执行。",
        icon: "⌁",
        read: report,
      });
    } catch (error) {
      unregisterTool();
      throw error;
    }
    context.effect(() => () => {
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
