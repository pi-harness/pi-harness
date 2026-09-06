import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "../config.js";

type GateStatus = "pass" | "warning" | "fail";
const maxScriptLength = 128;
type GateReport = {
  status: GateStatus;
  script: string;
  tests: { exitCode: number; durationMs: number };
  review: { status: string; findings: number };
  checkedAt: string;
};

function detailsOf(result: unknown): Record<string, unknown> {
  if (result === null || typeof result !== "object") return {};
  const details = (result as { details?: unknown }).details;
  return details !== null && typeof details === "object" ? (details as Record<string, unknown>) : {};
}

function scriptName(value: unknown): string {
  if (value === undefined) return "test";
  if (typeof value !== "string") throw new Error("Verification script must be a string");
  if (value.length > maxScriptLength) throw new Error(`Verification script must contain between 1 and ${maxScriptLength} characters`);
  return value.trim() || "test";
}

function requiredTool(context: Context, name: string): ToolDefinition {
  const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Change Verifier requires the ${name} tool; enable its provider plugin before pi-runtime`);
  return tool;
}

export default {
  name: "pi-change-verifier",
  inject: ["piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    let runs = 0;
    let latest: GateReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "verify_change_gate",
        label: "Verify change gate",
        description: "Combine the existing project test and Git review tools into one deterministic release gate.",
        promptSnippet: "run the project test and review gate before declaring the change complete",
        parameters: Type.Object(
          {
            script: Type.Optional(Type.String({ description: "Approved npm script handled by run_project_tests", minLength: 1, maxLength: maxScriptLength })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(toolCallId, params, signal, _onUpdate, toolContext): Promise<AgentToolResult<GateReport>> {
          const actionSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          if (actionSignal.aborted)
            throw actionSignal.reason instanceof Error ? actionSignal.reason : new Error("Change verification was cancelled", { cause: actionSignal.reason });
          const script = scriptName(params?.script);
          const reviewTool = requiredTool(context, "review_changes");
          const testTool = requiredTool(context, "run_project_tests");
          const reviewResult = await reviewTool.execute(`${toolCallId}:review`, {}, actionSignal, undefined, toolContext);
          const testResult = await testTool.execute(`${toolCallId}:tests`, { script }, actionSignal, undefined, toolContext);
          const review = detailsOf(reviewResult);
          const tests = detailsOf(testResult);
          const exitCode =
            typeof tests.exitCode === "number" && Number.isInteger(tests.exitCode) && tests.exitCode >= 0 && tests.exitCode <= 255 ? tests.exitCode : 1;
          const durationMs =
            typeof tests.durationMs === "number" && Number.isFinite(tests.durationMs) && tests.durationMs >= 0 ? Math.trunc(tests.durationMs) : 0;
          const reviewStatus = review.status === "pass" || review.status === "warning" || review.status === "error" ? review.status : "error";
          const findings = Array.isArray(review.findings) ? review.findings.length : 0;
          const status: GateStatus = exitCode !== 0 || reviewStatus === "error" ? "fail" : reviewStatus === "warning" ? "warning" : "pass";
          latest = {
            status,
            script,
            tests: { exitCode, durationMs },
            review: { status: reviewStatus, findings },
            checkedAt: new Date().toISOString(),
          };
          runs += 1;
          return {
            content: [{ type: "text", text: `${status}: tests exit ${exitCode}; review ${reviewStatus} with ${findings} finding(s).` }],
            details: structuredClone(latest),
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "change-verifier-panel",
      pluginId: "@pi-harness/core/plugins/change-verifier",
      title: "Change Verifier",
      description: "复用真实测试和代码审查工具，形成统一发布门禁。",
      icon: "✓",
      read: () => ({ runs, latest: latest === undefined ? null : structuredClone(latest) }),
    });
    context.effect(() => () => {
      lifecycle.abort(new Error("Change Verifier plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
