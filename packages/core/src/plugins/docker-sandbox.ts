import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { stripVTControlCharacters } from "node:util";
import { EmptyConfig } from "@pi-harness/plugin-api";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const defaultImage = "alpine:3.20";
const maxArgs = 128;
const maxArgLength = 16_384;
const maxCommandLength = 128 * 1024;
const maxImageLength = 512;
const maxOutputBytes = 12_000;
const inspectTimeoutMs = 30_000;
const runTimeoutMs = 120_000;
const cleanupTimeoutMs = 10_000;
const memoryLimit = "512m";
const cpuLimit = "1";
const processLimit = 256;
const shellCommands = new Set(["ash", "bash", "cmd", "csh", "dash", "fish", "ksh", "powershell", "pwsh", "sh", "tcsh", "zsh"]);
const unsafeUnicode = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

type SandboxStatus = "completed" | "failed" | "timed_out";
type SandboxRun = { image: string; command: string[]; write: boolean; exitCode: number; status: SandboxStatus; output: string };
type SandboxParameters = { command: string[]; image?: string; write: boolean; confirmWrite: boolean };

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Docker sandbox operation was cancelled", { cause: signal.reason });
}

function validateImage(image: string): void {
  if (image.length > maxImageLength) throw new Error(`Docker image reference must contain at most ${maxImageLength} characters`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/.test(image)) throw new Error("Invalid Docker image reference");
}

function executableName(executable: string): string {
  const portable = executable.replaceAll("\\", "/");
  const name = basename(portable).toLowerCase();
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

function validateParameters(value: unknown): SandboxParameters {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Docker sandbox parameters must be an object with a command array");
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Docker sandbox parameters must be a plain object");
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof Error && error.message === "Docker sandbox parameters must be a plain object") throw error;
    throw new Error("Docker sandbox parameters must be an accessible plain object", { cause: error });
  }
  const allowed = new Set(["command", "image", "write", "confirmWrite"]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key)))
    throw new Error("Docker sandbox parameters contain an unknown property");
  for (const descriptor of Object.values(descriptors)) {
    if ("get" in descriptor || "set" in descriptor) throw new Error("Docker sandbox parameters must use data properties");
  }

  const rawCommand: unknown = descriptors.command?.value;
  if (!Array.isArray(rawCommand)) throw new Error("Docker sandbox command must be an array");
  let commandDescriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(rawCommand) !== Array.prototype) throw new Error("Sandbox command must be a plain array");
    commandDescriptors = Object.getOwnPropertyDescriptors(rawCommand) as unknown as PropertyDescriptorMap;
  } catch (error) {
    if (error instanceof Error && error.message === "Sandbox command must be a plain array") throw error;
    throw new Error("Sandbox command must be an accessible plain array", { cause: error });
  }
  if (
    Reflect.ownKeys(commandDescriptors).some(
      (key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key) || Number(key) >= rawCommand.length || String(Number(key)) !== key),
    )
  )
    throw new Error("Sandbox command contains an unknown property");
  const lengthDescriptor = commandDescriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || lengthDescriptor.value !== rawCommand.length)
    throw new Error("Sandbox command length must be a data property");
  if (rawCommand.length === 0) throw new Error("Sandbox command cannot be empty");
  if (rawCommand.length > maxArgs) throw new Error(`Sandbox command must contain at most ${maxArgs} arguments`);
  const command: string[] = [];
  let totalLength = 0;
  for (let index = 0; index < rawCommand.length; index += 1) {
    const descriptor = commandDescriptors[String(index)];
    if (descriptor === undefined || "get" in descriptor || "set" in descriptor) throw new Error("Sandbox command arguments must be string data properties");
    const argument: unknown = descriptor.value;
    if (typeof argument !== "string") throw new Error("Sandbox command arguments must be string data properties");
    if (argument.length === 0) throw new Error("Sandbox command arguments cannot be empty");
    if (Buffer.byteLength(argument, "utf8") > maxArgLength) throw new Error(`Sandbox command arguments must contain at most ${maxArgLength} bytes`);
    if (argument.includes("\0")) throw new Error("Sandbox command arguments cannot contain NUL characters");
    totalLength += Buffer.byteLength(argument, "utf8");
    if (totalLength > maxCommandLength) throw new Error(`Sandbox command must contain at most ${maxCommandLength} bytes in total`);
    command.push(argument);
  }

  const rawImage: unknown = descriptors.image?.value;
  if (rawImage !== undefined && typeof rawImage !== "string") throw new Error("Docker sandbox image must be a string");
  if (typeof rawImage === "string" && rawImage.trim() === "") throw new Error("Docker sandbox image must be non-empty");
  if (typeof rawImage === "string" && rawImage.length > maxImageLength)
    throw new Error(`Docker image reference must contain at most ${maxImageLength} characters`);
  const rawWrite: unknown = descriptors.write?.value;
  if (rawWrite !== undefined && typeof rawWrite !== "boolean") throw new Error("Docker sandbox write must be a boolean");
  const rawConfirmWrite: unknown = descriptors.confirmWrite?.value;
  if (rawConfirmWrite !== undefined && typeof rawConfirmWrite !== "boolean") throw new Error("Docker sandbox confirmWrite must be a boolean");
  return { command, ...(rawImage === undefined ? {} : { image: rawImage }), write: rawWrite === true, confirmWrite: rawConfirmWrite === true };
}

function csvField(key: string, value: string): string {
  return `"${`${key}=${value}`.replaceAll('"', '""')}"`;
}

function cloneRun(run: SandboxRun): SandboxRun {
  return { ...run, command: [...run.command] };
}

function boundedOutput(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxOutputBytes) return value;
  let start = bytes.length - maxOutputBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function safeOutput(value: string): string {
  const withoutTerminalSequences = stripVTControlCharacters(value);
  let normalized = "";
  for (const character of withoutTerminalSequences) {
    normalized += unsafeUnicode.test(character) && character !== "\t" && character !== "\n" ? "�" : character;
  }
  return boundedOutput(normalized.replaceAll(/\r\n?/gu, "\n"));
}

function outputFromFailure(failure: { stdout?: string; stderr?: string; message?: string }): string {
  return safeOutput(`${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? ""}`);
}

async function containerId(cidfile: string): Promise<string | undefined> {
  try {
    const id = (await readFile(cidfile, "utf8")).trim();
    return /^[a-f0-9]{64}$/iu.test(id) ? id : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeOwnedContainer(id: string): Promise<void> {
  try {
    await execFileAsync("docker", ["rm", "--force", id], {
      timeout: cleanupTimeoutMs,
      maxBuffer: 1_000_000,
      windowsHide: true,
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    const detail = outputFromFailure(failure);
    if (/No such container/iu.test(detail)) return;
    throw new Error(`Docker sandbox container cleanup could not be confirmed: ${detail.slice(-1_024) || "unknown Docker error"}`, { cause: error });
  }
}

export default {
  name: "pi-docker-sandbox",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let latest: SandboxRun | undefined;
    const lifecycle = new AbortController();
    let unregisterTool: () => void = () => undefined;
    let disposePanel: () => void = () => undefined;
    try {
      unregisterTool = context.piTools.register(
        defineTool({
          name: "sandbox_exec",
          label: "Docker sandbox",
          description: "Run a bounded argv command in a no-network Docker container using an explicitly local image and a read-only workspace by default.",
          promptSnippet: "run a bounded command in an isolated no-network Docker sandbox",
          parameters: Type.Object(
            {
              command: Type.Array(Type.String({ minLength: 1, maxLength: maxArgLength }), {
                minItems: 1,
                maxItems: maxArgs,
                description: "Executable and arguments; shell wrappers are rejected",
              }),
              image: Type.Optional(Type.String({ minLength: 1, maxLength: maxImageLength, description: `Local Docker image, default ${defaultImage}` })),
              write: Type.Optional(Type.Boolean({ description: "Mount the workspace read-write" })),
              confirmWrite: Type.Optional(Type.Boolean({ description: "Must be true when write is enabled" })),
            },
            { additionalProperties: false },
          ),
          executionMode: "sequential",
          async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<SandboxRun>> {
            const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            throwIfAborted(operationSignal);
            const params = validateParameters(rawParams);
            const executable = params.command[0]!;
            if (shellCommands.has(executableName(executable))) throw new Error("Shell wrappers are not allowed; pass an executable argv directly");
            const image = params.image?.trim() || defaultImage;
            validateImage(image);
            if (params.write && !params.confirmWrite) throw new Error("Writable sandbox requires confirmWrite=true");
            try {
              await execFileAsync("docker", ["image", "inspect", image], {
                timeout: inspectTimeoutMs,
                maxBuffer: 1_000_000,
                signal: operationSignal,
                windowsHide: true,
              });
            } catch (error) {
              throwIfAborted(operationSignal);
              const failure = error as { code?: number | string };
              if (failure.code === "ENOENT") throw new Error("Docker executable is not available on PATH", { cause: error });
              throw new Error(`Docker image is not available locally: ${image}`, { cause: error });
            }

            const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-harness-docker-sandbox-"));
            const cidfile = join(temporaryDirectory, "container.cid");
            const containerName = `pi-harness-sandbox-${randomUUID()}`;
            const mount = `type=bind,${csvField("src", context.piHarnessLaunch.cwd)},dst=/workspace${params.write ? "" : ",readonly"}`;
            const args = [
              "run",
              "--rm",
              "--name",
              containerName,
              "--cidfile",
              cidfile,
              "--pull=never",
              "--network",
              "none",
              "--read-only",
              "--tmpfs",
              "/tmp:rw,noexec,nosuid",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--memory",
              memoryLimit,
              "--cpus",
              cpuLimit,
              "--pids-limit",
              String(processLimit),
              "--mount",
              mount,
              "--workdir",
              "/workspace",
              image,
              ...params.command,
            ];
            try {
              try {
                const result = await execFileAsync("docker", args, {
                  cwd: context.piHarnessLaunch.cwd,
                  timeout: runTimeoutMs,
                  maxBuffer: 4 * 1024 * 1024,
                  signal: operationSignal,
                  windowsHide: true,
                });
                const run: SandboxRun = {
                  image,
                  command: [...params.command],
                  write: params.write,
                  exitCode: 0,
                  status: "completed",
                  output: safeOutput(`${result.stdout}${result.stderr}`),
                };
                latest = cloneRun(run);
                return {
                  content: [{ type: "text", text: `Docker sandbox exited with ${run.exitCode}.\n${run.output}` }],
                  details: cloneRun(run),
                };
              } catch (error) {
                const id = await containerId(cidfile);
                await removeOwnedContainer(id ?? containerName);
                throwIfAborted(operationSignal);
                const failure = error as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
                const run: SandboxRun = {
                  image,
                  command: [...params.command],
                  write: params.write,
                  exitCode: typeof failure.code === "number" ? failure.code : 1,
                  status: failure.killed === true ? "timed_out" : "failed",
                  output: outputFromFailure(failure),
                };
                latest = cloneRun(run);
                return {
                  content: [{ type: "text", text: `Docker sandbox exited with ${run.exitCode}.\n${run.output}` }],
                  details: cloneRun(run),
                };
              }
            } finally {
              await rm(temporaryDirectory, { force: true, recursive: true });
            }
          },
        }),
      );
      disposePanel = context.piPluginUi.register({
        id: "docker-sandbox-panel",
        pluginId: "@pi-harness/core/plugins/docker-sandbox",
        title: "Docker Sandbox",
        description: "仅使用本地镜像，并以无网络、只读根文件系统和有界资源运行 argv 命令。工作区默认只读。",
        icon: "⬡",
        read: () => ({
          latest: latest === undefined ? null : cloneRun(latest),
          defaults: {
            network: "none",
            rootFilesystem: "read-only",
            workspace: "read-only",
            image: defaultImage,
            pull: "never",
            memory: memoryLimit,
            cpus: Number(cpuLimit),
            pids: processLimit,
            timeoutMs: runTimeoutMs,
          },
        }),
      });
    } catch (error) {
      disposePanel();
      unregisterTool();
      lifecycle.abort(new Error("Docker sandbox plugin registration failed"));
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Docker sandbox plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
