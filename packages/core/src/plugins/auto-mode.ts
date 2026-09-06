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
const shellWrappers = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "env",
  "sudo",
  "su",
  "nice",
  "nohup",
  "time",
  "timeout",
  "stdbuf",
  "xargs",
]);
const safeCommands = new Set([
  "basename",
  "cat",
  "cmp",
  "diff",
  "dirname",
  "echo",
  "file",
  "grep",
  "head",
  "id",
  "ls",
  "printf",
  "pwd",
  "stat",
  "tail",
  "uname",
  "wc",
  "which",
  "whoami",
]);
const safeGitSubcommands = new Set(["blame", "cat-file", "describe", "diff", "grep", "log", "ls-files", "ls-tree", "rev-parse", "show", "status"]);
type AutoModeResult = { command: string[]; allowed: boolean; confirmed: boolean; exitCode: number | null; stdout: string; stderr: string; durationMs: number };

export interface AutoModePluginConfig {
  mode?: "safe" | "confirm";
  timeoutMs?: number;
}
export const Config: z<AutoModePluginConfig> = z.object({
  mode: z.union(["safe", "confirm"]).default("safe"),
  timeoutMs: z.number().default(defaultTimeoutMs),
});

function commandName(value: string): string {
  return value
    .split(/[\\/]/u)
    .at(-1)!
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/u, "");
}

function validateCommand(command: unknown): asserts command is string[] {
  if (!Array.isArray(command)) throw new Error("Auto mode command must be an array");
  const parts: unknown[] = command;
  if (parts.length === 0 || parts.length > maxArgs) throw new Error(`Auto mode command must contain between 1 and ${maxArgs} arguments`);
  if (!parts.every((part): part is string => typeof part === "string")) throw new Error("Auto mode command arguments must be strings");
  if (parts.some((part) => part.length === 0 || Buffer.byteLength(part, "utf8") > maxArgBytes))
    throw new Error("Auto mode command contains an invalid argument");
  if (shellWrappers.has(commandName(parts[0] ?? ""))) throw new Error("Auto mode rejects shell wrappers; pass an executable argv directly");
}

function isRisky(command: string[]): boolean {
  if (/[\\/]/u.test(command[0] ?? "")) return true;
  const executable = commandName(command[0] ?? "");
  if (safeCommands.has(executable)) return false;
  if (executable !== "git") return true;
  const subcommand = command[1]?.toLowerCase();
  return subcommand !== "--version" && subcommand !== "version" && !safeGitSubcommands.has(subcommand ?? "");
}

export default {
  name: "pi-auto-mode",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: AutoModePluginConfig) {
    const mode = config.mode === "confirm" ? "confirm" : "safe";
    const configuredTimeoutMs = config.timeoutMs ?? defaultTimeoutMs;
    const timeoutMs = Number.isFinite(configuredTimeoutMs) ? Math.max(1_000, Math.min(120_000, Math.trunc(configuredTimeoutMs))) : defaultTimeoutMs;
    const lifecycle = new AbortController();
    let blocked = 0;
    let last: AutoModeResult | undefined;
    const execute = async (command: string[], confirm: boolean, signal?: AbortSignal): Promise<AutoModeResult> => {
      signal?.throwIfAborted();
      try {
        validateCommand(command);
      } catch (error) {
        blocked += 1;
        throw error;
      }
      const argv = [...command];
      const risky = isRisky(argv);
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
        const result = await execFileAsync(argv[0]!, argv.slice(1), {
          cwd: context.piHarnessLaunch.cwd,
          timeout: timeoutMs,
          maxBuffer: maxOutputBytes,
          signal,
        });
        last = {
          command: argv,
          allowed: true,
          confirmed: confirm,
          exitCode: 0,
          stdout: result.stdout.slice(-maxOutputBytes),
          stderr: result.stderr.slice(-maxOutputBytes),
          durationMs: Date.now() - started,
        };
      } catch (error) {
        signal?.throwIfAborted();
        const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
        last = {
          command: argv,
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
        parameters: Type.Object(
          {
            command: Type.Array(Type.String({ minLength: 1, maxLength: maxArgBytes }), { minItems: 1, maxItems: maxArgs }),
            confirm: Type.Optional(Type.Boolean({ description: "Confirm a risky or confirmation-mode command" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<AutoModeResult>> {
          const executionSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          const result = await execute(params.command, params.confirm === true, executionSignal);
          return {
            content: [{ type: "text", text: `${result.command.join(" ")} exited with ${result.exitCode ?? "unknown"}.\n${result.stdout}${result.stderr}` }],
            details: structuredClone(result),
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
      read: () => ({ mode, timeoutMs, blocked, last: last === undefined ? null : structuredClone(last) }),
    });
    context.effect(() => () => {
      lifecycle.abort(new Error("Auto mode plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
