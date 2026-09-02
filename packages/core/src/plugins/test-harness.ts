import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const allowedScripts = new Set(["test", "build", "format:check", "lint", "typecheck"]);
type TestRun = { script: string; command: string; exitCode: number; durationMs: number; output: string };

export default {
  name: "pi-test-harness",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: TestRun | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "run_project_tests",
        label: "Run project tests",
        description: "Run one approved npm script in the current workspace and return its real output.",
        promptSnippet: "run an approved project verification script",
        parameters: Type.Object({ script: Type.Optional(Type.String({ description: "One of test, build, format:check, lint, typecheck" })) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<TestRun>> {
          const script = params.script?.trim() || "test";
          if (!allowedScripts.has(script)) throw new Error(`Script is not allowed: ${script}`);
          const started = Date.now();
          try {
            const result = await execFileAsync("npm", ["run", script], { cwd: context.piHarnessLaunch.cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
            latest = {
              script,
              command: `npm run ${script}`,
              exitCode: 0,
              durationMs: Date.now() - started,
              output: `${result.stdout}${result.stderr}`.slice(-12_000),
            };
          } catch (error) {
            const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
            latest = {
              script,
              command: `npm run ${script}`,
              exitCode: typeof failure.code === "number" ? failure.code : 1,
              durationMs: Date.now() - started,
              output: `${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? ""}`.slice(-12_000),
            };
          }
          const result = latest;
          return {
            content: [{ type: "text", text: `${result.command} exited with ${result.exitCode}.\n${result.output}` }],
            details: result,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "test-harness-panel",
      pluginId: "@pi-harness/core/plugins/test-harness",
      title: "Test Harness",
      description: "执行受限 npm 验证脚本，并显示真实退出码、耗时和输出摘要。",
      icon: "✓",
      read: () => ({ allowedScripts: [...allowedScripts], latest: latest ?? null }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
