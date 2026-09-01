import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type PairReport = { base: string; target: string; baseKeys: number; targetKeys: number; missing: string[]; extra: string[] };

function workspaceFile(workspace: string, requested: string): string {
  const root = resolve(workspace);
  const target = resolve(root, requested);
  const path = relative(root, target);
  if (path.startsWith("..") || path.includes("/..")) throw new Error("Locale path must stay inside the current workspace");
  return target;
}

function flatten(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));
}

async function readLocale(workspace: string, requested: string): Promise<{ path: string; keys: Set<string> }> {
  const target = workspaceFile(workspace, requested);
  const source = await readFile(target, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid locale JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: relative(workspace, target) || ".", keys: new Set(flatten(parsed)) };
}

async function inspectPair(workspace: string, base: string, target: string): Promise<PairReport> {
  const [baseLocale, targetLocale] = await Promise.all([readLocale(workspace, base), readLocale(workspace, target)]);
  const missing = [...baseLocale.keys].filter((key) => !targetLocale.keys.has(key)).sort();
  const extra = [...targetLocale.keys].filter((key) => !baseLocale.keys.has(key)).sort();
  return { base: baseLocale.path, target: targetLocale.path, baseKeys: baseLocale.keys.size, targetKeys: targetLocale.keys.size, missing, extra };
}

export default {
  name: "pi-i18n-pair",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: PairReport | undefined;
    const inspect = async (base = "locales/en.json", target = "locales/zh-CN.json"): Promise<PairReport> => {
      latest = await inspectPair(context.piHarnessLaunch.cwd, base, target);
      return latest;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "i18n_check",
        label: "I18n check",
        description: "Compare two local JSON locale files and report missing or extra translation keys.",
        promptSnippet: "check translation key parity between two locale files",
        parameters: Type.Object({
          base: Type.Optional(Type.String({ description: "Base locale path" })),
          target: Type.Optional(Type.String({ description: "Target locale path" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<PairReport>> {
          const report = await inspect(params.base, params.target);
          return {
            content: [{ type: "text", text: `${report.target}: ${report.missing.length} missing and ${report.extra.length} extra keys.` }],
            details: report,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "i18n-pair-panel",
      pluginId: "@pi-harness/core/plugins/i18n-pair",
      title: "I18n Pair",
      description: "检查两个本地语言包的键是否同步，不自动改写翻译文件。",
      icon: "文",
      read: () => ({ report: latest ?? null }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
