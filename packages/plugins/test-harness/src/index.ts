import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

const allowedScripts = ["test", "build", "format:check", "lint", "typecheck"] as const;
const allowedScriptSet = new Set<string>(allowedScripts);
const defaultTimeoutMs = 120_000;
const minimumTimeoutMs = 100;
const maximumTimeoutMs = 600_000;
const maxOutputBytes = 12 * 1024;
const terminationGraceMs = 1_000;

type TestScript = (typeof allowedScripts)[number];
type TestRunStatus = "passed" | "failed" | "timed-out" | "cancelled";

type TestRun = {
  script: TestScript;
  command: string;
  status: TestRunStatus;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
  outputSanitized: boolean;
};

export interface TestHarnessConfig {
  timeoutMs?: number;
}

export const Config: z<TestHarnessConfig> = z.object({ timeoutMs: z.number().default(defaultTimeoutMs) });

function testHarnessParameters(value: unknown): { script: TestScript } {
  if (value === null || typeof value !== "object") throw new Error("Test harness parameters must be a plain object");
  let descriptors: PropertyDescriptorMap;
  let prototype: unknown;
  let array: boolean;
  try {
    array = Array.isArray(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value) as unknown;
  } catch (error) {
    throw new Error("Test harness parameters must be an accessible plain object", { cause: error });
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) throw new Error("Test harness parameters must be a plain object");
  if (Reflect.ownKeys(descriptors).some((key) => key !== "script")) throw new Error("Test harness parameters must contain only script");
  const descriptor = descriptors.script;
  if (descriptor === undefined) return { script: "test" };
  if (!("value" in descriptor) || typeof descriptor.value !== "string") throw new Error("Test harness parameters script must be a string data property");
  if (!allowedScriptSet.has(descriptor.value)) throw new Error("Test harness parameters script is not an approved verification script");
  return { script: descriptor.value as TestScript };
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Project verification was cancelled");
}

function npmInvocation(script: TestScript): { executable: string; args: string[] } {
  const npmCli = process.env.npm_execpath;
  if (typeof npmCli === "string" && npmCli.trim() !== "" && isAbsolute(npmCli)) {
    return { executable: process.execPath, args: [npmCli, "run", script] };
  }
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `npm.cmd run ${script}`] };
  }
  return { executable: "npm", args: ["run", script] };
}

function appendTail(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, maximum: number): Buffer<ArrayBufferLike> {
  if (chunk.length >= maximum) return Buffer.from(chunk.subarray(chunk.length - maximum));
  if (current.length + chunk.length <= maximum) return Buffer.concat([current, chunk], current.length + chunk.length);
  const keep = maximum - chunk.length;
  return Buffer.concat([current.subarray(current.length - keep), chunk], maximum);
}

function utf8Tail(value: string, maximum: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximum) return { value, truncated: false };
  const codePoints = [...value];
  let bytes = 0;
  let start = codePoints.length;
  while (start > 0) {
    const size = Buffer.byteLength(codePoints[start - 1]!, "utf8");
    if (bytes + size > maximum) break;
    bytes += size;
    start -= 1;
  }
  return { value: codePoints.slice(start).join(""), truncated: true };
}

function replaceUnsafeControls(value: string): string {
  let output = "";
  for (const codePoint of value) {
    const code = codePoint.codePointAt(0)!;
    const safeCharacter = code === 9 || code === 10 || (code >= 32 && code !== 127 && (code < 128 || code > 159) && !/[\p{Cf}\p{Cs}]/u.test(codePoint));
    output += safeCharacter ? codePoint : "�";
  }
  return output;
}

function safeOutput(raw: Buffer): { output: string; boundedAgain: boolean; sanitized: boolean } {
  const decoded = raw.toString("utf8");
  const withoutTerminalSequences = stripVTControlCharacters(decoded);
  const normalized = replaceUnsafeControls(withoutTerminalSequences.replaceAll(/\r\n?/gu, "\n"));
  const bounded = utf8Tail(normalized, maxOutputBytes);
  return { output: bounded.value, boundedAgain: bounded.truncated, sanitized: decoded !== normalized };
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const terminator = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true });
    terminator.once("error", () => child.kill(signal));
    terminator.once("close", (code) => {
      if (code !== 0) child.kill(signal);
    });
    terminator.unref();
    return;
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back when no detached process group was established.
    }
  }
  child.kill(signal);
}

function safeSpawnFailure(error: unknown): string {
  if (error !== null && typeof error === "object") {
    try {
      const code = Object.getOwnPropertyDescriptor(error, "code");
      if (code !== undefined && "value" in code && typeof code.value === "string" && /^[A-Z0-9_]{1,32}$/u.test(code.value)) {
        return `Could not start npm (${code.value})`;
      }
    } catch {
      // Use the stable fallback below.
    }
  }
  return "Could not start npm";
}

function cloneRun(run: TestRun): TestRun {
  return { ...run };
}

function runNpmScript(cwd: string, script: TestScript, timeoutMs: number, signal: AbortSignal): Promise<TestRun> {
  throwIfCancelled(signal);
  const started = Date.now();
  const command = `npm run ${script}`;
  const invocation = npmInvocation(script);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const output = safeSpawnFailure(error);
      resolve({
        script,
        command,
        status: "failed",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - started,
        output,
        outputBytes: Buffer.byteLength(output, "utf8"),
        outputTruncated: false,
        outputSanitized: false,
      });
      return;
    }

    let outputTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let outputBytes = 0;
    let outputTruncated = false;
    let stopReason: "timed-out" | "cancelled" | undefined;
    let spawnFailure: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: Buffer) => {
      outputBytes = Math.min(Number.MAX_SAFE_INTEGER, outputBytes + chunk.length);
      outputTruncated ||= outputBytes > maxOutputBytes;
      outputTail = appendTail(outputTail, chunk, maxOutputBytes);
    };
    const stop = (reason: "timed-out" | "cancelled") => {
      stopReason ??= reason;
      if (child.exitCode !== null || child.signalCode !== null) return;
      terminateProcessTree(child, "SIGTERM");
      killTimer ??= setTimeout(() => terminateProcessTree(child, "SIGKILL"), terminationGraceMs);
      killTimer.unref();
    };
    const onAbort = () => stop("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => stop("timed-out"), timeoutMs);
    timeout.unref();
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => {
      spawnFailure = error;
    });
    child.once("close", (code, childSignal) => {
      clearTimeout(timeout);
      if (killTimer !== undefined && process.platform === "win32") clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      let safe = safeOutput(outputTail);
      if (spawnFailure !== undefined && safe.output === "") {
        const output = safeSpawnFailure(spawnFailure);
        safe = { output, boundedAgain: false, sanitized: false };
        outputBytes = Buffer.byteLength(output, "utf8");
      }
      const status: TestRunStatus = stopReason ?? (code === 0 ? "passed" : "failed");
      resolve({
        script,
        command,
        status,
        exitCode: stopReason === undefined ? code : null,
        signal: childSignal,
        durationMs: Date.now() - started,
        output: safe.output,
        outputBytes,
        outputTruncated: outputTruncated || safe.boundedAgain,
        outputSanitized: safe.sanitized,
      });
    });
  });
}

function agentText(run: TestRun): string {
  const output = run.output.replace(/<\/test-output(?=\s*>)/giu, "<\\/test-output");
  return `<test-output command="${run.command}" untrusted="true" status="${run.status}" exit-code="${run.exitCode ?? "unknown"}" output-truncated="${run.outputTruncated}">\n${output}\n</test-output>`;
}

export default {
  name: "pi-test-harness",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: TestHarnessConfig) {
    assertKnownConfigKeys("test-harness", config, ["timeoutMs"]);
    const timeoutMs = config.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < minimumTimeoutMs || timeoutMs > maximumTimeoutMs)
      throw new Error(`Test-harness timeoutMs must be an integer from ${minimumTimeoutMs} through ${maximumTimeoutMs}`);
    let latest: TestRun | undefined;
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort(new Error("Test-harness plugin was disposed")));
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "run_project_tests",
        label: "Run project tests",
        description: "Run one approved npm verification script in the current workspace with bounded, untrusted output and lifecycle cancellation.",
        promptSnippet: "run an approved project verification script",
        parameters: Type.Object(
          {
            script: Type.Optional(
              Type.Union([Type.Literal("test"), Type.Literal("build"), Type.Literal("format:check"), Type.Literal("lint"), Type.Literal("typecheck")], {
                description: "Approved project verification script; defaults to test",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<TestRun>> {
          const { script } = testHarnessParameters(rawParams);
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          throwIfCancelled(operationSignal);
          const run = await runNpmScript(context.piHarnessLaunch.cwd, script, timeoutMs, operationSignal);
          latest = cloneRun(run);
          if (run.status === "cancelled") throw new Error("Project verification was cancelled");
          return { content: [{ type: "text", text: agentText(run) }], details: cloneRun(run) };
        },
      }),
    );
    context.effect(() => unregisterTool);
    const disposePanel = context.piPluginUi.register({
      id: "test-harness-panel",
      pluginId: "@pi-harness/plugin-test-harness",
      title: "Test Harness",
      description: "执行受限 npm 验证脚本，并显示真实退出码、耗时和有界输出摘要。",
      icon: "✓",
      read: () => ({
        allowedScripts: [...allowedScripts],
        latest: latest === undefined ? null : cloneRun(latest),
        limits: { timeoutMs, outputBytes: maxOutputBytes },
      }),
    });
    context.effect(() => disposePanel);
  },
};
