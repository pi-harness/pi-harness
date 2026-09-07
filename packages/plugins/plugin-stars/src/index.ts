import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {} from "@pi-harness/plugin-api";

const defaultSourceUrl = "https://raw.githubusercontent.com/ywsldxk/dsh-plugin-stars/main/data/plugins.json";
const maxResponseBytes = 2 * 1024 * 1024;
const maxQueryLength = 120;
const maxLimit = 50;
const maxSourceUrlLength = 2_048;
const maxInventoryItems = 1_000;
const maxPanelItems = 20;
const queryParameterNames = new Set(["query"]);

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
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function queryParameter(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin stars parameters must be an object");
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Plugin stars parameters must be a plain object");
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof Error && error.message === "Plugin stars parameters must be a plain object") throw error;
    throw new Error("Plugin stars parameters must be an accessible plain object", { cause: error });
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !queryParameterNames.has(key)))
    throw new Error("Plugin stars parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Plugin stars parameters must use data properties");
  const query: unknown = descriptors.query?.value as unknown;
  if (query === undefined) return "";
  if (typeof query !== "string") throw new Error("Plugin stars query must be a string");
  const normalized = query.trim();
  if (normalized.length > maxQueryLength) throw new Error(`Plugin stars query must contain 0-${maxQueryLength} characters`);
  return normalized;
}

function entryText(value: unknown, index: number, field: string, maximum: number, required = false): string {
  if (typeof value !== "string") throw new Error(`Plugin stars plugin ${index} ${field} must be a string`);
  const normalized = value.trim();
  if (required && normalized === "") throw new Error(`Plugin stars plugin ${index} ${field} must not be empty`);
  if (normalized.length > maximum) throw new Error(`Plugin stars plugin ${index} ${field} cannot exceed ${maximum} characters`);
  if (normalized.includes("\0")) throw new Error(`Plugin stars plugin ${index} ${field} must not contain NUL characters`);
  return normalized;
}

function entryTopics(value: unknown, index: number): string[] {
  if (!Array.isArray(value)) throw new Error(`Plugin stars plugin ${index} topics must be an array`);
  if (value.length > 24) throw new Error(`Plugin stars plugin ${index} topics cannot exceed 24 items`);
  return value.map((topic, topicIndex) => entryText(topic, index, `topic ${topicIndex + 1}`, 64, true));
}

function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

function normalizedEntry(value: unknown, index: number): PluginStarsEntry {
  const item = record(value);
  if (item === undefined) throw new Error(`Plugin stars plugin ${index} must be an object`);
  const id = entryText(item.id, index, "ID", 64, true);
  const name = entryText(item.name, index, "name", 256, true);
  const fullName = entryText(item.fullName, index, "fullName", 512, true);
  if (!/^[^/\s]+\/[^/\s]+$/u.test(fullName)) throw new Error(`Plugin stars plugin ${index} fullName must be an owner/repository pair`);
  const htmlUrl = entryText(item.htmlUrl, index, "repository URL", 4_096, true);
  let repositoryUrl: URL;
  try {
    repositoryUrl = new URL(htmlUrl);
  } catch {
    throw new Error(`Plugin stars plugin ${index} repository URL is invalid`);
  }
  const repositoryPath = repositoryUrl.pathname.replace(/\/$/u, "");
  if (
    repositoryUrl.protocol !== "https:" ||
    repositoryUrl.hostname.toLowerCase() !== "github.com" ||
    repositoryUrl.port !== "" ||
    repositoryUrl.username !== "" ||
    repositoryUrl.password !== "" ||
    repositoryUrl.search !== "" ||
    repositoryUrl.hash !== "" ||
    repositoryPath.toLowerCase() !== `/${fullName}`.toLowerCase()
  )
    throw new Error(`Plugin stars plugin ${index} repository URL must be an uncredentialed GitHub URL matching fullName`);
  if (typeof item.stars !== "number" || !Number.isSafeInteger(item.stars) || item.stars < 0)
    throw new Error(`Plugin stars plugin ${index} stars must be a non-negative safe integer`);
  const stars = item.stars;
  const updatedAt = entryText(item.updatedAt, index, "updatedAt", 64, true);
  if (!isIsoTimestamp(updatedAt)) throw new Error(`Plugin stars plugin ${index} updatedAt must be an ISO timestamp`);
  const homepage = item.homepage === undefined ? "" : entryText(item.homepage, index, "homepage", 4_096);
  const npmName = item.npmName === undefined ? "" : entryText(item.npmName, index, "npmName", 256);
  const license = item.license === undefined ? "" : entryText(item.license, index, "license", 64);
  return {
    id,
    name,
    fullName,
    description: item.description === undefined ? "" : entryText(item.description, index, "description", 4_096),
    htmlUrl,
    ...(homepage === "" ? {} : { homepage }),
    ...(npmName === "" ? {} : { npmName }),
    stars,
    updatedAt,
    ...(license === "" ? {} : { license }),
    topics: entryTopics(item.topics, index),
  };
}

export function parsePluginStarsPayload(payload: unknown): { source: string; generatedAt: string; plugins: PluginStarsEntry[] } {
  const root = record(payload);
  if (root === undefined || !Array.isArray(root.plugins)) throw new Error("Plugin stars ranking must be an object with a plugins array");
  if (typeof root.source !== "string") throw new Error("Plugin stars source must be a string");
  const source = root.source.trim();
  if (source === "" || source.length > 256) throw new Error("Plugin stars source must contain 1-256 characters");
  if (source.includes("\0")) throw new Error("Plugin stars source must not contain NUL characters");
  if (typeof root.generatedAt !== "string") throw new Error("Plugin stars generatedAt must be a string");
  const generatedAt = root.generatedAt.trim();
  if (generatedAt.length > 64 || !isIsoTimestamp(generatedAt))
    throw new Error("Plugin stars generatedAt must be a valid ISO timestamp of at most 64 characters");
  if (root.plugins.length > maxInventoryItems) throw new Error(`Plugin stars inventory cannot exceed ${maxInventoryItems} plugins`);
  const plugins = root.plugins.map((item, index) => normalizedEntry(item, index + 1));
  const ids = new Set<string>();
  const repositories = new Set<string>();
  for (const plugin of plugins) {
    const repository = plugin.fullName.toLowerCase();
    if (ids.has(plugin.id) || repositories.has(repository)) throw new Error(`Plugin stars ranking contains a duplicate plugin: ${plugin.fullName}`);
    ids.add(plugin.id);
    repositories.add(repository);
  }
  return { source, generatedAt, plugins };
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
  if (raw.length === 0 || raw.length > maxSourceUrlLength) throw new Error(`Plugin stars source URL must contain 1-${maxSourceUrlLength} characters`);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Plugin stars source URL is invalid");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error("Plugin stars source URL must be HTTPS without credentials");
  if (url.hostname.toLowerCase() !== "raw.githubusercontent.com" || url.port !== "")
    throw new Error("Plugin stars source URL must use https://raw.githubusercontent.com");
  return url.toString();
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel?.();
  } catch {
    // Cleanup is best effort while preserving the original protocol error.
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    await cancelResponseBody(response);
    throw new Error("Plugin stars source exceeded the 2 MiB limit");
  }
  if (response.body === null) throw new Error("Plugin stars source returned an empty response");
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
        throw new Error("Plugin stars source exceeded the 2 MiB limit");
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
    throw new Error("Plugin stars source must contain valid UTF-8", { cause: error });
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`Plugin stars source returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function fetchReport(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ source: string; generatedAt: string; plugins: PluginStarsEntry[] }> {
  if (signal?.aborted === true) throw new Error("Plugin stars request was cancelled", { cause: signal.reason });
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { accept: "application/json", "user-agent": "pi-harness-plugin-stars" },
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`Plugin stars source returned HTTP ${response.status}`);
    }
    return parsePluginStarsPayload(await readBoundedJson(response));
  } catch (error) {
    if (timedOut) throw new Error(`Plugin stars request timed out after ${timeoutMs} ms`, { cause: error });
    if (controller.signal.aborted) throw new Error("Plugin stars request was cancelled", { cause: error });
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
  sourceUrl: z.string().min(1).max(maxSourceUrlLength).default(defaultSourceUrl),
  limit: z.number().min(1).max(maxLimit).step(1).default(10),
  timeoutMs: z.number().min(1_000).max(60_000).step(1).default(15_000),
});

export default {
  name: "pi-plugin-stars",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: PluginStarsConfig) {
    const source = sourceUrl(config.sourceUrl ?? defaultSourceUrl);
    const limit = Math.max(1, Math.min(maxLimit, Math.trunc(config.limit ?? 10)));
    const timeoutMs = Math.max(1_000, Math.min(60_000, Math.trunc(config.timeoutMs ?? 15_000)));
    const lifecycle = new AbortController();
    const executionSignal = (signal?: AbortSignal): AbortSignal => (signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]));
    let latest: PluginStarsReport | undefined;
    let unregister: () => void = () => undefined;
    let disposePanel: () => void = () => undefined;
    try {
      unregister = context.piTools.register(
        defineTool({
          name: "plugin_stars_search",
          label: "Plugin Stars",
          description: "Read the curated DSH Plugin Stars ranking, filter it locally, and return sorted repository evidence. Never installs plugins.",
          promptSnippet: "search the curated DSH plugin ranking",
          parameters: Type.Object(
            {
              query: Type.Optional(Type.String({ description: "Plugin name, repository, capability, or topic", maxLength: maxQueryLength })),
            },
            { additionalProperties: false },
          ),
          executionMode: "sequential",
          async execute(_toolCallId, params, signal): Promise<AgentToolResult<PluginStarsReport>> {
            const query = queryParameter(params);
            const payload = await fetchReport(source, timeoutMs, executionSignal(signal));
            const matches = searchPluginStars(payload, query);
            const results = matches.slice(0, limit);
            latest = { source: payload.source, generatedAt: payload.generatedAt, total: matches.length, query, results, fetchedAt: new Date().toISOString() };
            return {
              content: [
                {
                  type: "text",
                  text:
                    results.map((entry, index) => `${index + 1}. ${entry.fullName} · ${entry.stars} stars\n${entry.htmlUrl}`).join("\n\n") ||
                    "No ranked plugins matched.",
                },
              ],
              details: structuredClone(latest),
            };
          },
        }),
      );
      disposePanel = context.piPluginUi.register({
        id: "plugin-stars-panel",
        pluginId: "@pi-harness/plugin-plugin-stars",
        title: "Plugin Stars",
        description: "读取 dsh-plugin-stars 策展榜单，按 Star 和关键词查看社区插件，不自动安装。",
        icon: "★",
        read: () => {
          const panelResults = structuredClone(latest?.results.slice(0, maxPanelItems) ?? []);
          return {
            source,
            limit,
            timeoutMs,
            latest: latest === undefined ? null : { ...structuredClone(latest), results: panelResults },
            inventory: {
              total: latest?.total ?? 0,
              shown: panelResults.length,
              truncated: (latest?.total ?? 0) > panelResults.length,
            },
            limits: {
              responseBytes: maxResponseBytes,
              sourceItems: maxInventoryItems,
              resultItems: limit,
              panelItems: maxPanelItems,
              queryCharacters: maxQueryLength,
              timeoutMs,
            },
          };
        },
      });
    } catch (error) {
      unregister();
      disposePanel();
      lifecycle.abort(new Error("Plugin stars plugin registration failed"));
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Plugin stars plugin disposed"));
      unregister();
      disposePanel();
    });
  },
};
