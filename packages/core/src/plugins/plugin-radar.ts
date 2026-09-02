import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const defaultApiUrl = "https://api.github.com";
const defaultLimit = 10;
const maxLimit = 25;
const maxQueryLength = 80;
const maxResponseBytes = 1024 * 1024;
const radarTopics = ["topic:dsh-plugin", "topic:deepseek-harness"];

export interface PluginRadarConfig {
  apiUrl?: string;
  limit?: number;
}

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
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > maxResponseBytes) throw new Error("GitHub plugin radar response exceeded 1 MiB limit");
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`GitHub plugin radar returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function searchPlugins(apiUrl: string, limit: number, rawQuery: string, signal?: AbortSignal): Promise<PluginRadarReport> {
  const query = normalizeQuery(rawQuery);
  const keyword = query.replaceAll('"', "");
  const batches = await Promise.all(
    radarTopics.map(async (topic) => {
      const search = new URLSearchParams({
        q: keyword === "" ? topic : `${topic} "${keyword}"`,
        sort: "stars",
        order: "desc",
        per_page: String(limit),
      });
      const response = await fetch(`${apiUrl}/search/repositories?${search.toString()}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "pi-harness-plugin-radar", "x-github-api-version": "2022-11-28" },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw new Error(`GitHub plugin radar returned HTTP ${response.status}`);
      return parseResults(await readJson(response)).results;
    }),
  );
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
  apply(context: Context, config: PluginRadarConfig) {
    const apiUrl = normalizeApiUrl(config.apiUrl);
    const limit = clampLimit(config.limit);
    let latest: PluginRadarReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "plugin_radar_search",
        label: "Search DSH plugins",
        description: "Search GitHub for DSH and DeepSeek Harness plugins, sorted by stars. Read-only; never installs packages.",
        promptSnippet: "find popular DSH plugins on GitHub",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Capability or repository keywords; empty searches the full DSH ecosystem" })),
        }),
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<PluginRadarReport>> {
          latest = await searchPlugins(apiUrl, limit, params.query ?? "", signal);
          const text =
            latest.results.length === 0 ? "No DSH plugins found." : latest.results.map((item) => `${item.fullName} (${item.stars} stars)`).join("\n");
          return { content: [{ type: "text", text }], details: latest };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "plugin-radar-panel",
      pluginId: "@pi-harness/core/plugins/plugin-radar",
      title: "Plugin Radar",
      description: "只读发现 GitHub 上的 DSH 插件，按 Star 排序，不会自动安装代码。",
      icon: "⌁",
      read: () => ({
        apiUrl,
        limit,
        query: latest?.query ?? null,
        total: latest?.total ?? 0,
        fetchedAt: latest?.fetchedAt ?? null,
        sources: latest?.sources ?? [...radarTopics],
        results: latest?.results ?? [],
      }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
