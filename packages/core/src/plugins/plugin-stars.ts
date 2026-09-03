import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const defaultSourceUrl = "https://raw.githubusercontent.com/ywsldxk/dsh-plugin-stars/main/data/plugins.json";
const maxResponseBytes = 2 * 1024 * 1024;
const maxQueryLength = 120;
const maxLimit = 50;

export interface PluginStarsEntry {
  id: string;
  name: string;
  fullName: string;
  description: string;
  htmlUrl: string;
  homepage?: string;
  npmName?: string;
  stars: number;
  updatedAt: string;
  license?: string;
  topics: string[];
}

export interface PluginStarsReport {
  source: string;
  generatedAt: string;
  total: number;
  query: string;
  results: PluginStarsEntry[];
  fetchedAt: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : -1;
}

function topics(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .map((item) => item.trim())
        .slice(0, 24)
    : [];
}

function normalizedEntry(value: unknown): PluginStarsEntry | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  const id = text(item.id);
  const name = text(item.name);
  const fullName = text(item.fullName);
  const htmlUrl = text(item.htmlUrl);
  const stars = nonNegativeInteger(item.stars);
  if (id === "" || name === "" || !/^[^/\s]+\/[^/\s]+$/u.test(fullName) || !/^https:\/\/github\.com\//iu.test(htmlUrl) || stars < 0) return undefined;
  const homepage = text(item.homepage);
  const npmName = text(item.npmName);
  const license = text(item.license);
  return {
    id,
    name,
    fullName,
    description: text(item.description),
    htmlUrl,
    ...(homepage === "" ? {} : { homepage }),
    ...(npmName === "" ? {} : { npmName }),
    stars,
    updatedAt: text(item.updatedAt),
    ...(license === "" ? {} : { license }),
    topics: topics(item.topics),
  };
}

export function parsePluginStarsPayload(payload: unknown): { source: string; generatedAt: string; plugins: PluginStarsEntry[] } {
  const root = record(payload);
  const plugins = Array.isArray(root?.plugins)
    ? root.plugins.flatMap((item) => {
        const entry = normalizedEntry(item);
        return entry === undefined ? [] : [entry];
      })
    : [];
  return { source: text(root?.source) || "dsh-plugin-stars", generatedAt: text(root?.generatedAt), plugins };
}

export function searchPluginStars(report: { plugins: readonly PluginStarsEntry[] }, query = ""): PluginStarsEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length > maxQueryLength) throw new Error(`Plugin stars query must contain 0-${maxQueryLength} characters`);
  return [...report.plugins]
    .filter(
      (entry) => normalizedQuery === "" || [entry.name, entry.fullName, entry.description, ...entry.topics].join(" ").toLowerCase().includes(normalizedQuery),
    )
    .sort((left, right) => right.stars - left.stars || left.fullName.localeCompare(right.fullName));
}

function sourceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Plugin stars source URL is invalid");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error("Plugin stars source URL must be HTTPS without credentials");
  return url.toString();
}

async function fetchReport(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ source: string; generatedAt: string; plugins: PluginStarsEntry[] }> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": "pi-harness-plugin-stars" } });
    if (!response.ok) throw new Error(`Plugin stars source returned HTTP ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxResponseBytes) throw new Error("Plugin stars source exceeded the 2 MiB limit");
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch (error) {
      throw new Error(`Plugin stars source returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return parsePluginStarsPayload(payload);
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(signal?.aborted ? "Plugin stars request was cancelled" : `Plugin stars request timed out after ${timeoutMs} ms`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface PluginStarsConfig {
  sourceUrl?: string;
  limit?: number;
  timeoutMs?: number;
}

export const Config: z<PluginStarsConfig> = z.object({
  sourceUrl: z.string().default(defaultSourceUrl),
  limit: z.number().default(10),
  timeoutMs: z.number().default(15_000),
});

export default {
  name: "pi-plugin-stars",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: PluginStarsConfig) {
    const source = sourceUrl(config.sourceUrl ?? defaultSourceUrl);
    const limit = Math.max(1, Math.min(maxLimit, Math.trunc(config.limit ?? 10)));
    const timeoutMs = Math.max(1_000, Math.min(60_000, Math.trunc(config.timeoutMs ?? 15_000)));
    let latest: PluginStarsReport | undefined;
    const unregister = context.piTools.register(
      defineTool({
        name: "plugin_stars_search",
        label: "Plugin Stars",
        description: "Read the curated DSH Plugin Stars ranking, filter it locally, and return sorted repository evidence. Never installs plugins.",
        promptSnippet: "search the curated DSH plugin ranking",
        parameters: Type.Object({ query: Type.Optional(Type.String({ description: "Plugin name, repository, capability, or topic" })) }),
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<PluginStarsReport>> {
          const payload = await fetchReport(source, timeoutMs, signal);
          const query = params.query?.trim() ?? "";
          const results = searchPluginStars(payload, query).slice(0, limit);
          latest = { source: payload.source, generatedAt: payload.generatedAt, total: results.length, query, results, fetchedAt: new Date().toISOString() };
          return {
            content: [
              {
                type: "text",
                text:
                  results.map((entry, index) => `${index + 1}. ${entry.fullName} · ${entry.stars} stars\n${entry.htmlUrl}`).join("\n\n") ||
                  "No ranked plugins matched.",
              },
            ],
            details: latest,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "plugin-stars-panel",
      pluginId: "@pi-harness/core/plugins/plugin-stars",
      title: "Plugin Stars",
      description: "读取 dsh-plugin-stars 策展榜单，按 Star 和关键词查看社区插件，不自动安装。",
      icon: "★",
      read: () => ({ source, limit, timeoutMs, latest: latest ?? null }),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
