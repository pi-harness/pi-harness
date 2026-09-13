import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "@pi-harness/plugin-api";

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
  // Provider errors may retain diagnostic details shaped like a prior success.
  // Never use those fields as evidence that this verification passed.
  if ((result as { isError?: unknown }).isError === true) return {};
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
    let attemptStatus: "idle" | "running" | "completed" | "failed" | "cancelled" = "idle";
    let lastError: string | null = null;
    const readScope = () => {
      const session = context.get("piRuntime")?.session;
      return { session, manager: session?.sessionManager, id: session?.sessionId, cwd: session?.sessionManager.getCwd() };
    };
    let scope = readScope();
    const refreshScope = () => {
      const next = readScope();
      if (next.session !== scope.session || next.manager !== scope.manager || next.id !== scope.id || next.cwd !== scope.cwd) {
        scope = next;
        latest = undefined;
        runs = 0;
        attemptStatus = "idle";
        lastError = null;
      }
      return scope;
    };
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
          const checkCancelled = (): void => {
            if (actionSignal.aborted)
              throw actionSignal.reason instanceof Error ? actionSignal.reason : new Error("Change verification was cancelled", { cause: actionSignal.reason });
          };
          checkCancelled();
          const operationScope = refreshScope();
          const checkCurrent = () => {
            checkCancelled();
            if (refreshScope() !== operationScope) throw new Error("Session or workspace changed during change verification");
          };
          const script = scriptName(params?.script);
          latest = undefined;
          attemptStatus = "running";
          lastError = null;
          try {
            const reviewTool = requiredTool(context, "review_changes");
            const testTool = requiredTool(context, "run_project_tests");
            const reviewResult = await reviewTool.execute(`${toolCallId}:review`, {}, actionSignal, undefined, toolContext);
            checkCurrent();
            const testResult = await testTool.execute(`${toolCallId}:tests`, { script }, actionSignal, undefined, toolContext);
            checkCurrent();
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
            attemptStatus = "completed";
            return {
              content: [{ type: "text", text: `${status}: tests exit ${exitCode}; review ${reviewStatus} with ${findings} finding(s).` }],
              details: structuredClone(latest),
            };
          } catch (error) {
            if (!lifecycle.signal.aborted && refreshScope() === operationScope) {
              attemptStatus = actionSignal.aborted ? "cancelled" : "failed";
              let message = actionSignal.aborted ? "Change verification was cancelled" : "Change verification failed";
              if (error instanceof Error) {
                const descriptor = Object.getOwnPropertyDescriptor(error, "message");
                if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") message = descriptor.value;
              }
              if (operationScope.cwd) message = message.replaceAll(operationScope.cwd, "[workspace]");
              lastError =
                message
                  .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
                  .trim()
                  .slice(0, 1000) || "Change verification failed";
            }
            throw error;
          }
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "change-verifier-panel",
      pluginId: "@pi-harness/plugin-change-verifier",
      title: "Change Verifier",
      description: "复用真实测试和代码审查工具，形成统一发布门禁。",
      icon: "✓",
      read: () => {
        refreshScope();
        return { runs, latest: latest === undefined ? null : structuredClone(latest), status: attemptStatus, lastError };
      },
    });
    context.effect(() => () => {
      lifecycle.abort(new Error("Change Verifier plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
