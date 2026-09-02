import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxQueryLength = 120;
const maxPathLength = 512;
const maxFileBytes = 2 * 1024 * 1024;
const maxFiles = 1_000;
const maxResults = 100;
const ignoredDirectories = new Set([".git", "node_modules", ".pi", "dist", "build"]);
const sourceExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

export type ModuleMatchKind = "import" | "export" | "symbol";
export type ModuleMatch = { kind: ModuleMatchKind; name: string; path: string; line: number; text: string };
export type ModuleSearchKind = ModuleMatchKind | "all";
export type ModuleSearchReport = {
  query: string;
  kind: ModuleSearchKind;
  path: string;
  matches: ModuleMatch[];
  scannedFiles: number;
  skippedFiles: number;
  truncated: boolean;
};

function inside(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${"/"}`) && !remainder.startsWith("/"));
}

function moduleNames(source: string, kind: ModuleMatchKind): string[] {
  if (kind === "import") {
    const named = [...source.matchAll(/\bimport\s*\{([^}]*)\}/gu)].flatMap(
      (match) =>
        match[1]
          ?.split(",")
          .map(
            (item) =>
              item
                .trim()
                .split(/\s+as\s+/iu)[0]
                ?.trim() ?? "",
          )
          .filter(Boolean) ?? [],
    );
    const defaults = [...source.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*["']/gu)].map((match) => match[1]!).filter(Boolean);
    const namespaces = [...source.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']/gu)].map((match) => match[1]!).filter(Boolean);
    return [...named, ...defaults, ...namespaces];
  }
  if (kind === "export") {
    const declarations = [...source.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gu)].map(
      (match) => match[1]!,
    );
    const named = [...source.matchAll(/\bexport\s*\{([^}]*)\}/gu)].flatMap(
      (match) =>
        match[1]
          ?.split(",")
          .map(
            (item) =>
              item
                .trim()
                .split(/\s+as\s+/iu)
                .at(-1)
                ?.trim() ?? "",
          )
          .filter(Boolean) ?? [],
    );
    return [...declarations, ...named];
  }
  return [...source.matchAll(/\b(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gu)]
    .map((match) => match[1]!)
    .filter(Boolean);
}

export function extractModuleMatches(source: string, path: string, query: string, kind: ModuleSearchKind): ModuleMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length < 1 || normalizedQuery.length > maxQueryLength) throw new Error("Module search query must contain 1-120 characters");
  const kinds: ModuleMatchKind[] = kind === "all" ? ["import", "export", "symbol"] : [kind];
  return source.split(/\r?\n/u).flatMap((line, index) => {
    const matches: ModuleMatch[] = [];
    for (const entryKind of kinds) {
      if (kind === "all" && entryKind === "symbol" && /\bexport\b/u.test(line)) continue;
      for (const name of moduleNames(line, entryKind)) {
        if (!name.toLocaleLowerCase().includes(normalizedQuery) && !line.toLocaleLowerCase().includes(normalizedQuery)) continue;
        matches.push({ kind: entryKind, name, path, line: index + 1, text: line });
      }
    }
    return matches;
  });
}

async function filesUnder(target: string, root: string, files: string[]): Promise<void> {
  if (files.length >= maxFiles) return;
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    if (sourceExtensions.has(target.slice(target.lastIndexOf(".")).toLocaleLowerCase())) files.push(target);
    return;
  }
  if (!metadata.isDirectory()) return;
  const entries = (await readdir(target, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = resolve(target, entry.name);
    if (inside(root, child)) await filesUnder(child, root, files);
  }
}

function workspacePath(root: string, requested: string): string {
  if (requested.length > maxPathLength || requested.includes("\\"))
    throw new Error("Module search path must be a relative POSIX path of at most 512 characters");
  const target = resolve(root, requested || ".");
  if (!inside(root, target)) throw new Error("Module search path must stay inside the current workspace");
  return target;
}

export default {
  name: "pi-module-search",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: ModuleSearchReport | undefined;
    const search = async (
      query: string,
      requestedPath: string | undefined,
      kind: ModuleSearchKind,
      requestedLimit: number | undefined,
    ): Promise<ModuleSearchReport> => {
      const normalizedQuery = query.trim();
      if (normalizedQuery.length < 1 || normalizedQuery.length > maxQueryLength) throw new Error("Module search query must contain 1-120 characters");
      const normalizedKind = kind === "import" || kind === "export" || kind === "symbol" ? kind : "all";
      const root = await realpath(context.piHarnessLaunch.cwd);
      const target = workspacePath(root, requestedPath?.trim() ?? ".");
      const targetMetadata = await stat(target);
      const files: string[] = [];
      await filesUnder(target, root, files);
      const limit = Math.max(1, Math.min(maxResults, Math.trunc(requestedLimit ?? maxResults)));
      const matches: ModuleMatch[] = [];
      let scannedFiles = 0;
      let skippedFiles = targetMetadata.isFile() && targetMetadata.size > maxFileBytes ? 1 : 0;
      for (const file of files) {
        if (matches.length >= limit) break;
        const metadata = await stat(file);
        if (metadata.size > maxFileBytes) {
          skippedFiles += 1;
          continue;
        }
        const source = await readFile(file, "utf8");
        scannedFiles += 1;
        matches.push(...extractModuleMatches(source, relative(root, file), normalizedQuery, normalizedKind).slice(0, limit - matches.length));
      }
      const report: ModuleSearchReport = {
        query: normalizedQuery,
        kind: normalizedKind,
        path: relative(root, target) || ".",
        matches,
        scannedFiles,
        skippedFiles,
        truncated: matches.length >= limit && files.length > scannedFiles,
      };
      latest = report;
      return report;
    };
    const unregister = context.piTools.register(
      defineTool({
        name: "module_search",
        label: "Search modules",
        description: "Find imports, exports, or declared symbols in bounded workspace source files without modifying them.",
        promptSnippet: "find a module import, export, or symbol in the workspace",
        parameters: Type.Object({
          query: Type.String({ description: "Name fragment to find, 1-120 characters" }),
          kind: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("import"), Type.Literal("export"), Type.Literal("symbol")])),
          path: Type.Optional(Type.String({ description: "Relative workspace path" })),
          maxResults: Type.Optional(Type.Number({ description: "Maximum matches, 1-100" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<ModuleSearchReport>> {
          const report = await search(params.query, params.path, params.kind ?? "all", params.maxResults);
          return {
            content: [
              {
                type: "text",
                text: report.matches.map((match) => `${match.path}:${match.line} ${match.kind} ${match.name}`).join("\n") || "No module matches found.",
              },
            ],
            details: report,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "module-search-panel",
      pluginId: "@pi-harness/core/plugins/module-search",
      title: "Module Search",
      description: "按导入、导出和声明符号检索工作区源码。",
      icon: "⌕",
      read: () => ({ latest: latest ?? null, matchCount: latest?.matches.length ?? 0 }),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
