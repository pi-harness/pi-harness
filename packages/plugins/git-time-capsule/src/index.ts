import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, opendir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys, readBoundedFile } from "@pi-harness/plugin-api";

const execFileAsync = promisify(execFile);
const capsuleDirectory = "capsules";
const maxCapsuleBytes = 8 * 1024 * 1024;
const defaultTimeoutMs = 15_000;
const maxCapsuleInventory = 256;
const maxCapsuleDirectoryEntries = 4096;
const maxErrorLength = 2_000;
const recentCapsuleLimit = 20;

type CapsuleActivity = {
  action: "capture" | "restore";
  status: "completed" | "failed" | "cancelled";
  at: string;
  name?: string;
  bytes?: number;
  files?: number;
  restored?: boolean;
  error?: string;
};

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(100, Math.min(60_000, Math.trunc(value))) : defaultTimeoutMs;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Git time capsule operation was cancelled", { cause: signal.reason });
}

function rejectionError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(rejectionError(error, "Git time capsule operation was cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(rejectionError(error, "Git time capsule operation was cancelled"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(rejectionError(error, "Git time capsule operation failed"));
      },
    );
  });
}

function boundedError(error: unknown, sensitivePaths: readonly string[] = []): string {
  let message: string | undefined;
  if (typeof error === "string") message = error;
  if (typeof error === "object" && error !== null) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") message = descriptor.value;
    } catch {
      // Fall through to the stable message below.
    }
  }
  if (message === undefined) return "Unknown Git time capsule error";
  for (const path of [...sensitivePaths].filter((path) => path !== "").sort((left, right) => right.length - left.length))
    message = message.replaceAll(path, "[private path]");
  const sanitized = message
    .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
    .trim()
    .slice(0, maxErrorLength);
  return sanitized === "" ? "Unknown Git time capsule error" : sanitized;
}

function publicOperationError(error: unknown, cwd: string, agentDir: string): Error {
  return new Error(boundedError(error, [cwd, agentDir]), { cause: error });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_WORK_TREE",
  ])
    delete environment[name];
  return environment;
}

async function git(cwd: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  if (signal !== undefined) throwIfAborted(signal);
  try {
    const result = await execFileAsync("git", [...args], {
      cwd,
      encoding: "buffer",
      env: gitEnvironment(),
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      signal,
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (error) {
    if (signal?.aborted === true) throwIfAborted(signal);
    const timedOut = typeof error === "object" && error !== null && "killed" in error && (error as { killed?: unknown }).killed === true;
    if (timedOut) throw new Error(`Git command timed out after ${timeoutMs} ms`, { cause: error });
    throw error;
  }
}

async function ensureGitWorkingTree(cwd: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  try {
    const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"], timeoutMs, signal);
    if (inside.toString("utf8").trim() === "true") return;
  } catch (error) {
    if (signal.aborted) throwIfAborted(signal);
    if (error instanceof Error && /timed out after/iu.test(error.message)) throw error;
    throw new Error("Git time capsule requires a Git working tree", { cause: error });
  }
  throw new Error("Git time capsule requires a Git working tree");
}

async function patchFileCount(cwd: string, patchPath: string, timeoutMs: number, signal?: AbortSignal): Promise<number> {
  const numstat = await git(cwd, ["-c", "core.quotePath=true", "apply", "--numstat", "--binary", patchPath], timeoutMs, signal);
  return numstat
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "").length;
}

async function applyCapsuleWithMetadata(
  cwd: string,
  capsulePath: string,
  timeoutMs = defaultTimeoutMs,
  signal?: AbortSignal,
): Promise<{ bytes: number; files: number }> {
  if (signal !== undefined) throwIfAborted(signal);
  const normalizedTimeoutMs = normalizeTimeout(timeoutMs);
  const capsule = await readBoundedFile(capsulePath, maxCapsuleBytes, "Git capsule");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-harness-capsule-"));
  const verifiedPath = join(temporaryDirectory, "capsule.patch");
  try {
    await writeFile(verifiedPath, capsule, { mode: 0o600, flag: "wx" });
    const files = await patchFileCount(cwd, verifiedPath, normalizedTimeoutMs, signal);
    try {
      await git(
        cwd,
        ["-c", "apply.ignoreWhitespace=false", "apply", "--reverse", "--check", "--binary", "--whitespace=nowarn", verifiedPath],
        normalizedTimeoutMs,
        signal,
      );
    } catch (cause) {
      if (signal?.aborted === true) throwIfAborted(signal);
      if (cause instanceof Error && /timed out after/iu.test(cause.message)) throw cause;
      throw new Error("Git capsule does not apply cleanly", { cause });
    }
    await git(cwd, ["-c", "apply.ignoreWhitespace=false", "apply", "--reverse", "--binary", "--whitespace=nowarn", verifiedPath], normalizedTimeoutMs, signal);
    return { bytes: capsule.length, files };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function applyCapsule(cwd: string, capsulePath: string, timeoutMs = defaultTimeoutMs, signal?: AbortSignal): Promise<void> {
  await applyCapsuleWithMetadata(cwd, capsulePath, timeoutMs, signal);
}

export interface GitTimeCapsulePluginConfig {
  timeoutMs?: number;
}

export const Config: z<GitTimeCapsulePluginConfig> = z.object({ timeoutMs: z.number().default(defaultTimeoutMs) });

function dataDescriptors(value: unknown, field: string, allowed: ReadonlySet<string>): Record<PropertyKey, PropertyDescriptor> {
  if (value === null || typeof value !== "object") throw new Error(`${field} must be an object`);
  let descriptors: PropertyDescriptorMap;
  let prototype: unknown;
  let array: boolean;
  try {
    array = Array.isArray(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value) as unknown;
  } catch (error) {
    throw new Error(`${field} must be an accessible plain object`, { cause: error });
  }
  if (array) throw new Error(`${field} must be an object`);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${field} must be a plain object`);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) throw new Error(`${field} contains an unknown property`);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error(`${field} must use data properties`);
  return descriptors;
}

function restoreParameters(value: unknown): { name: string; confirm: boolean } {
  const descriptors = dataDescriptors(value, "Git restore parameters", new Set(["name", "confirm"]));
  const rawName: unknown = descriptors.name?.value;
  const rawConfirm: unknown = descriptors.confirm?.value;
  if (typeof rawName !== "string") throw new Error("Git restore name must be a string");
  if (typeof rawConfirm !== "boolean") throw new Error("Git restore confirm must be a boolean");
  return { name: rawName, confirm: rawConfirm };
}

function restoreCapsuleName(value: string): string {
  if (value.includes("\0")) throw new Error("Capsule name must not contain NUL characters");
  if (
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 255 ||
    !value.endsWith(".patch") ||
    /[/\\\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  )
    throw new Error("Capsule name must be a safe .patch filename");
  return value;
}

async function inspectCapsuleDirectory(directory: string, allowMissing: boolean): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      if (allowMissing) return undefined;
      throw new Error("Git capsule directory does not exist", { cause: error });
    }
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new Error("Git capsule directory must not be a symbolic link");
  if (!metadata.isDirectory()) throw new Error("Git capsule directory must be a directory");
  return metadata;
}

function sameDirectory(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>> | undefined,
): right is Awaited<ReturnType<typeof lstat>> {
  return right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

async function listCapsules(
  directory: string,
): Promise<{ capsules: { name: string; bytes: number }[]; total: number; scannedEntries: number; truncated: boolean }> {
  const directoryMetadata = await inspectCapsuleDirectory(directory, true);
  if (directoryMetadata === undefined) return { capsules: [], total: 0, scannedEntries: 0, truncated: false };
  let handle: Awaited<ReturnType<typeof opendir>>;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT")
      throw new Error("Git capsule directory changed while it was being listed", { cause: error });
    throw error;
  }
  const names: string[] = [];
  let scanned = 0;
  for await (const entry of handle) {
    scanned += 1;
    if (scanned > maxCapsuleDirectoryEntries) throw new Error(`Git capsule directory exceeds the ${maxCapsuleDirectoryEntries}-entry scan limit`);
    if (!entry.isFile() || !entry.name.endsWith(".patch")) continue;
    names.push(entry.name);
    if (names.length > maxCapsuleInventory) throw new Error(`Git capsule directory exceeds the ${maxCapsuleInventory}-capsule limit`);
  }
  if (!sameDirectory(directoryMetadata, await inspectCapsuleDirectory(directory, false)))
    throw new Error("Git capsule directory changed while it was being listed");
  const recent = names.sort().reverse().slice(0, recentCapsuleLimit);
  const capsules = await Promise.all(
    recent.map(async (name) => {
      try {
        const metadata = await lstat(join(directory, name));
        return metadata.isFile() ? { name, bytes: metadata.size } : undefined;
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
        throw error;
      }
    }),
  );
  if (!sameDirectory(directoryMetadata, await inspectCapsuleDirectory(directory, false)))
    throw new Error("Git capsule directory changed while it was being listed");
  return {
    capsules: capsules.filter((capsule): capsule is { name: string; bytes: number } => capsule !== undefined),
    total: names.length,
    scannedEntries: scanned,
    truncated: names.length > recentCapsuleLimit,
  };
}

export default {
  name: "pi-git-time-capsule",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: GitTimeCapsulePluginConfig) {
    assertKnownConfigKeys("git time capsule", config, ["timeoutMs"]);
    const directory = join(context.piHarnessLaunch.agentDir, capsuleDirectory);
    const timeoutMs = normalizeTimeout(config.timeoutMs);
    let latest: CapsuleActivity | undefined;
    const lifecycle = new AbortController();
    let operationTail = Promise.resolve();
    const runExclusive = <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
      const result = operationTail.then(operation, operation);
      operationTail = result.then(
        () => undefined,
        () => undefined,
      );
      return withCancellation(result, signal);
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "git_snapshot",
        label: "Capture Git undo capsule",
        description:
          "Capture the current unstaged tracked Git diff as a bounded timestamped undo patch outside the workspace; staged and untracked files are not included.",
        promptSnippet: "capture the current unstaged tracked changes as a Git undo capsule",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<{ name: string; bytes: number; files: number }>> {
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          try {
            dataDescriptors(rawParams, "Git snapshot parameters", new Set());
            throwIfAborted(operationSignal);
            return await runExclusive(async () => {
              throwIfAborted(operationSignal);
              await ensureGitWorkingTree(context.piHarnessLaunch.cwd, timeoutMs, operationSignal);
              const patch = await git(
                context.piHarnessLaunch.cwd,
                ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--", ".", ":(exclude).pi-harness/capsules"],
                timeoutMs,
                operationSignal,
              );
              if (patch.length === 0) throw new Error("No tracked Git changes are available to capture; staged and untracked changes are excluded");
              throwIfAborted(operationSignal);
              await mkdir(directory, { recursive: true, mode: 0o700 });
              await inspectCapsuleDirectory(directory, false);
              const inventory = await listCapsules(directory);
              if (inventory.scannedEntries >= maxCapsuleDirectoryEntries)
                throw new Error(
                  `Git capsule directory reached the ${maxCapsuleDirectoryEntries}-entry scan limit; remove an older entry before capturing another`,
                );
              if (inventory.total >= maxCapsuleInventory)
                throw new Error(`Git capsule inventory reached the ${maxCapsuleInventory}-capsule limit; remove an older capsule before capturing another`);
              const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
              const name = `${timestamp}-${randomUUID().slice(0, 8)}.patch`;
              const path = join(directory, name);
              const temporaryPath = join(directory, `.${name}.${randomUUID()}.tmp`);
              let files: number;
              try {
                await writeFile(temporaryPath, patch, { mode: 0o600, flag: "wx", signal: operationSignal });
                files = await patchFileCount(context.piHarnessLaunch.cwd, temporaryPath, timeoutMs, operationSignal);
                throwIfAborted(operationSignal);
                await link(temporaryPath, path);
              } finally {
                await rm(temporaryPath, { force: true }).catch(() => undefined);
              }
              const bytes = patch.length;
              latest = { action: "capture", status: "completed", at: new Date().toISOString(), name, bytes, files };
              return { content: [{ type: "text", text: `Git undo capsule saved: ${name}` }], details: { name, bytes, files } };
            }, operationSignal);
          } catch (error) {
            const failure = publicOperationError(error, context.piHarnessLaunch.cwd, context.piHarnessLaunch.agentDir);
            latest = {
              action: "capture",
              status: operationSignal.aborted ? "cancelled" : "failed",
              at: new Date().toISOString(),
              error: failure.message,
            };
            throw failure;
          }
        },
      }),
    );
    context.effect(() => unregisterTool);
    const unregisterRestore = context.piTools.register(
      defineTool({
        name: "git_restore",
        label: "Apply Git undo capsule",
        description: "Reverse-apply a saved Git undo capsule after explicit confirmation; the patch is checked before it changes the workspace.",
        promptSnippet: "reverse-apply a previously captured Git undo capsule",
        parameters: Type.Object(
          { name: Type.String({ description: "Capsule filename from the recent snapshots list" }), confirm: Type.Boolean() },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<{ name: string; restored: true }>> {
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          try {
            const params = restoreParameters(rawParams);
            throwIfAborted(operationSignal);
            return await runExclusive(async () => {
              throwIfAborted(operationSignal);
              if (!params.confirm) throw new Error("Git capsule restore writes the workspace and requires confirm=true");
              const name = restoreCapsuleName(params.name);
              const path = join(directory, name);
              await inspectCapsuleDirectory(directory, false);
              const applied = await applyCapsuleWithMetadata(context.piHarnessLaunch.cwd, path, timeoutMs, operationSignal);
              latest = {
                action: "restore",
                status: "completed",
                at: new Date().toISOString(),
                name,
                bytes: applied.bytes,
                files: applied.files,
                restored: true,
              };
              return { content: [{ type: "text", text: `Git undo capsule restored: ${name}` }], details: { name, restored: true } };
            }, operationSignal);
          } catch (error) {
            const failure = publicOperationError(error, context.piHarnessLaunch.cwd, context.piHarnessLaunch.agentDir);
            latest = {
              action: "restore",
              status: operationSignal.aborted ? "cancelled" : "failed",
              at: new Date().toISOString(),
              error: failure.message,
            };
            throw failure;
          }
        },
      }),
    );
    context.effect(() => unregisterRestore);
    const disposePanel = context.piPluginUi.register({
      id: "git-time-capsule-panel",
      pluginId: "@pi-harness/plugin-git-time-capsule",
      title: "Git Time Capsule",
      description: "查看当前 unstaged tracked 改动生成的撤销胶囊；胶囊保存在工作区之外，不包含 staged 或未跟踪文件。",
      icon: "◫",
      read: async () => {
        try {
          const inventory = await listCapsules(directory);
          return {
            latest: latest === undefined ? null : { ...latest },
            capsules: inventory.capsules.map((capsule) => ({ ...capsule })),
            inventory: { total: inventory.total, shown: inventory.capsules.length, truncated: inventory.truncated, displayLimit: recentCapsuleLimit },
            timeoutMs,
            limits: { capsuleBytes: maxCapsuleBytes, inventory: maxCapsuleInventory, directoryEntries: maxCapsuleDirectoryEntries },
          };
        } catch (error) {
          throw publicOperationError(error, context.piHarnessLaunch.cwd, context.piHarnessLaunch.agentDir);
        }
      },
    });
    context.effect(() => disposePanel);
    context.effect(() => () => lifecycle.abort(new Error("Git time capsule plugin disposed")));
  },
};
