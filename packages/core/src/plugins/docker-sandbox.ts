import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const shellCommands = new Set(["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"]);
type SandboxRun = { image: string; command: string[]; write: boolean; exitCode: number; output: string };

function validateImage(image: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/.test(image)) throw new Error("Invalid Docker image reference");
}

export default {
  name: "pi-docker-sandbox",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: SandboxRun | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "sandbox_exec",
        label: "Docker sandbox",
        description: "Run an argv command in a no-network Docker container with the workspace mounted read-only by default.",
        promptSnippet: "run a command in an isolated no-network Docker sandbox",
        parameters: Type.Object({
          command: Type.Array(Type.String(), { description: "Executable and arguments; shell wrappers are rejected" }),
          image: Type.Optional(Type.String({ description: "Local Docker image, default alpine:3.20" })),
          write: Type.Optional(Type.Boolean({ description: "Mount the workspace read-write" })),
          confirmWrite: Type.Optional(Type.Boolean({ description: "Must be true when write is enabled" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<SandboxRun>> {
          if (params.command.length === 0) throw new Error("Sandbox command cannot be empty");
          const executable = params.command[0];
          if (executable === undefined) throw new Error("Sandbox command cannot be empty");
          if (shellCommands.has(basename(executable).toLowerCase())) throw new Error("Shell wrappers are not allowed; pass an executable argv directly");
          const image = params.image?.trim() || "alpine:3.20";
          validateImage(image);
          const write = params.write === true;
          if (write && params.confirmWrite !== true) throw new Error("Writable sandbox requires confirmWrite=true");
          try {
            await execFileAsync("docker", ["image", "inspect", image], { timeout: 30_000, maxBuffer: 1_000_000 });
          } catch (error) {
            const failure = error as { code?: number | string; message?: string };
            if (failure.code === "ENOENT") throw new Error("Docker executable is not available on PATH");
            throw new Error(`Docker image is not available locally: ${image}`);
          }
          const args = [
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "256",
            "--mount",
            `type=bind,src=${context.piHarnessLaunch.cwd},dst=/workspace${write ? "" : ",readonly"}`,
            "--workdir",
            "/workspace",
            image,
            ...params.command,
          ];
          try {
            const result = await execFileAsync("docker", args, { cwd: context.piHarnessLaunch.cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
            latest = { image, command: [...params.command], write, exitCode: 0, output: `${result.stdout}${result.stderr}`.slice(-12_000) };
          } catch (error) {
            const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
            latest = {
              image,
              command: [...params.command],
              write,
              exitCode: typeof failure.code === "number" ? failure.code : 1,
              output: `${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? ""}`.slice(-12_000),
            };
          }
          return { content: [{ type: "text", text: `Docker sandbox exited with ${latest.exitCode}.\n${latest.output}` }], details: latest };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "docker-sandbox-panel",
      pluginId: "@pi-harness/core/plugins/docker-sandbox",
      title: "Docker Sandbox",
      description: "无网络、只读挂载、去除 Linux capabilities 的隔离执行环境。",
      icon: "⬡",
      read: () => ({ latest: latest ?? null, defaults: { network: "none", workspace: "read-only", image: "alpine:3.20" } }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
