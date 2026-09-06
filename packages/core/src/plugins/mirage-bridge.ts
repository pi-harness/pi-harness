import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const defaultExecutable = "mirage";
const defaultTimeoutMs = 60_000;
const maxCommandLength = 4_000;
const maxOutputBytes = 128 * 1024;

export interface MirageBridgeConfig {
  executable?: string;
  workspaceId?: string;
  timeoutMs?: number;
}

export type MirageRun = {
  workspaceId: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
};

type MirageBridgeState = {
  executable: string;
  workspaceId: string | null;
  available: boolean | null;
  version: string | null;
  lastError: string | null;
  lastRun: MirageRun | null;
};

export const Config: z<MirageBridgeConfig> = z.object({
  executable: z.string().default(defaultExecutable),
  workspaceId: z.string().default(""),
  timeoutMs: z.number().default(defaultTimeoutMs),
});

function normalizeExecutable(input: string | undefined): string {
  const executable = (input ?? defaultExecutable).trim();
  if (executable.length < 1 || executable.length > 512 || executable.includes("\0")) throw new Error("Mirage executable must contain 1-512 characters");
  return executable;
}

function normalizeWorkspaceId(input: string | undefined): string | null {
  const workspaceId = input?.trim() ?? "";
  if (workspaceId === "") return null;
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(workspaceId))
    throw new Error("Mirage workspaceId must contain 1-128 letters, numbers, dots, underscores, or hyphens");
  return workspaceId;
}

function normalizeCommand(input: string): string {
  const command = input.trim();
  if (command.length < 1 || command.length > maxCommandLength) throw new Error(`Mirage command must contain 1-${maxCommandLength} characters`);
  return command;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default {
  name: "pi-mirage-bridge",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: MirageBridgeConfig) {
    const executable = normalizeExecutable(config.executable);
    const workspaceId = normalizeWorkspaceId(config.workspaceId);
    const timeoutMs = Math.max(1_000, Math.min(120_000, Math.trunc(config.timeoutMs ?? defaultTimeoutMs)));
    let state: MirageBridgeState = { executable, workspaceId, available: null, version: null, lastError: null, lastRun: null };

    const doctor = async (): Promise<MirageBridgeState> => {
      try {
        const result = await execFileAsync(executable, ["--version"], {
          cwd: context.piHarnessLaunch.cwd,
          timeout: Math.min(timeoutMs, 10_000),
          maxBuffer: maxOutputBytes,
        });
        const version = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/u)[0]?.slice(0, 256) || "Mirage CLI detected";
        state = { ...state, available: true, version, lastError: null };
      } catch (error) {
        state = { ...state, available: false, version: null, lastError: errorMessage(error).slice(0, 1_000) };
      }
      return state;
    };

    const run = async (commandInput: string): Promise<MirageRun> => {
      if (workspaceId === null) throw new Error("Mirage workspaceId is not configured");
      const command = normalizeCommand(commandInput);
      const startedAt = Date.now();
      try {
        const result = await execFileAsync(executable, ["execute", "--workspace_id", workspaceId, "--command", command], {
          cwd: context.piHarnessLaunch.cwd,
          timeout: timeoutMs,
          maxBuffer: maxOutputBytes,
        });
        state = {
          ...state,
          available: true,
          lastError: null,
          lastRun: { workspaceId, command, exitCode: 0, durationMs: Date.now() - startedAt, output: `${result.stdout}${result.stderr}`.slice(-maxOutputBytes) },
        };
      } catch (error) {
        const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
        const unavailable = failure.code === "ENOENT";
        const output = `${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? ""}`.slice(-maxOutputBytes);
        state = {
          ...state,
          available: unavailable ? false : state.available,
          lastError: unavailable ? output : null,
          lastRun: {
            workspaceId,
            command,
            exitCode: typeof failure.code === "number" ? failure.code : null,
            durationMs: Date.now() - startedAt,
            output,
          },
        };
      }
      return state.lastRun!;
    };

    const unregisterDoctor = context.piTools.register(
      defineTool({
        name: "mirage_doctor",
        label: "Check Mirage CLI",
        description: "Check whether the official Mirage virtual-terminal CLI is available and report its configured workspace.",
        promptSnippet: "check the official Mirage virtual terminal integration",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(): Promise<AgentToolResult<MirageBridgeState>> {
          const details = await doctor();
          return {
            content: [
              {
                type: "text",
                text: details.available
                  ? `${details.version}; workspace ${details.workspaceId ?? "not configured"}`
                  : `Mirage unavailable: ${details.lastError}`,
              },
            ],
            details,
          };
        },
      }),
    );
    const unregisterExecute = context.piTools.register(
      defineTool({
        name: "mirage_execute",
        label: "Execute in Mirage",
        description: "Pass one command to the official Mirage virtual terminal in the configured virtual workspace.",
        promptSnippet: "run a command inside the configured Mirage virtual workspace",
        parameters: Type.Object(
          { command: Type.String({ description: "Command interpreted by Mirage, not the host shell" }) },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params): Promise<AgentToolResult<MirageRun>> {
          const details = await run(params.command);
          return { content: [{ type: "text", text: `Mirage exited with ${details.exitCode ?? "unknown"}.\n${details.output}` }], details };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "mirage-bridge-panel",
        pluginId: "@pi-harness/core/plugins/mirage-bridge",
        title: "Mirage Bridge",
        description: "连接官方 Mirage 虚拟终端，在配置的虚拟工作区中执行命令。",
        icon: "◇",
        read: () => ({ ...state, timeoutMs }),
      });
    } catch (error) {
      unregisterDoctor();
      unregisterExecute();
      throw error;
    }
    context.effect(() => () => {
      unregisterDoctor();
      unregisterExecute();
      disposePanel();
    });
  },
};
