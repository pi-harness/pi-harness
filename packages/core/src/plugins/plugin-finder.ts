import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const defaultRegistryUrl = "https://registry.npmjs.org";
const defaultLimit = 10;
const maxQueryLength = 120;

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
}

export default {
  name: "pi-plugin-finder",
  inject: ["piPluginUi", "piTools"],
  apply(context: Context, config: PluginFinderConfig) {
    const registryUrl = normalizeRegistryUrl(config.registryUrl);
    const limit = Math.max(1, Math.min(25, Math.trunc(config.limit ?? defaultLimit)));
    let latest: PluginSearchReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "plugin_search",
        label: "Search plugins",
        description: "Search the configured npm registry for Cordis and Pi Harness plugins. This is read-only and never installs packages.",
        promptSnippet: "search the plugin registry for an extension",
        parameters: Type.Object({ query: Type.String({ description: "Plugin name or capability keywords" }) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<PluginSearchReport>> {
          const query = params.query.trim();
          if (query.length < 2 || query.length > maxQueryLength) throw new Error(`Plugin search query must contain 2-${maxQueryLength} characters`);
          const search = new URLSearchParams({ text: `keywords:cordis-plugin ${query}`, size: String(limit) });
          const response = await fetch(`${registryUrl}/-/v1/search?${search.toString()}`, { headers: { accept: "application/json" } });
          if (!response.ok) throw new Error(`Plugin registry returned HTTP ${response.status}`);
          const payload = (await response.json()) as { total?: unknown; objects?: unknown };
          const objects = Array.isArray(payload.objects) ? payload.objects : [];
          const results = objects.flatMap((entry): PluginSearchResult[] => {
            if (entry === null || typeof entry !== "object") return [];
            const item = entry as { package?: unknown; score?: unknown };
            if (item.package === null || typeof item.package !== "object") return [];
            const pkg = item.package as { name?: unknown; version?: unknown; description?: unknown; links?: unknown };
            if (typeof pkg.name !== "string" || typeof pkg.version !== "string") return [];
            const links = pkg.links !== null && typeof pkg.links === "object" ? (pkg.links as { npm?: unknown }) : {};
            const score = item.score !== null && typeof item.score === "object" ? (item.score as { final?: unknown }).final : undefined;
            return [
              {
                name: pkg.name,
                version: pkg.version,
                description: typeof pkg.description === "string" ? pkg.description : "",
                score: typeof score === "number" && Number.isFinite(score) ? score : 0,
                npm: typeof links.npm === "string" ? links.npm : `${registryUrl}/${pkg.name}`,
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
      pluginId: "@pi-harness/core/plugins/plugin-finder",
      title: "Plugin Finder",
      description: "只读搜索 npm Registry 中的 Cordis 插件，不会自动安装或执行未审核代码。",
      icon: "⌕",
      read: () => ({ registryUrl, limit, query: latest?.query ?? null, total: latest?.total ?? 0, results: latest?.results ?? [] }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
