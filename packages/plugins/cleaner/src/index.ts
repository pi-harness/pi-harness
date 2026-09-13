import { lstat, opendir } from "node:fs/promises";
import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {} from "@pi-harness/plugin-api";

export type CleanerConfig = Record<never, never>;

export const Config: z<CleanerConfig> = z.object({});

const capsuleDirectory = "capsules";
const maxCapsules = 256;
const maxDirectoryEntries = 4096;
type Capsule = { name: string; bytes: number };
type CapsuleEntry = Capsule & { device: number; inode: number };
type DirectoryIdentity = { device: number; inode: number };
type CleanupActivity = {
  status: "running" | "completed" | "failed" | "cancelled";
  at: string;
  requestedKeep: number;
  removed: number;
  kept?: number;
  error?: string;
};

const maxPanelCapsules = 20;
const maxErrorLength = 2_000;
const parameterNames = new Set(["confirm", "keep"]);
const unsafeUnicode = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

function dataObject(value: unknown, label: string): PropertyDescriptorMap {
  if (value === null || typeof value !== "object") throw new Error(`${label} must be a plain object`);
  let array: boolean;
  let prototype: unknown;
  let descriptors: PropertyDescriptorMap;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new Error(`${label} must be an accessible plain object`, { cause: error });
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) throw new Error(`${label} must be a plain object`);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error(`${label} must use data properties`);
  return descriptors;
}

function assertConfig(config: unknown): asserts config is CleanerConfig {
  const descriptors = dataObject(config, "Cleaner config");
  const unknown = Reflect.ownKeys(descriptors);
  if (unknown.length > 0) throw new Error(`Unknown Cleaner config key: ${typeof unknown[0] === "symbol" ? "symbol" : unknown[0]}`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Cleaner operation was cancelled", { cause: signal.reason });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function rejectionError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(rejectionError(error, "Cleaner operation was cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(rejectionError(error, "Cleaner operation was cancelled"));
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
        reject(rejectionError(error, "Cleaner operation failed"));
      },
    );
  });
}

function boundedError(error: unknown): string {
  let message: string | undefined;
  if (typeof error === "string") message = error;
  else if (typeof error === "object" && error !== null) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") message = descriptor.value;
    } catch {
      // Fall through to the stable message below.
    }
  }
  if (message === undefined) return "Unknown cleaner error";
  let output = "";
  let outputBytes = 0;
  let outputCharacters = 0;
  let scanned = 0;
  for (const character of message) {
    scanned += 1;
    if (scanned > maxErrorLength * 4) break;
    const safe = unsafeUnicode.test(character) ? " " : character;
    if (output === "" && /^\s$/u.test(safe)) continue;
    const bytes = Buffer.byteLength(safe, "utf8");
    if (outputCharacters >= maxErrorLength || outputBytes + bytes > maxErrorLength) break;
    output += safe;
    outputBytes += bytes;
    outputCharacters += 1;
  }
  return output.trimEnd() || "Unknown cleaner error";
}

function publicError(error: unknown): Error {
  const message = boundedError(error);
  return new Error(message === "Unknown cleaner error" ? "Cleaner operation failed" : message, { cause: error });
}

async function directoryIdentity(directory: string, signal?: AbortSignal): Promise<DirectoryIdentity | undefined> {
  throwIfAborted(signal);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  throwIfAborted(signal);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Cleaner capsule directory must be a regular directory, not a symbolic link");
  return { device: metadata.dev, inode: metadata.ino };
}

async function requireSameDirectory(directory: string, expected: DirectoryIdentity, signal?: AbortSignal): Promise<void> {
  const current = await directoryIdentity(directory, signal);
  if (current === undefined || current.device !== expected.device || current.inode !== expected.inode)
    throw new Error("Cleaner capsule directory changed while the operation was running");
}

function parseKeep(params: unknown): number {
  const descriptors = dataObject(params, "Cleaner parameters");
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !parameterNames.has(key)))
    throw new Error("Cleaner parameters contain an unknown property");
  const confirm: unknown = descriptors.confirm?.value;
  if (confirm !== true) throw new Error("Cleaning requires confirm=true");
  const keepValue: unknown = descriptors.keep?.value;
  const keep = keepValue === undefined ? 5 : keepValue;
  if (typeof keep !== "number" || !Number.isInteger(keep) || keep < 0 || keep > maxCapsules)
    throw new Error(`Cleaner keep must be an integer between 0 and ${maxCapsules}`);
  return keep;
}

function safeCapsuleName(name: string): boolean {
  return (
    name.length > 0 &&
    name === name.trim() &&
    name.endsWith(".patch") &&
    [...name].length <= 255 &&
    Buffer.byteLength(name, "utf8") <= 255 &&
    !unsafeUnicode.test(name) &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

async function listCapsules(directory: string, signal?: AbortSignal): Promise<{ capsules: CapsuleEntry[]; directory?: DirectoryIdentity }> {
  const identity = await directoryIdentity(directory, signal);
  if (identity === undefined) return { capsules: [] };
  let handle: Awaited<ReturnType<typeof opendir>>;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if (isMissing(error)) return { capsules: [] };
    throw error;
  }
  const names: string[] = [];
  let scanned = 0;
  for await (const entry of handle) {
    throwIfAborted(signal);
    scanned += 1;
    if (scanned > maxDirectoryEntries) throw new Error(`Cleaner capsule directory exceeds the ${maxDirectoryEntries}-entry scan limit`);
    if (!entry.isFile() || !safeCapsuleName(entry.name)) continue;
    names.push(entry.name);
    if (names.length > maxCapsules) throw new Error(`Cleaner capsule directory exceeds the ${maxCapsules}-capsule limit`);
  }
  names.sort().reverse();
  const capsules: CapsuleEntry[] = [];
  for (const name of names) {
    throwIfAborted(signal);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(join(directory, name));
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (metadata.isFile() && !metadata.isSymbolicLink()) capsules.push({ name, bytes: metadata.size, device: metadata.dev, inode: metadata.ino });
  }
  await requireSameDirectory(directory, identity, signal);
  return { capsules, directory: identity };
}

export default {
  name: "pi-cleaner",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: CleanerConfig) {
    assertConfig(config);
    const directory = join(context.piHarnessLaunch.agentDir, capsuleDirectory);
    const lifecycle = new AbortController();
    let cleanupQueue: Promise<void> = Promise.resolve();
    let lastCleanup: CleanupActivity | undefined;
    let sequence = 0;
    let visibleSequence = 0;
    const runExclusive = <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
      const result = cleanupQueue.then(operation, operation);
      cleanupQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return withCancellation(result, signal);
    };
    let unregisterTool: () => void = () => undefined;
    let disposePanel: () => void = () => undefined;
    try {
      unregisterTool = context.piTools.register(
        defineTool({
          name: "clean_harness_artifacts",
          label: "Clean harness artifacts",
          description: "Remove only Pi Harness Git capsule patch files from the agent data directory. Confirmation is required.",
          promptSnippet: "clean old Pi Harness rollback artifacts",
          parameters: Type.Object(
            {
              confirm: Type.Boolean({ description: "Must be true to remove files" }),
              keep: Type.Optional(Type.Integer({ description: "Number of newest capsules to keep, from 0 to 256", minimum: 0, maximum: maxCapsules })),
            },
            { additionalProperties: false },
          ),
          executionMode: "sequential",
          async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<{ removed: number; kept: number }>> {
            const actionSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            throwIfAborted(actionSignal);
            const keep = parseKeep(rawParams);
            const operationSequence = ++sequence;
            let removed = 0;
            const updateActivity = (activity: CleanupActivity): void => {
              if (operationSequence < visibleSequence) return;
              visibleSequence = operationSequence;
              lastCleanup = activity;
            };
            updateActivity({ status: "running", at: new Date().toISOString(), requestedKeep: keep, removed });
            try {
              return await runExclusive(async () => {
                try {
                  throwIfAborted(actionSignal);
                  const inventory = await listCapsules(directory, actionSignal);
                  const remove = inventory.capsules.slice(keep);
                  for (const capsule of remove) {
                    throwIfAborted(actionSignal);
                    if (inventory.directory === undefined) throw new Error("Cleaner capsule directory disappeared while the operation was running");
                    await requireSameDirectory(directory, inventory.directory, actionSignal);
                    let metadata: ReturnType<typeof lstatSync>;
                    try {
                      // Keep the final directory identity check, target identity check, and unlink
                      // in one synchronous turn so an async scheduler cannot interpose a parent swap.
                      const currentDirectory = lstatSync(directory);
                      if (
                        !currentDirectory.isDirectory() ||
                        currentDirectory.isSymbolicLink() ||
                        currentDirectory.dev !== inventory.directory.device ||
                        currentDirectory.ino !== inventory.directory.inode
                      )
                        throw new Error("Cleaner capsule directory changed before deletion");
                      metadata = lstatSync(join(directory, capsule.name));
                    } catch (error) {
                      if (isMissing(error)) continue;
                      throw error;
                    }
                    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.dev !== capsule.device || metadata.ino !== capsule.inode)
                      throw new Error(`Cleaner capsule changed before deletion: ${capsule.name}`);
                    unlinkSync(join(directory, capsule.name));
                    removed += 1;
                  }
                  const finalInventory = await listCapsules(directory, actionSignal);
                  const kept = finalInventory.capsules.length;
                  updateActivity({ status: "completed", at: new Date().toISOString(), requestedKeep: keep, removed, kept });
                  return {
                    content: [{ type: "text" as const, text: `Removed ${removed} Pi Harness capsule(s); kept ${kept}.` }],
                    details: { removed, kept },
                  };
                } catch (error) {
                  updateActivity({
                    status: actionSignal.aborted ? "cancelled" : "failed",
                    at: new Date().toISOString(),
                    requestedKeep: keep,
                    removed,
                    error: boundedError(error),
                  });
                  throw error;
                }
              }, actionSignal);
            } catch (error) {
              updateActivity({
                status: actionSignal.aborted ? "cancelled" : "failed",
                at: new Date().toISOString(),
                requestedKeep: keep,
                removed,
                error: boundedError(error),
              });
              throw publicError(error);
            }
          },
        }),
      );
      disposePanel = context.piPluginUi.register({
        id: "cleaner-panel",
        pluginId: "@pi-harness/plugin-cleaner",
        title: "Harness Cleaner",
        description: "清理 Pi Harness 自己生成的 Git 快照；默认不会触碰项目文件。",
        icon: "⌫",
        read: async () => {
          const inventory = await listCapsules(directory, lifecycle.signal);
          const capsules = inventory.capsules.slice(0, maxPanelCapsules).map(({ name, bytes }) => ({ name, bytes }));
          return {
            capsules,
            inventory: {
              total: inventory.capsules.length,
              shown: capsules.length,
              truncated: inventory.capsules.length > capsules.length,
              displayLimit: maxPanelCapsules,
            },
            lastCleanup: lastCleanup === undefined ? null : { ...lastCleanup },
            lastRemoved: lastCleanup?.removed ?? 0,
            limits: { capsules: maxCapsules, directoryEntries: maxDirectoryEntries },
          };
        },
      });
    } catch (error) {
      disposePanel();
      unregisterTool();
      lifecycle.abort(new Error("Cleaner plugin registration failed"));
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Cleaner plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
