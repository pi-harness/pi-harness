import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type PlanStatus = "pending" | "in_progress" | "done" | "skipped";
type PlanStep = { id: number; title: string; status: PlanStatus };
type Plan = { title: string; steps: PlanStep[] };

function requirePlan(plan: Plan | undefined): Plan {
  if (!plan) throw new Error("No plan exists; create one with plan_create first");
  return plan;
}

export default {
  name: "pi-plan-execute",
  inject: ["piPluginUi", "piTools"],
  apply(context: Context) {
    let plan: Plan | undefined;
    const create = context.piTools.register(
      defineTool({
        name: "plan_create",
        label: "Create plan",
        description: "Create or replace a structured execution plan with ordered steps.",
        promptSnippet: "create an execution plan before making a multi-step change",
        parameters: Type.Object({ title: Type.String(), steps: Type.Array(Type.String()) }),
        execute(_toolCallId, params): Promise<AgentToolResult<Plan>> {
          return Promise.resolve().then(() => {
            const title = params.title.trim();
            const steps = params.steps.map((step) => step.trim());
            if (!title) throw new Error("Plan title cannot be empty");
            if (steps.length === 0 || steps.length > 50 || steps.some((step) => !step)) throw new Error("Plan must contain 1-50 non-empty steps");
            plan = { title, steps: steps.map((step, index) => ({ id: index + 1, title: step, status: "pending" })) };
            return { content: [{ type: "text" as const, text: `Plan created: ${title} (${steps.length} steps)` }], details: plan };
          });
        },
      }),
    );
    const advance = context.piTools.register(
      defineTool({
        name: "plan_advance",
        label: "Advance plan",
        description: "Update one plan step to pending, in-progress, done, or skipped.",
        promptSnippet: "update the current plan step status",
        parameters: Type.Object({
          step: Type.Number(),
          status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("skipped")]),
        }),
        execute(_toolCallId, params): Promise<AgentToolResult<Plan>> {
          return Promise.resolve().then(() => {
            const current = requirePlan(plan);
            const index = Math.trunc(params.step) - 1;
            if (index < 0 || index >= current.steps.length) throw new Error(`Unknown plan step: ${params.step}`);
            current.steps[index] = { ...current.steps[index]!, status: params.status };
            return { content: [{ type: "text" as const, text: `Step ${params.step} is now ${params.status}` }], details: current };
          });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "plan-execute-panel",
      pluginId: "@pi-harness/core/plugins/plan-execute",
      title: "Plan Execute",
      description: "把复杂任务拆成可追踪步骤，并实时推进执行状态。",
      icon: "☷",
      read: () => {
        const steps = plan?.steps ?? [];
        return { title: plan?.title ?? null, completed: steps.filter((step) => step.status === "done").length, total: steps.length, steps };
      },
    });
    context.effect(() => () => {
      create();
      advance();
      disposePanel();
    });
  },
};
