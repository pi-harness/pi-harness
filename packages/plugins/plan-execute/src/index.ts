import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type SessionManager } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

type PlanStatus = "pending" | "in_progress" | "done" | "skipped";
type PlanStep = { id: number; title: string; status: PlanStatus; dependsOn?: number[] };
type Plan = { title: string; steps: PlanStep[] };
const maxTextLength = 500;
const customType = "pi-harness/plan-execute";
const failedManagers = new WeakMap<SessionManager, object | null>();
const writeFailureMessage = "Plan write failed; reopen the session from disk before using Plan Execute again";

export const Config = z.object({});

function requirePlan(plan: Plan | undefined): Plan {
  if (!plan) throw new Error("No plan exists; create one with plan_create first");
  return plan;
}

function applyDependencies(steps: PlanStep[], dependencies: { step: number; dependsOn: number[] }[]): void {
  if (!Array.isArray(dependencies) || dependencies.length > 50) throw new Error("Plan dependencies must contain at most 50 entries");
  const seen = new Set<number>();
  for (const dependency of dependencies) {
    if (!Number.isInteger(dependency.step) || dependency.step < 1 || dependency.step > steps.length || seen.has(dependency.step))
      throw new Error("Invalid or duplicate dependency step");
    seen.add(dependency.step);
    if (
      !Array.isArray(dependency.dependsOn) ||
      dependency.dependsOn.length > 50 ||
      dependency.dependsOn.some((id) => !Number.isInteger(id) || id < 1 || id > steps.length || id === dependency.step)
    )
      throw new Error("Invalid plan dependency");
    steps[dependency.step - 1]!.dependsOn = [...new Set(dependency.dependsOn)];
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (id: number): void => {
    if (visiting.has(id)) throw new Error("Plan dependencies must not contain cycles");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of steps[id - 1]!.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
}

function validateProgress(steps: PlanStep[]): void {
  for (const step of steps) {
    if (step.status !== "in_progress" && step.status !== "done") continue;
    if (step.dependsOn?.some((id) => !["done", "skipped"].includes(steps[id - 1]!.status)))
      throw new Error(`Step ${step.id} requires completed or skipped dependencies`);
  }
}

function savedRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved plan record");
  return value as Record<string, unknown>;
}

function savedText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxTextLength) throw new Error("Invalid saved plan text");
  return value;
}

function readPlan(manager: SessionManager): Plan | undefined {
  if (failedManagers.has(manager)) {
    if (failedManagers.get(manager) === manager.getHeader()) throw new Error(writeFailureMessage);
    failedManagers.delete(manager);
  }
  const entry = manager
    .getBranch()
    .reverse()
    .find((item) => item.type === "custom" && item.customType === customType);
  if (!entry || entry.type !== "custom") return undefined;
  const value = savedRecord(entry.data);
  const title = savedText(value.title);
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 50) throw new Error("Invalid saved plan steps");
  const dependencies: { step: number; dependsOn: number[] }[] = [];
  const steps = Array.from(value.steps, (raw, index): PlanStep => {
    const item = savedRecord(raw);
    if (item.id !== index + 1) throw new Error("Invalid saved plan step ID");
    if (!["pending", "in_progress", "done", "skipped"].includes(item.status as string)) throw new Error("Invalid saved plan status");
    if (item.dependsOn !== undefined) dependencies.push({ step: index + 1, dependsOn: item.dependsOn as number[] });
    return { id: index + 1, title: savedText(item.title), status: item.status as PlanStatus };
  });
  applyDependencies(steps, dependencies);
  validateProgress(steps);
  return { title, steps };
}

function persistPlan(manager: SessionManager, plan: Plan): void {
  try {
    manager.appendCustomEntry(customType, structuredClone(plan));
  } catch (error) {
    failedManagers.set(manager, manager.getHeader());
    throw new Error(writeFailureMessage, { cause: error });
  }
}

export default {
  name: "pi-plan-execute",
  inject: ["piSession", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: unknown) {
    assertKnownConfigKeys("plan-execute", config, []);
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort(new Error("Plan Execute plugin disposed")));
    const currentManager = () => context.get("piRuntime")?.session.sessionManager ?? context.piSession.manager;
    const capture = (signal?: AbortSignal) => {
      lifecycle.signal.throwIfAborted();
      signal?.throwIfAborted();
      const manager = currentManager();
      const header = manager.getHeader();
      const leaf = manager.getLeafId();
      return {
        manager,
        check(this: void) {
          lifecycle.signal.throwIfAborted();
          signal?.throwIfAborted();
          if (currentManager() !== manager || manager.getHeader() !== header) throw new Error("Plan session changed before execution");
          if (manager.getLeafId() !== leaf) throw new Error("Plan branch changed before execution");
        },
      };
    };
    const create = context.piTools.register(
      defineTool({
        name: "plan_create",
        label: "Create plan",
        description: "Create or replace a structured execution plan with ordered steps.",
        promptSnippet: "create an execution plan before making a multi-step change",
        parameters: Type.Object(
          {
            title: Type.String({ minLength: 1, maxLength: maxTextLength }),
            steps: Type.Array(Type.String({ minLength: 1, maxLength: maxTextLength }), { minItems: 1, maxItems: 50 }),
            dependencies: Type.Optional(
              Type.Array(
                Type.Object(
                  { step: Type.Integer({ minimum: 1, maximum: 50 }), dependsOn: Type.Array(Type.Integer({ minimum: 1, maximum: 50 }), { maxItems: 50 }) },
                  { additionalProperties: false },
                ),
                { maxItems: 50 },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<Plan>> {
          const { manager, check } = capture(signal);
          return Promise.resolve().then(() => {
            check();
            readPlan(manager);
            const title = params.title.trim();
            const steps = params.steps.map((step) => step.trim());
            if (!title || title.length > maxTextLength) throw new Error(`Plan title must contain 1-${maxTextLength} characters`);
            if (steps.length === 0 || steps.length > 50 || steps.some((step) => !step || step.length > maxTextLength))
              throw new Error(`Plan must contain 1-50 non-empty steps of at most ${maxTextLength} characters`);
            const next: Plan = { title, steps: steps.map((step, index) => ({ id: index + 1, title: step, status: "pending" })) };
            applyDependencies(next.steps, params.dependencies ?? []);
            persistPlan(manager, next);
            return { content: [{ type: "text" as const, text: JSON.stringify(next) }], details: structuredClone(next) };
          });
        },
      }),
    );
    context.effect(() => create);
    const advance = context.piTools.register(
      defineTool({
        name: "plan_advance",
        label: "Advance plan",
        description: "Update one plan step to pending, in-progress, done, or skipped.",
        promptSnippet: "update the current plan step status",
        parameters: Type.Object(
          {
            step: Type.Integer({ minimum: 1, maximum: 50 }),
            status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("skipped")]),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<Plan>> {
          const { manager, check } = capture(signal);
          return Promise.resolve().then(() => {
            check();
            const current = requirePlan(readPlan(manager));
            if (!Number.isInteger(params.step)) throw new Error(`Invalid plan step: ${params.step}`);
            if (!["pending", "in_progress", "done", "skipped"].includes(params.status)) throw new Error("Invalid plan status");
            const index = params.step - 1;
            if (index < 0 || index >= current.steps.length) throw new Error(`Unknown plan step: ${params.step}`);
            const nextSteps = current.steps.map((step, position) => (position === index ? { ...step, status: params.status } : step));
            validateProgress(nextSteps);
            current.steps = nextSteps;
            persistPlan(manager, current);
            return { content: [{ type: "text" as const, text: JSON.stringify(current) }], details: structuredClone(current) };
          });
        },
      }),
    );
    context.effect(() => advance);
    const get = context.piTools.register(
      defineTool({
        name: "plan_get",
        label: "Get plan",
        description: "Read the current execution plan, including step IDs, titles, statuses and dependencies, without changing it. Fails if no plan exists.",
        promptSnippet: "retrieve the current plan before resuming work or reporting progress",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, _params, signal): Promise<AgentToolResult<Plan>> {
          const { manager, check } = capture(signal);
          return Promise.resolve().then(() => {
            check();
            const current = requirePlan(readPlan(manager));
            return { content: [{ type: "text" as const, text: JSON.stringify(current) }], details: structuredClone(current) };
          });
        },
      }),
    );
    context.effect(() => get);
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "plan-execute-panel",
        pluginId: "@pi-harness/plugin-plan-execute",
        title: "Plan Execute",
        description: "把复杂任务拆成可追踪步骤，并实时推进执行状态。",
        icon: "☷",
        read: () => {
          const plan = readPlan(currentManager());
          const steps = plan?.steps ?? [];
          return {
            title: plan?.title ?? null,
            completed: steps.filter((step) => step.status === "done").length,
            total: steps.length,
            steps: structuredClone(steps),
          };
        },
      });
    } catch (error) {
      create();
      advance();
      get();
      throw error;
    }
    context.effect(() => () => {
      create();
      advance();
      get();
      disposePanel();
    });
  },
};
