import { lstat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "../config.js";
import { resolveExistingWorkspacePath } from "../workspace-path.js";

type BlobCell = { type: "blob"; bytes: number; previewBase64: string; truncated: boolean };
type SqlCell = null | string | number | BlobCell;
type SqlReport = {
  database: string;
  query: string;
  columns: string[];
  rows: Record<string, SqlCell>[];
  truncated: boolean;
  scannedRows: number;
};
type SqlStatus = { state: "idle" | "running" | "completed" | "failed" | "cancelled"; at?: string; error?: string };
type SqlParameters = { database: string; query: string };
type WorkerResponse = { ok: true; report: Pick<SqlReport, "columns" | "rows" | "truncated" | "scannedRows"> } | { ok: false; error: string };

const defaultDatabase = "data.db";
const defaultQuery = "SELECT name, type FROM sqlite_master ORDER BY type, name";
const defaultTimeoutMs = 5_000;
const maxQueryLength = 65_536;
const maxDatabasePathLength = 4_096;
const maxDatabaseBytes = 256 * 1024 * 1024;
const maxRows = 100;
const maxColumns = 128;
const maxStringLength = 16_384;
const maxResultBytes = 1024 * 1024;
const maxBlobPreviewBytes = 256;
const maxPanelRows = 20;
const maxErrorLength = 2_000;
const parameterNames = new Set(["database", "query"]);
const unsafeUnicode = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

export interface SqlLensPluginConfig {
  timeoutMs?: number;
}

export const Config: z<SqlLensPluginConfig> = z.object({ timeoutMs: z.number().min(100).max(30_000).step(1).default(defaultTimeoutMs) });

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(100, Math.min(30_000, Math.trunc(value))) : defaultTimeoutMs;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("SQL Lens operation was cancelled", { cause: signal.reason });
}

function rejectionError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
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
  if (message === undefined) return "Unknown SQL Lens error";
  let output = "";
  let outputBytes = 0;
  let outputCharacters = 0;
  for (const character of message) {
    const safe = unsafeUnicode.test(character) ? " " : character;
    const bytes = Buffer.byteLength(safe, "utf8");
    if (outputCharacters >= maxErrorLength || outputBytes + bytes > maxErrorLength) break;
    output += safe;
    outputBytes += bytes;
    outputCharacters += 1;
  }
  return output.trim() || "Unknown SQL Lens error";
}

function publicError(error: unknown): Error {
  const message = boundedError(error);
  return new Error(message === "Unknown SQL Lens error" ? "SQL Lens operation failed" : message, { cause: error });
}

function cloneReport(report: SqlReport): SqlReport {
  return structuredClone(report);
}

function panelReport(report: SqlReport) {
  const cloned = cloneReport(report);
  const rows = cloned.rows.slice(0, maxPanelRows);
  return {
    ...cloned,
    rows,
    rowInventory: {
      scanned: cloned.scannedRows,
      returned: cloned.rows.length,
      shown: rows.length,
      truncated: cloned.truncated || rows.length !== cloned.rows.length,
      displayLimit: maxPanelRows,
    },
  };
}

function dataObject(value: unknown, label: string): PropertyDescriptorMap {
  if (value === null || typeof value !== "object") throw new Error(`${label} must be a plain object`);
  let descriptors: PropertyDescriptorMap;
  let prototype: unknown;
  let array: boolean;
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

function assertConfig(config: unknown): asserts config is SqlLensPluginConfig {
  const descriptors = dataObject(config, "SQL Lens config");
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) throw new Error("Unknown SQL Lens config key: symbol");
  assertKnownConfigKeys("SQL Lens", config, ["timeoutMs"]);
  const timeout: unknown = descriptors.timeoutMs?.value;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000))
    throw new Error("SQL Lens timeoutMs must be an integer between 100 and 30000");
}

function sqlParameters(value: unknown): SqlParameters {
  const descriptors = dataObject(value, "SQL Lens parameters");
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !parameterNames.has(key)))
    throw new Error("SQL Lens parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("SQL Lens parameters must use data properties");
  const databaseValue: unknown = descriptors.database?.value;
  const queryValue: unknown = descriptors.query?.value;
  const database: unknown = databaseValue === undefined ? defaultDatabase : databaseValue;
  const query: unknown = queryValue === undefined ? defaultQuery : queryValue;
  if (typeof database !== "string") throw new Error("SQL Lens database must be a string");
  if (typeof query !== "string") throw new Error("SQL Lens query must be a string");
  if (database.includes("\0")) throw new Error("SQL Lens database must not contain NUL characters");
  if (query.includes("\0")) throw new Error("SQL Lens query must not contain NUL characters");
  if (database.length === 0 || database.length > maxDatabasePathLength) throw new Error(`SQL Lens database must contain 1-${maxDatabasePathLength} characters`);
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0 || normalizedQuery.length > maxQueryLength) throw new Error(`SQL Lens query must contain 1-${maxQueryLength} characters`);
  return { database, query: normalizedQuery };
}

function workerUrl(): URL {
  return new URL(import.meta.url.endsWith(".ts") ? "./sql-lens-worker.ts" : "./sql-lens-worker.js", import.meta.url);
}

async function inspectDatabaseFiles(database: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const metadata = await lstat(database);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Database path must be a regular file");
  let totalBytes = metadata.size;
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    let sidecar: Awaited<ReturnType<typeof lstat>>;
    try {
      sidecar = await lstat(database + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (sidecar.isSymbolicLink()) throw new Error(`SQLite sidecar ${suffix} must not be a symbolic link`);
    if (!sidecar.isFile()) throw new Error(`SQLite sidecar ${suffix} must be a regular file`);
    totalBytes += sidecar.size;
  }
  if (totalBytes > maxDatabaseBytes) throw new Error(`Database and sidecar files exceed the ${maxDatabaseBytes}-byte limit`);
  return metadata;
}

function runSqlWorker(
  input: {
    database: string;
    query: string;
    device: number | bigint;
    inode: number | bigint;
    limits: { databaseBytes: number; rows: number; columns: number; stringLength: number; resultBytes: number; blobPreviewBytes: number };
  },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Pick<SqlReport, "columns" | "rows" | "truncated" | "scannedRows">> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl(), { workerData: input });
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      reject(rejectionError(error, "SQL Lens worker failed"));
    };
    const onAbort = (): void => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        fail(error);
      }
    };
    const timer = setTimeout(() => fail(new Error(`SQL Lens query timed out after ${timeoutMs}ms`)), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: WorkerResponse) => {
      if (settled) return;
      if (!message.ok) {
        fail(new Error(message.error));
        return;
      }
      settled = true;
      cleanup();
      resolve(message.report);
    });
    worker.once("error", fail);
    worker.once("exit", (code) => {
      if (code !== 0) fail(new Error(`SQL Lens worker exited with code ${code}`));
      else if (!settled) fail(new Error("SQL Lens worker exited without a result"));
    });
  });
}

export default {
  name: "pi-sql-lens",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: SqlLensPluginConfig) {
    assertConfig(config);
    const timeoutMs = normalizeTimeout(config.timeoutMs);
    const lifecycle = new AbortController();
    let latest: SqlReport | undefined;
    let status: SqlStatus = { state: "idle" };
    let unregisterTool: () => void = () => undefined;
    let disposePanel: () => void = () => undefined;
    try {
      unregisterTool = context.piTools.register(
        defineTool({
          name: "sql_readonly",
          label: "SQL read-only",
          description: "Inspect a workspace SQLite database through a bounded, timed, read-only query worker.",
          promptSnippet: "inspect a local SQLite database without writes",
          parameters: Type.Object(
            {
              database: Type.Optional(Type.String({ description: "SQLite path relative to workspace" })),
              query: Type.Optional(Type.String({ description: "One result-producing SELECT, WITH, or read-only PRAGMA statement" })),
            },
            { additionalProperties: false },
          ),
          executionMode: "sequential",
          async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<SqlReport>> {
            const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            status = { state: "running" };
            try {
              throwIfAborted(operationSignal);
              const params = sqlParameters(rawParams);
              const resolved = await resolveExistingWorkspacePath(
                context.piHarnessLaunch.cwd,
                params.database,
                "Database path must stay inside the current workspace",
              );
              throwIfAborted(operationSignal);
              const metadata = await inspectDatabaseFiles(resolved.target);
              const workerReport = await runSqlWorker(
                {
                  database: resolved.target,
                  query: params.query,
                  device: metadata.dev,
                  inode: metadata.ino,
                  limits: {
                    databaseBytes: maxDatabaseBytes,
                    rows: maxRows,
                    columns: maxColumns,
                    stringLength: maxStringLength,
                    resultBytes: maxResultBytes,
                    blobPreviewBytes: maxBlobPreviewBytes,
                  },
                },
                timeoutMs,
                operationSignal,
              );
              throwIfAborted(operationSignal);
              const report: SqlReport = { database: resolved.relativePath, query: params.query, ...workerReport };
              latest = cloneReport(report);
              status = { state: "completed", at: new Date().toISOString() };
              return {
                content: [{ type: "text", text: `${report.database}: ${report.rows.length} row(s) returned${report.truncated ? " (truncated)" : ""}.` }],
                details: cloneReport(report),
              };
            } catch (error) {
              status = {
                state: operationSignal.aborted ? "cancelled" : "failed",
                at: new Date().toISOString(),
                error: boundedError(error),
              };
              throw publicError(error);
            }
          },
        }),
      );
      disposePanel = context.piPluginUi.register({
        id: "sql-lens-panel",
        pluginId: "@pi-harness/core/plugins/sql-lens",
        title: "SQL Lens",
        description: "以只读模式浏览 SQLite 数据库 Schema 和查询结果。",
        icon: "⌗",
        read: () => ({
          latest: latest === undefined ? null : panelReport(latest),
          status: { ...status },
          timeoutMs,
          limits: {
            queryLength: maxQueryLength,
            databaseBytes: maxDatabaseBytes,
            rows: maxRows,
            columns: maxColumns,
            stringLength: maxStringLength,
            resultBytes: maxResultBytes,
            blobPreviewBytes: maxBlobPreviewBytes,
            panelRows: maxPanelRows,
          },
        }),
      });
    } catch (error) {
      disposePanel();
      unregisterTool();
      lifecycle.abort(new Error("SQL Lens plugin registration failed"));
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("SQL Lens plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
