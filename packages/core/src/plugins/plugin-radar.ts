import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const defaultApiUrl = "https://api.github.com";
const defaultLimit = 10;
const defaultTimeoutMs = 15_000;
const maxLimit = 25;
const maxQueryLength = 80;
const maxResponseBytes = 1024 * 1024;
const radarTopics = ["topic:dsh-plugin", "topic:deepseek-harness"];
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
}

function normalizeApiUrl(url: string | undefined): string {
  const value = (url ?? defaultApiUrl).trim().replace(/\/+$/u, "");
  if (!/^https:\/\//iu.test(value)) throw new Error("GitHub API URL must use HTTPS");
  return value;
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
  return Math.max(1, Math.min(maxLimit, Math.trunc(value ?? defaultLimit)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function asTopics(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 12) : [];
}

function parseResults(payload: unknown): { total: number; results: PluginRadarResult[] } {
  const root = asRecord(payload);
  const items = root?.items;
  const results = Array.isArray(items)
    ? items.flatMap((entry): PluginRadarResult[] => {
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
      })
    : [];
  return { total: asNonNegativeInteger(root?.total_count) || results.length, results };
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    await response.body?.cancel?.();
    throw new Error("GitHub plugin radar response exceeded 1 MiB limit");
  }
  if (response.body === null) throw new Error("GitHub plugin radar returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
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
  let batches: PluginRadarResult[][];
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
        if (!response.ok) throw new Error(`GitHub plugin radar returned HTTP ${response.status}`);
        return parseResults(await readJson(response)).results;
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
  for (const item of batches.flat()) {
    const current = unique.get(item.fullName);
    if (current === undefined || item.stars > current.stars) unique.set(item.fullName, item);
  }
  const results = [...unique.values()].sort((left, right) => right.stars - left.stars || left.fullName.localeCompare(right.fullName)).slice(0, limit);
  return { query, total: results.length, results, fetchedAt: new Date().toISOString(), sources: [...radarTopics] };
}

export default {
  name: "pi-plugin-radar",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: PluginRadarConfig) {
    const apiUrl = normalizeApiUrl(config.apiUrl);
    const limit = clampLimit(config.limit);
    const timeoutMs = Math.max(1_000, Math.min(60_000, Math.trunc(config.timeoutMs ?? defaultTimeoutMs)));
    let latest: PluginRadarReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "plugin_radar_search",
        label: "Search DSH plugins",
        description: "Search GitHub for DSH and DeepSeek Harness plugins, sorted by stars. Read-only; never installs packages.",
        promptSnippet: "find popular DSH plugins on GitHub",
        parameters: Type.Object(
          {
            query: Type.Optional(Type.String({ description: "Capability or repository keywords; empty searches the full DSH ecosystem" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<PluginRadarReport>> {
          latest = await searchPlugins(apiUrl, limit, timeoutMs, queryParameter(params), signal);
          const text =
            latest.results.length === 0 ? "No DSH plugins found." : latest.results.map((item) => `${item.fullName} (${item.stars} stars)`).join("\n");
          return { content: [{ type: "text", text }], details: latest };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "plugin-radar-panel",
        pluginId: "@pi-harness/core/plugins/plugin-radar",
        title: "Plugin Radar",
        description: "只读发现 GitHub 上的 DSH 插件，按 Star 排序，不会自动安装代码。",
        icon: "⌁",
        read: () => ({
          apiUrl,
          limit,
          timeoutMs,
          query: latest?.query ?? null,
          total: latest?.total ?? 0,
          fetchedAt: latest?.fetchedAt ?? null,
          sources: latest?.sources ?? [...radarTopics],
          results: latest?.results ?? [],
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
