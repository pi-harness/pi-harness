import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";

type GateStatus = "pass" | "warning" | "fail";
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

function requiredTool(context: Context, name: string): ToolDefinition {
  const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Change Verifier requires the ${name} tool; enable its provider plugin before pi-runtime`);
  return tool;
}

export default {
  name: "pi-change-verifier",
  inject: ["piPluginUi", "piTools"],
  apply(context: Context) {
    let runs = 0;
    let latest: GateReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "verify_change_gate",
        label: "Verify change gate",
        description: "Combine the existing project test and Git review tools into one deterministic release gate.",
        promptSnippet: "run the project test and review gate before declaring the change complete",
        parameters: Type.Object({ script: Type.Optional(Type.String({ description: "Approved npm script handled by run_project_tests" })) }),
        async execute(toolCallId, params, signal, _onUpdate, toolContext): Promise<AgentToolResult<GateReport>> {
          const script = params.script?.trim() || "test";
          const reviewTool = requiredTool(context, "review_changes");
          const testTool = requiredTool(context, "run_project_tests");
          const reviewResult = await reviewTool.execute(`${toolCallId}:review`, {}, signal, undefined, toolContext);
          const testResult = await testTool.execute(`${toolCallId}:tests`, { script }, signal, undefined, toolContext);
          const review = detailsOf(reviewResult);
          const tests = detailsOf(testResult);
          const exitCode = typeof tests.exitCode === "number" ? tests.exitCode : 1;
          const reviewStatus = typeof review.status === "string" ? review.status : "error";
          const findings = Array.isArray(review.findings) ? review.findings.length : 0;
          const status: GateStatus = exitCode !== 0 || reviewStatus === "error" ? "fail" : reviewStatus === "warning" ? "warning" : "pass";
          latest = {
            status,
            script,
            tests: { exitCode, durationMs: typeof tests.durationMs === "number" ? tests.durationMs : 0 },
            review: { status: reviewStatus, findings },
            checkedAt: new Date().toISOString(),
          };
          runs += 1;
          return {
            content: [{ type: "text", text: `${status}: tests exit ${exitCode}; review ${reviewStatus} with ${findings} finding(s).` }],
            details: latest,
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
      read: () => ({ runs, latest: latest ?? null }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
