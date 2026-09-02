import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const maxArgs = 32;
const maxArgBytes = 4096;
const maxOutputBytes = 128 * 1024;
const defaultTimeoutMs = 30_000;
const shellWrappers = new Set(["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"]);
const riskyCommands = new Set(["rm", "rmdir", "del", "sudo", "su", "chmod", "chown", "kill", "pkill", "dd", "mkfs"]);
const riskyWords = new Set(["reset", "clean", "push", "publish", "curl", "wget", "ssh", "scp"]);
type AutoModeResult = { command: string[]; allowed: boolean; confirmed: boolean; exitCode: number | null; stdout: string; stderr: string; durationMs: number };

export interface AutoModePluginConfig {
  mode?: "safe" | "confirm";
  timeoutMs?: number;
}
export const Config: z<AutoModePluginConfig> = z.object({
  mode: z.union(["safe", "confirm"]).default("safe"),
  timeoutMs: z.number().default(defaultTimeoutMs),
});

function validateCommand(command: string[]): void {
  if (command.length === 0 || command.length > maxArgs) throw new Error(`Auto mode command must contain between 1 and ${maxArgs} arguments`);
  if (command.some((part) => part.length === 0 || Buffer.byteLength(part, "utf8") > maxArgBytes))
    throw new Error("Auto mode command contains an invalid argument");
  if (shellWrappers.has((command[0] ?? "").split("/").at(-1)!.toLowerCase()))
    throw new Error("Auto mode rejects shell wrappers; pass an executable argv directly");
}

function isRisky(command: string[]): boolean {
  const executable = (command[0] ?? "").split("/").at(-1)!.toLowerCase();
  return riskyCommands.has(executable) || command.slice(1).some((part) => riskyWords.has(part.toLowerCase()));
}

export default {
  name: "pi-auto-mode",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: AutoModePluginConfig) {
    const mode = config.mode === "confirm" ? "confirm" : "safe";
    const timeoutMs = Math.max(1_000, Math.min(120_000, Math.trunc(config.timeoutMs ?? defaultTimeoutMs)));
    let blocked = 0;
    let last: AutoModeResult | undefined;
    const execute = async (command: string[], confirm: boolean): Promise<AutoModeResult> => {
      try {
        validateCommand(command);
      } catch (error) {
        blocked += 1;
        throw error;
      }
      const risky = isRisky(command);
      if (risky && !confirm) {
        blocked += 1;
        throw new Error("Auto mode blocked a risky command; retry with confirm=true");
      }
      if (mode === "confirm" && !confirm) {
        blocked += 1;
        throw new Error("Auto mode is configured for confirmation; retry with confirm=true");
      }
      const started = Date.now();
      try {
        const result = await execFileAsync(command[0]!, command.slice(1), { cwd: context.piHarnessLaunch.cwd, timeout: timeoutMs, maxBuffer: maxOutputBytes });
        last = {
          command: [...command],
          allowed: true,
          confirmed: confirm,
          exitCode: 0,
          stdout: result.stdout.slice(-maxOutputBytes),
          stderr: result.stderr.slice(-maxOutputBytes),
          durationMs: Date.now() - started,
        };
      } catch (error) {
        const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
        last = {
          command: [...command],
          allowed: true,
          confirmed: confirm,
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: (failure.stdout ?? "").slice(-maxOutputBytes),
          stderr: (failure.stderr ?? failure.message ?? "").slice(-maxOutputBytes),
          durationMs: Date.now() - started,
        };
      }
      return last;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "auto_mode_exec",
        label: "Auto mode exec",
        description: "Execute an argv command under the configured safe/confirmation policy without a shell.",
        promptSnippet: "run a command through the safe auto-mode policy",
        parameters: Type.Object({
          command: Type.Array(Type.String()),
          confirm: Type.Optional(Type.Boolean({ description: "Confirm a risky or confirmation-mode command" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<AutoModeResult>> {
          const result = await execute(params.command, params.confirm === true);
          return {
            content: [{ type: "text", text: `${result.command.join(" ")} exited with ${result.exitCode ?? "unknown"}.\n${result.stdout}${result.stderr}` }],
            details: result,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "auto-mode-panel",
      pluginId: "@pi-harness/core/plugins/auto-mode",
      title: "Auto Mode",
      description: "按安全策略执行 argv 命令，风险操作需要确认。",
      icon: "◈",
      read: () => ({ mode, timeoutMs, blocked, last: last ?? null }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
