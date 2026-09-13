import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {} from "@pi-harness/plugin-api";

const defaultApiUrl = "https://api.github.com";
const defaultLimit = 10;
const defaultTimeoutMs = 15_000;
const maxLimit = 25;
const maxQueryLength = 80;
const maxResponseBytes = 1024 * 1024;
const maxModelBytes = 128 * 1024;
const radarTopics = ["topic:pi-harness", "topic:pi-harness-plugin"];
const queryParameterNames = new Set(["query"]);

export interface PluginRadarConfig {
  apiUrl?: string;
  limit?: number;
  timeoutMs?: number;
}

export const Config: z<PluginRadarConfig> = z.object({
  apiUrl: z.string().default(defaultApiUrl),
  limit: z.number().default(defaultLimit),
  timeoutMs: z.number().default(defaultTimeoutMs),
});

export interface PluginRadarResult {
  name: string;
  fullName: string;
  url: string;
  description: string;
  stars: number;
  language: string | null;
  updatedAt: string;
  topics: string[];
}

export interface PluginRadarReport {
  query: string;
  total: number;
  results: PluginRadarResult[];
  fetchedAt: string;
  sources: string[];
  truncated: boolean;
}

function normalizeApiUrl(url: string | undefined): string {
  const raw = (url ?? defaultApiUrl).trim();
  if (raw.includes("?") || raw.includes("#")) throw new Error("GitHub API URL must not include a query or fragment");
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error("GitHub API URL must be a valid HTTPS URL");
  }
  if (value.protocol !== "https:") throw new Error("GitHub API URL must use HTTPS");
  if (value.username !== "" || value.password !== "") throw new Error("GitHub API URL must not include credentials");
  if (value.search !== "" || value.hash !== "") throw new Error("GitHub API URL must not include a query or fragment");
  return `${value.origin}${value.pathname.replace(/\/+$/u, "")}`;
}

function normalizeQuery(value: string): string {
  const query = value.trim();
  if (query.length > maxQueryLength) throw new Error(`Plugin radar query must contain 0-${maxQueryLength} characters`);
  return query;
}

function queryParameter(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin radar parameters must be an object");
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Plugin radar parameters must be a plain object");
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof Error && error.message === "Plugin radar parameters must be a plain object") throw error;
    throw new Error("Plugin radar parameters must be an accessible plain object", { cause: error });
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !queryParameterNames.has(key)))
    throw new Error("Plugin radar parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Plugin radar parameters must use data properties");
  const query: unknown = descriptors.query?.value;
  if (query === undefined) return "";
  if (typeof query !== "string") throw new Error("Plugin radar query must be a string");
  return query;
}

function clampLimit(value: number | undefined): number {
  return Math.max(1, Math.min(maxLimit, Math.trunc(value !== undefined && Number.isFinite(value) ? value : defaultLimit)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function asTopics(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 12) : [];
}

function modelText(report: PluginRadarReport): string {
  const complete = JSON.stringify(report);
  if (Buffer.byteLength(complete, "utf8") <= maxModelBytes) return complete;
  const bounded = (value: string, maximum: number): string => {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length <= maximum) return value;
    let end = maximum;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    return bytes.subarray(0, end).toString("utf8");
  };
  const results = report.results.map((item) => ({
    ...item,
    name: bounded(item.name, 256),
    fullName: bounded(item.fullName, 512),
    url: bounded(item.url, 2_048),
    description: bounded(item.description, 4_096),
    language: item.language === null ? null : bounded(item.language, 128),
    updatedAt: bounded(item.updatedAt, 128),
    topics: item.topics.map((topic) => bounded(topic, 128)),
  }));
  const text = () => JSON.stringify({ ...report, total: results.length, results, truncated: true, metadataTruncated: true });
  while (Buffer.byteLength(text(), "utf8") > maxModelBytes && results.length > 0) results.pop();
  return text();
}

function parseResults(payload: unknown): { results: PluginRadarResult[]; truncated: boolean } {
  const root = asRecord(payload);
  if (
    root === undefined ||
    !Array.isArray(root.items) ||
    typeof root.total_count !== "number" ||
    !Number.isSafeInteger(root.total_count) ||
    root.total_count < 0 ||
    (root.incomplete_results !== undefined && typeof root.incomplete_results !== "boolean")
  )
    throw new Error("GitHub plugin radar returned an invalid response structure");
  const items = root.items;
  const results = items.flatMap((entry): PluginRadarResult[] => {
    const item = asRecord(entry);
    if (item === undefined) return [];
    const fullName = asString(item.full_name, "").trim();
    const name = asString(item.name, "").trim();
    const url = asString(item.html_url, "").trim();
    if (fullName === "" || name === "" || !/^https:\/\/github\.com\//iu.test(url)) return [];
    return [
      {
        name,
        fullName,
        url,
        description: asString(item.description, ""),
        stars: asNonNegativeInteger(item.stargazers_count),
        language: typeof item.language === "string" ? item.language : null,
        updatedAt: asString(item.updated_at, ""),
        topics: asTopics(item.topics),
      },
    ];
  });
  return { results, truncated: root.total_count > items.length || root.incomplete_results === true };
}

function cancelResponseBody(response: Response): void {
  try {
    void Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
  } catch {
    // Cleanup is best effort and must not hide the primary response error.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // Cleanup is best effort and must not hide cancellation.
  }
}

async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    cancelResponseBody(response);
    throw new Error("GitHub plugin radar response exceeded 1 MiB limit");
  }
  if (response.body === null) throw new Error("GitHub plugin radar returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const readChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (signal?.aborted === true) {
      cancelReader(reader);
      throw new Error("Plugin radar response read was cancelled", { cause: signal.reason });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        cancelReader(reader);
        reject(new Error("Plugin radar response read was cancelled", { cause: signal?.reason }));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      void Promise.resolve()
        .then(() => reader.read())
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error("Plugin radar response read failed", { cause: error }));
          },
        );
    });
  };
  try {
    while (true) {
      const next = await readChunk();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxResponseBytes) {
        cancelReader(reader);
        throw new Error("GitHub plugin radar response exceeded 1 MiB limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch (error) {
    throw new Error("GitHub plugin radar response must contain valid UTF-8", { cause: error });
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`GitHub plugin radar returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function searchPlugins(apiUrl: string, limit: number, timeoutMs: number, rawQuery: string, signal?: AbortSignal): Promise<PluginRadarReport> {
  const query = normalizeQuery(rawQuery);
  if (signal?.aborted === true) throw new Error("Plugin radar request was cancelled", { cause: signal.reason });
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  const keyword = query.replaceAll('"', "");
  let batches: { results: PluginRadarResult[]; truncated: boolean }[];
  try {
    batches = await Promise.all(
      radarTopics.map(async (topic) => {
        const search = new URLSearchParams({
          q: keyword === "" ? topic : `${topic} "${keyword}"`,
          sort: "stars",
          order: "desc",
          per_page: String(limit),
        });
        const response = await fetch(`${apiUrl}/search/repositories?${search.toString()}`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "pi-harness-plugin-radar", "x-github-api-version": "2022-11-28" },
          signal: controller.signal,
        });
        if (!response.ok) {
          cancelResponseBody(response);
          throw new Error(`GitHub plugin radar returned HTTP ${response.status}`);
        }
        return parseResults(await readJson(response, controller.signal));
      }),
    );
  } catch (error) {
    if (timedOut) throw new Error(`Plugin radar request timed out after ${timeoutMs} ms`, { cause: error });
    if (controller.signal.aborted) throw new Error("Plugin radar request was cancelled", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
    controller.abort();
  }
  const unique = new Map<string, PluginRadarResult>();
  for (const item of batches.flatMap((batch) => batch.results)) {
    const key = item.fullName.toLowerCase();
    const current = unique.get(key);
    if (current === undefined || item.stars > current.stars) unique.set(key, item);
  }
  const results = [...unique.values()].sort((left, right) => right.stars - left.stars || left.fullName.localeCompare(right.fullName)).slice(0, limit);
  return {
    query,
    total: results.length,
    results,
    fetchedAt: new Date().toISOString(),
    sources: [...radarTopics],
    truncated: batches.some((batch) => batch.truncated) || unique.size > limit,
  };
}

export default {
  name: "pi-plugin-radar",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: PluginRadarConfig) {
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
    const apiUrl = normalizeApiUrl(config.apiUrl);
    const limit = clampLimit(config.limit);
    const timeoutMs = Math.max(
      1_000,
      Math.min(60_000, Math.trunc(config.timeoutMs !== undefined && Number.isFinite(config.timeoutMs) ? config.timeoutMs : defaultTimeoutMs)),
    );
    let latest: PluginRadarReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "plugin_radar_search",
        label: "Search Pi Harness plugins",
        description:
          "Search GitHub for repositories tagged pi-harness or pi-harness-plugin, sorted by stars. Topic matching does not verify plugin installability. Read-only; never installs packages.",
        promptSnippet: "find popular Pi Harness plugins on GitHub",
        parameters: Type.Object(
          {
            query: Type.Optional(Type.String({ description: "Capability or repository keywords; empty searches the full Pi Harness ecosystem" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<PluginRadarReport>> {
          const combined = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          if (combined.aborted) throw new Error("Plugin radar request was cancelled", { cause: combined.reason });
          const report = await searchPlugins(apiUrl, limit, timeoutMs, queryParameter(params), combined);
          if (combined.aborted) throw new Error("Plugin radar request was cancelled", { cause: combined.reason });
          latest = report;
          const text = modelText(latest);
          return { content: [{ type: "text", text }], details: structuredClone(latest) };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "plugin-radar-panel",
        pluginId: "@pi-harness/plugin-plugin-radar",
        title: "Plugin Radar",
        description: "只读发现 GitHub 上的 Pi Harness 插件，按 Star 排序，不会自动安装代码。",
        icon: "⌁",
        read: () => ({
          apiUrl,
          limit,
          timeoutMs,
          query: latest?.query ?? null,
          total: latest?.total ?? 0,
          fetchedAt: latest?.fetchedAt ?? null,
          sources: [...(latest?.sources ?? radarTopics)],
          results: structuredClone(latest?.results ?? []),
          truncated: latest?.truncated ?? false,
        }),
      });
    } catch (error) {
      unregisterTool();
      throw error;
    }
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
