import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { runBoundedCommand } from "@pi-harness/plugin-api";

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

function boundedOutput(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxOutputBytes) return value;
  const notice = "… Mirage output truncated; showing the final portion.\n";
  let start = bytes.length - maxOutputBytes + Buffer.byteLength(notice);
  // A UTF-8 tail must start at a code point, never a continuation byte.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return notice + bytes.subarray(start).toString("utf8");
}

export default {
  name: "pi-mirage-bridge",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: MirageBridgeConfig) {
    const executable = normalizeExecutable(config.executable);
    const workspaceId = normalizeWorkspaceId(config.workspaceId);
    const timeoutMs = Math.max(1_000, Math.min(120_000, Math.trunc(Number.isFinite(config.timeoutMs) ? config.timeoutMs! : defaultTimeoutMs)));
    const lifecycle = new AbortController();
    let state: MirageBridgeState = { executable, workspaceId, available: null, version: null, lastError: null, lastRun: null };
    const readScope = () => {
      const session = context.get("piRuntime")?.session;
      return { session, manager: session?.sessionManager, id: session?.sessionId, cwd: session?.sessionManager.getCwd() ?? context.piHarnessLaunch.cwd };
    };
    let scope = readScope();
    const refreshScope = () => {
      const next = readScope();
      if (next.session !== scope.session || next.manager !== scope.manager || next.id !== scope.id || next.cwd !== scope.cwd) {
        scope = next;
        state = { executable, workspaceId, available: null, version: null, lastError: null, lastRun: null };
      }
      return scope;
    };
    const operation = (callerSignal: AbortSignal | undefined) => {
      const signal = callerSignal === undefined ? lifecycle.signal : AbortSignal.any([callerSignal, lifecycle.signal]);
      signal.throwIfAborted();
      const current = refreshScope();
      return {
        signal,
        cwd: current.cwd,
        assertCurrent: () => {
          signal.throwIfAborted();
          if (refreshScope() !== current) throw new Error("Mirage workspace changed during execution");
        },
      };
    };

    const doctor = async ({ signal, cwd, assertCurrent }: ReturnType<typeof operation>): Promise<MirageBridgeState> => {
      assertCurrent();
      try {
        const result = await runBoundedCommand([executable, "--version"], cwd, Math.min(timeoutMs, 10_000), maxOutputBytes, signal);
        assertCurrent();
        const version = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/u)[0]?.slice(0, 256) || "Mirage CLI detected";
        state = { ...state, available: true, version, lastError: null };
      } catch (error) {
        // A cancelled probe says nothing about availability, so surface the abort instead of recording the CLI as missing.
        assertCurrent();
        const diagnostic = (error as { killed?: boolean }).killed === true ? `Mirage CLI check timed out after ${Math.min(timeoutMs, 10_000)} ms` : errorMessage(error);
        state = { ...state, available: false, version: null, lastError: diagnostic.slice(0, 1_000) };
      }
      return structuredClone(state);
    };

    const run = async (commandInput: string, { signal, cwd, assertCurrent }: ReturnType<typeof operation>): Promise<MirageRun> => {
      if (workspaceId === null) throw new Error("Mirage workspaceId is not configured");
      const command = normalizeCommand(commandInput);
      assertCurrent();
      const startedAt = Date.now();
      try {
        // The bounded runner gives the non-interactive CLI immediate stdin EOF.
        const result = await runBoundedCommand([executable, "execute", "--workspace_id", workspaceId, "--command", command], cwd, timeoutMs, maxOutputBytes, signal);
        assertCurrent();
        state = {
          ...state,
          available: true,
          lastError: null,
          lastRun: { workspaceId, command, exitCode: 0, durationMs: Date.now() - startedAt, output: boundedOutput(`${result.stdout}${result.stderr}`) },
        };
      } catch (error) {
        // The signal kills the child; a cancelled run must not be recorded as a Mirage result, especially after the plugin has been disposed.
        assertCurrent();
        const failure = error as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
        const unavailable = failure.code === "ENOENT";
        const diagnostic =
          failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? `Mirage command output exceeded ${maxOutputBytes} bytes; output is incomplete`
            : failure.killed === true
              ? `Mirage command timed out after ${timeoutMs} ms`
              : errorMessage(error);
        const output = boundedOutput(`${failure.stdout ?? ""}${failure.stderr ?? ""}\n${diagnostic}`);
        state = {
          ...state,
          available: unavailable ? false : state.available,
          lastError: diagnostic.slice(0, 1_000),
          lastRun: {
            workspaceId,
            command,
            exitCode: typeof failure.code === "number" && failure.code !== 0 && failure.killed !== true ? failure.code : null,
            durationMs: Date.now() - startedAt,
            output,
          },
        };
      }
      return structuredClone(state.lastRun!);
    };

    const unregisterDoctor = context.piTools.register(
      defineTool({
        name: "mirage_doctor",
        label: "Check Mirage CLI",
        description: "Check whether the official Mirage virtual-terminal CLI is available and report its configured workspace.",
        promptSnippet: "check the official Mirage virtual terminal integration",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, _params, signal): Promise<AgentToolResult<MirageBridgeState>> {
          const current = operation(signal);
          const details = await doctor(current);
          current.assertCurrent();
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
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<MirageRun>> {
          const current = operation(signal);
          const details = await run(params.command, current);
          current.assertCurrent();
          return { content: [{ type: "text", text: `Mirage exited with ${details.exitCode ?? "unknown"}.\n${details.output}` }], details };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "mirage-bridge-panel",
        pluginId: "@pi-harness/plugin-mirage-bridge",
        title: "Mirage Bridge",
        description: "连接官方 Mirage 虚拟终端，在配置的虚拟工作区中执行命令。",
        icon: "◇",
        read: () => {
          refreshScope();
          return structuredClone({ ...state, timeoutMs });
        },
      });
    } catch (error) {
      unregisterDoctor();
      unregisterExecute();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Mirage bridge plugin disposed"));
      unregisterDoctor();
      unregisterExecute();
      disposePanel();
    });
  },
};
