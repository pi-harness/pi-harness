import { randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { readBoundedTextFile } from "../bounded-file.js";
import { assertKnownConfigKeys } from "../config.js";

const defaultFileName = "cost-meter.json";
const defaultMaxEntries = 365;
const maxFileEntries = 2_000;
const maxCostFileBytes = 4 * 1024 * 1024;
const maxCostValue = 1_000_000_000;
const costPrecision = 0.000_001;
const maxFileNameLength = 128;
const lockAttempts = 80;
const lockRetryMs = 25;
const staleLockMs = 30_000;
const maxLockFileBytes = 1_024;

export interface CostMeterPluginConfig {
  fileName?: string;
  dailyBudget?: number;
  maxEntries?: number;
}

export const Config: z<CostMeterPluginConfig> = z.object({
  fileName: z.string().min(1).max(maxFileNameLength).default(defaultFileName),
  dailyBudget: z.number().min(0).max(maxCostValue).step(costPrecision).default(0),
  maxEntries: z.number().min(1).max(maxFileEntries).step(1).default(defaultMaxEntries),
});

export interface CostEntry {
  sessionId: string;
  cost: number;
  sessionCost: number;
  tokens: number;
  messages: number;
  recordedAt: string;
}

export interface CostMeterReport {
  sessionCost: number;
  todayCost: number;
  lifetimeCost: number;
  budget: number | null;
  budgetPercent: number | null;
  dayBasis: "UTC";
  entryLimit: number;
  lastError: string | null;
  entries: CostEntry[];
}

interface CostFile {
  version: 2;
  entries: CostEntry[];
}

interface CostSnapshot {
  sessionId: string;
  cost: number;
  tokens: number;
  messages: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasNonPortableFileNameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 31 || codePoint === 127 || '<>:"/\\|?*'.includes(character)) return true;
  }
  return false;
}

function normalizeFilePath(agentDir: string, fileName: string | undefined): string {
  const name = (fileName ?? defaultFileName).trim();
  if (
    name === "" ||
    name.length > maxFileNameLength ||
    basename(name) !== name ||
    hasNonPortableFileNameCharacter(name) ||
    !name.toLowerCase().endsWith(".json")
  )
    throw new Error(`Cost meter config fileName must be a single portable .json filename of at most ${maxFileNameLength} characters`);
  return resolve(agentDir, name);
}

function finiteCost(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) / 1_000_000 : 0;
}

function todayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function reportFor(entries: readonly CostEntry[], current: CostSnapshot, budget: number | null, entryLimit: number, lastError: string | null): CostMeterReport {
  const today = todayKey(new Date());
  const todayCost = entries.filter((entry) => todayKey(new Date(entry.recordedAt)) === today).reduce((sum, entry) => sum + entry.cost, 0);
  const lifetimeCost = entries.reduce((sum, entry) => sum + entry.cost, 0);
  const roundedToday = finiteCost(todayCost);
  return {
    sessionCost: finiteCost(current.cost),
    todayCost: roundedToday,
    lifetimeCost: finiteCost(lifetimeCost),
    budget,
    budgetPercent: budget === null || budget === 0 ? null : Math.round((roundedToday / budget) * 10_000) / 100,
    dayBasis: "UTC",
    entryLimit,
    lastError,
    entries: entries.map((entry) => ({ ...entry })),
  };
}

export function upsertCostEntry(entries: readonly CostEntry[], entry: CostEntry, limit: number): CostEntry[] {
  const key = `${entry.sessionId}\0${todayKey(new Date(entry.recordedAt))}`;
  return [entry, ...entries.filter((item) => `${item.sessionId}\0${todayKey(new Date(item.recordedAt))}` !== key)].slice(0, limit);
}

function parseCostEntry(value: unknown, legacy: boolean): CostEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId.trim().length === 0 ||
    value.sessionId.length > 512 ||
    typeof value.cost !== "number" ||
    !Number.isFinite(value.cost) ||
    value.cost < 0 ||
    value.cost > maxCostValue ||
    typeof value.tokens !== "number" ||
    !Number.isSafeInteger(value.tokens) ||
    value.tokens < 0 ||
    typeof value.messages !== "number" ||
    !Number.isSafeInteger(value.messages) ||
    value.messages < 0 ||
    typeof value.recordedAt !== "string" ||
    value.recordedAt.length > 64 ||
    !Number.isFinite(Date.parse(value.recordedAt))
  )
    return undefined;
  const sessionCost = legacy ? value.cost : value.sessionCost;
  if (typeof sessionCost !== "number" || !Number.isFinite(sessionCost) || sessionCost < 0 || sessionCost > maxCostValue) return undefined;
  return {
    sessionId: value.sessionId,
    cost: finiteCost(value.cost),
    sessionCost: finiteCost(sessionCost),
    tokens: value.tokens,
    messages: value.messages,
    recordedAt: new Date(value.recordedAt).toISOString(),
  };
}

async function readCostEntries(filePath: string, entryLimit: number): Promise<CostEntry[]> {
  let source: string;
  try {
    source = await readBoundedTextFile(filePath, maxCostFileBytes, "Cost meter file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("Cost meter file contains invalid JSON", { cause: error });
  }
  if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.entries))
    throw new Error("Cost meter file has an unsupported format");
  if (parsed.entries.length > entryLimit) throw new Error(`Cost meter file exceeds its ${entryLimit}-entry limit`);
  const legacy = parsed.version === 1;
  const entries = parsed.entries.map((entry) => parseCostEntry(entry, legacy));
  if (entries.some((entry) => entry === undefined)) throw new Error("Cost meter file contains invalid entries");
  const valid = entries as CostEntry[];
  const keys = valid.map((entry) => (legacy ? entry.sessionId : `${entry.sessionId}\0${todayKey(new Date(entry.recordedAt))}`));
  if (new Set(keys).size !== keys.length) throw new Error("Cost meter file contains duplicate entries");
  return valid;
}

function snapshotSessionStats(value: unknown): CostSnapshot {
  if (!isRecord(value)) throw new Error("Cost meter session stats must be an object");
  const tokens = value.tokens;
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId.trim().length === 0 ||
    value.sessionId.length > 512 ||
    typeof value.cost !== "number" ||
    !Number.isFinite(value.cost) ||
    value.cost < 0 ||
    value.cost > maxCostValue ||
    typeof value.totalMessages !== "number" ||
    !Number.isSafeInteger(value.totalMessages) ||
    value.totalMessages < 0 ||
    !isRecord(tokens) ||
    typeof tokens.total !== "number" ||
    !Number.isSafeInteger(tokens.total) ||
    tokens.total < 0
  )
    throw new Error("Cost meter session stats contain invalid session, cost, message, or token values");
  return {
    sessionId: value.sessionId,
    cost: finiteCost(value.cost),
    tokens: tokens.total,
    messages: value.totalMessages,
  };
}

function costEntryFor(entries: readonly CostEntry[], snapshot: CostSnapshot, recordedAt: string): CostEntry {
  const day = todayKey(new Date(recordedAt));
  const sameDay = entries.find((entry) => entry.sessionId === snapshot.sessionId && todayKey(new Date(entry.recordedAt)) === day);
  if (sameDay !== undefined) {
    const increment = snapshot.cost < sameDay.sessionCost ? snapshot.cost : snapshot.cost - sameDay.sessionCost;
    const dailyCost = finiteCost(sameDay.cost + increment);
    if (dailyCost > maxCostValue) throw new Error(`Cost meter daily cost exceeds its ${maxCostValue} limit`);
    return { ...snapshot, cost: dailyCost, sessionCost: snapshot.cost, recordedAt };
  }
  const previousDay = entries
    .filter((entry) => entry.sessionId === snapshot.sessionId && todayKey(new Date(entry.recordedAt)) !== day)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
  const cost = previousDay === undefined || snapshot.cost < previousDay.sessionCost ? snapshot.cost : snapshot.cost - previousDay.sessionCost;
  return { ...snapshot, cost: finiteCost(cost), sessionCost: snapshot.cost, recordedAt };
}

function cancellationError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? new Error(signal.reason.message, { cause: signal.reason }) : new Error(fallback, { cause: signal.reason });
}

function throwIfCancelled(signal: AbortSignal, fallback = "Cost meter operation was cancelled"): void {
  if (signal.aborted) throw cancellationError(signal, fallback);
}

function waitForLockRetry(signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, lockRetryMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectDelay(cancellationError(signal, "Cost meter operation was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfCancelled(signal);
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = (): void => rejectPromise(cancellationError(signal, "Cost meter operation was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function lockOwnerIsAlive(value: unknown): boolean | undefined {
  if (!isRecord(value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined;
  try {
    process.kill(value.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
  }
}

async function mayReclaimLock(lockPath: string, age: number): Promise<boolean> {
  if (age <= staleLockMs) return false;
  try {
    const owner = JSON.parse(await readBoundedTextFile(lockPath, maxLockFileBytes, "Cost meter persistence lock")) as unknown;
    return lockOwnerIsAlive(owner) !== true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    if (error instanceof SyntaxError) return true;
    return false;
  }
}

async function releaseOwnedLock(lockPath: string, owner: string): Promise<void> {
  const currentOwner = await readBoundedTextFile(lockPath, maxLockFileBytes, "Cost meter persistence lock").catch(() => undefined);
  if (currentOwner === owner) await unlink(lockPath).catch(() => {});
}

function validateReportParameters(value: unknown): { refresh: boolean } {
  if (!isRecord(value)) throw new Error("Cost report parameters must be an object containing only an optional boolean refresh field");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const refresh = descriptors.refresh;
  if (
    Reflect.ownKeys(descriptors).some((key) => key !== "refresh") ||
    (refresh !== undefined && ("get" in refresh || "set" in refresh || typeof refresh.value !== "boolean"))
  )
    throw new Error("Cost report parameters must be an object containing only an optional boolean refresh field");
  return { refresh: refresh?.value === true };
}

export default {
  name: "pi-cost-meter",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: CostMeterPluginConfig) {
    assertKnownConfigKeys("cost meter", config, ["fileName", "dailyBudget", "maxEntries"]);
    if (typeof config.fileName !== "string" || config.fileName.length > maxFileNameLength)
      throw new Error(`Cost meter config fileName must contain 1 to ${maxFileNameLength} characters`);
    if (
      typeof config.dailyBudget !== "number" ||
      !Number.isFinite(config.dailyBudget) ||
      config.dailyBudget < 0 ||
      (config.dailyBudget > 0 && config.dailyBudget < costPrecision) ||
      config.dailyBudget > maxCostValue
    )
      throw new Error(`Cost meter config dailyBudget must be 0 or a finite number from ${costPrecision} to ${maxCostValue}`);
    if (typeof config.maxEntries !== "number" || !Number.isInteger(config.maxEntries) || config.maxEntries < 1 || config.maxEntries > maxFileEntries)
      throw new Error(`Cost meter config maxEntries must be an integer from 1 to ${maxFileEntries}`);
    const filePath = normalizeFilePath(context.piHarnessLaunch.agentDir, config.fileName);
    const budgetValue = config.dailyBudget > 0 ? finiteCost(config.dailyBudget) : null;
    const entryLimit = config.maxEntries;
    let entries: CostEntry[] = [];
    let writeQueue = Promise.resolve();
    let pendingRecord: Promise<void> | undefined;
    let lastError: string | null = null;
    const lifecycle = new AbortController();
    const runtime = () => {
      const service = context.get("piRuntime");
      if (service === undefined) throw new Error("Pi runtime is not ready");
      return service;
    };
    const currentStats = (): CostSnapshot => snapshotSessionStats(runtime().session.getSessionStats());
    const persist = async (snapshot: CostSnapshot, recordedAt: string, signal: AbortSignal): Promise<void> => {
      writeQueue = writeQueue
        .catch(() => undefined)
        .then(async () => {
          throwIfCancelled(signal);
          await mkdir(dirname(filePath), { recursive: true });
          const lockPath = `${filePath}.lock`;
          let lock: Awaited<ReturnType<typeof open>> | undefined;
          for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
            throwIfCancelled(signal);
            try {
              lock = await open(lockPath, "wx", 0o600);
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              if (attempt === lockAttempts - 1) throw new Error("Could not acquire the cost meter persistence lock", { cause: error });
              const lockAge = await stat(lockPath)
                .then((metadata) => Date.now() - metadata.mtimeMs)
                .catch(() => 0);
              if (await mayReclaimLock(lockPath, lockAge)) await unlink(lockPath).catch(() => {});
              await waitForLockRetry(signal);
            }
          }
          if (lock === undefined) throw new Error("Could not acquire the cost meter persistence lock");
          const lockOwner = JSON.stringify({ pid: process.pid, token: randomUUID() });
          let ownerWritten = false;
          try {
            await lock.writeFile(lockOwner, { encoding: "utf8" });
            ownerWritten = true;
            throwIfCancelled(signal);
            const diskEntries = await readCostEntries(filePath, entryLimit);
            throwIfCancelled(signal);
            const candidate = costEntryFor(diskEntries, snapshot, recordedAt);
            const key = `${candidate.sessionId}\0${todayKey(new Date(candidate.recordedAt))}`;
            const merged = new Map(diskEntries.map((entry) => [`${entry.sessionId}\0${todayKey(new Date(entry.recordedAt))}`, entry]));
            const existing = merged.get(key);
            if (
              existing === undefined ||
              candidate.recordedAt > existing.recordedAt ||
              (candidate.recordedAt === existing.recordedAt && candidate.sessionCost >= existing.sessionCost)
            )
              merged.set(key, candidate);
            const nextEntries = [...merged.values()].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt)).slice(0, entryLimit);
            const payload = JSON.stringify({ version: 2, entries: nextEntries } satisfies CostFile, null, 2);
            const temporary = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
            let renamed = false;
            try {
              await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx", signal });
              throwIfCancelled(signal);
              await rename(temporary, filePath);
              renamed = true;
              entries = nextEntries;
            } finally {
              if (!renamed) await unlink(temporary).catch(() => {});
            }
          } finally {
            try {
              await lock.close();
            } finally {
              if (ownerWritten) await releaseOwnedLock(lockPath, lockOwner);
              else await unlink(lockPath).catch(() => {});
            }
          }
        });
      await writeQueue;
    };
    const trackRecord = (operation: Promise<void>): Promise<void> => {
      pendingRecord = operation;
      void operation
        .then(
          () => {
            lastError = null;
          },
          (error: unknown) => {
            lastError = error instanceof Error ? error.message : String(error);
          },
        )
        .finally(() => {
          if (pendingRecord === operation) pendingRecord = undefined;
        });
      return operation;
    };
    const record = (snapshot: CostSnapshot, signal: AbortSignal): Promise<void> => trackRecord(persist(snapshot, new Date().toISOString(), signal));
    const readReport = async (signal: AbortSignal): Promise<CostMeterReport> => {
      const pending = pendingRecord;
      if (pending !== undefined) await waitForPromise(pending, signal);
      throwIfCancelled(signal);
      entries = await readCostEntries(filePath, entryLimit);
      throwIfCancelled(signal);
      return reportFor(entries, currentStats(), budgetValue, entryLimit, lastError);
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      if (event.type === "agent_end") {
        try {
          void record(currentStats(), lifecycle.signal).catch(() => undefined);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
    });
    const unregister = context.piTools.register(
      defineTool({
        name: "cost_report",
        label: "Cost report",
        description: "Inspect current-session, daily, and persisted local model cost usage with an optional daily budget.",
        promptSnippet: "inspect session and daily model cost usage",
        parameters: Type.Object(
          { refresh: Type.Optional(Type.Boolean({ description: "Record the current completed session before reporting" })) },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<CostMeterReport>> {
          const params = validateReportParameters(rawParams);
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([lifecycle.signal, signal]);
          throwIfCancelled(operationSignal);
          if (params.refresh) await record(currentStats(), operationSignal);
          const report = await readReport(operationSignal);
          return {
            content: [{ type: "text", text: `Today cost $${report.todayCost.toFixed(4)}; current session $${report.sessionCost.toFixed(4)}.` }],
            details: report,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "cost-meter-panel",
      pluginId: "@pi-harness/core/plugins/cost-meter",
      title: "Cost Meter",
      description: "查看当前会话、UTC 今日和历史成本，并监控每日预算。",
      icon: "¤",
      read: () => readReport(lifecycle.signal),
    });
    context.effect(() => () => {
      lifecycle.abort(new Error("Cost meter plugin was disposed"));
      unsubscribe();
      unregister();
      disposePanel();
    });
  },
};
