import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {} from "@pi-harness/plugin-api";

const defaultRegistryUrl = "https://registry.npmjs.org";
const defaultSearchKeyword = "pi-harness";
const defaultLimit = 10;
const defaultTimeoutMs = 15_000;
const maxResponseBytes = 1024 * 1024;
const maxQueryLength = 120;
const maxKeywordLength = 64;
const queryParameterNames = new Set(["query"]);

type PluginSearchResult = { name: string; version: string; description: string; score: number; npm: string };
type PluginSearchReport = { query: string; total: number; results: PluginSearchResult[] };

function normalizeRegistryUrl(url: string | undefined): string {
  const value = (url ?? defaultRegistryUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//iu.test(value)) throw new Error("Plugin registry URL must use http or https");
  return value;
}

export interface PluginFinderConfig {
  registryUrl?: string;
  limit?: number;
  keyword?: string;
  timeoutMs?: number;
}

export const Config: z<PluginFinderConfig> = z.object({
  registryUrl: z.string().default(defaultRegistryUrl),
  limit: z.number().default(defaultLimit),
  keyword: z.string().default(defaultSearchKeyword),
  timeoutMs: z.number().default(defaultTimeoutMs),
});

function normalizeSearchKeyword(keyword: string | undefined): string {
  const value = (keyword ?? defaultSearchKeyword).trim();
  if (value.length > maxKeywordLength || /\s/iu.test(value) || !/^[a-z0-9][a-z0-9._-]*$/iu.test(value))
    throw new Error(`Plugin registry keyword must be 1-${maxKeywordLength} ASCII characters without whitespace`);
  return value;
}

function queryParameter(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin finder parameters must be an object");
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Plugin finder parameters must be a plain object");
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof Error && error.message === "Plugin finder parameters must be a plain object") throw error;
    throw new Error("Plugin finder parameters must be an accessible plain object", { cause: error });
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !queryParameterNames.has(key)))
    throw new Error("Plugin finder parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Plugin finder parameters must use data properties");
  const query: unknown = descriptors.query?.value;
  if (typeof query !== "string") throw new Error("Plugin finder query must be a string");
  return query;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel?.();
  } catch {
    // Response cleanup is best effort and must not hide the protocol error.
  }
}

async function readBoundedJson(response: Response): Promise<{ total?: unknown; objects?: unknown }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    await cancelResponseBody(response);
    throw new Error("Plugin registry response exceeded the 1 MiB limit");
  }
  if (response.body === null) throw new Error("Plugin registry returned an empty response");
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
        throw new Error("Plugin registry response exceeded the 1 MiB limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch (error) {
    throw new Error("Plugin registry response must contain valid UTF-8", { cause: error });
  }
  try {
    return JSON.parse(text) as { total?: unknown; objects?: unknown };
  } catch (error) {
    throw new Error(`Plugin registry returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function searchRegistry(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{ total?: unknown; objects?: unknown }> {
  if (signal?.aborted === true) throw new Error("Plugin search was cancelled");
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`Plugin registry returned HTTP ${response.status}`);
    }
    return await readBoundedJson(response);
  } catch (error) {
    if (timedOut) throw new Error(`Plugin search timed out after ${timeoutMs} ms`, { cause: error });
    if (controller.signal.aborted) throw new Error("Plugin search was cancelled", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export default {
  name: "pi-plugin-finder",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: PluginFinderConfig) {
    const registryUrl = normalizeRegistryUrl(config.registryUrl);
    const limit = Math.max(1, Math.min(25, Math.trunc(config.limit ?? defaultLimit)));
    const keyword = normalizeSearchKeyword(config.keyword);
    const timeoutMs = Math.max(1_000, Math.min(60_000, Math.trunc(config.timeoutMs ?? defaultTimeoutMs)));
    let latest: PluginSearchReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "plugin_search",
        label: "Search plugins",
        description: "Search the configured npm registry for Pi Harness plugins. This is read-only and never installs packages.",
        promptSnippet: "search the plugin registry for an extension",
        parameters: Type.Object({ query: Type.String({ description: "Plugin name or capability keywords" }) }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<PluginSearchReport>> {
          const query = queryParameter(params).trim();
          if (query.length < 2 || query.length > maxQueryLength) throw new Error(`Plugin search query must contain 2-${maxQueryLength} characters`);
          const search = new URLSearchParams({ text: `keywords:${keyword} ${query}`, size: String(limit) });
          const payload = await searchRegistry(`${registryUrl}/-/v1/search?${search.toString()}`, timeoutMs, signal);
          const objects = Array.isArray(payload.objects) ? payload.objects : [];
          const results = objects.slice(0, limit).flatMap((entry): PluginSearchResult[] => {
            if (entry === null || typeof entry !== "object") return [];
            const item = entry as { package?: unknown; score?: unknown };
            if (item.package === null || typeof item.package !== "object") return [];
            const pkg = item.package as { name?: unknown; version?: unknown; description?: unknown; links?: unknown };
            if (typeof pkg.name !== "string" || typeof pkg.version !== "string") return [];
            const links = pkg.links !== null && typeof pkg.links === "object" ? (pkg.links as { npm?: unknown }) : {};
            const score = item.score !== null && typeof item.score === "object" ? (item.score as { final?: unknown }).final : undefined;
            const name = pkg.name.slice(0, 256);
            return [
              {
                name,
                version: pkg.version.slice(0, 128),
                description: typeof pkg.description === "string" ? pkg.description.slice(0, 4_096) : "",
                score: typeof score === "number" && Number.isFinite(score) ? score : 0,
                npm: typeof links.npm === "string" ? links.npm.slice(0, 4_096) : `${registryUrl}/${name}`,
              },
            ];
          });
          latest = { query, total: typeof payload.total === "number" && Number.isFinite(payload.total) ? payload.total : results.length, results };
          return {
            content: [
              {
                type: "text",
                text: results.length === 0 ? `No plugins found for ${query}.` : results.map((result) => `${result.name}@${result.version}`).join("\n"),
              },
            ],
            details: latest,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "plugin-finder-panel",
      pluginId: "@pi-harness/plugin-plugin-finder",
      title: "Plugin Finder",
      description: "只读搜索 npm Registry 中的 Pi Harness 插件，不会自动安装或执行未审核代码。",
      icon: "⌕",
      read: () => ({
        registryUrl,
        keyword,
        limit,
        timeoutMs,
        maxResponseBytes,
        query: latest?.query ?? null,
        total: latest?.total ?? 0,
        results: latest?.results ?? [],
      }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
