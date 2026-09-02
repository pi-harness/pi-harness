import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxQueryLength = 256;
const maxPathLength = 512;
const maxFileBytes = 2 * 1024 * 1024;
const maxFiles = 2_000;
const maxResults = 100;
const ignoredDirectories = new Set([".git", "node_modules", ".pi", "dist", "build"]);
type SearchMatch = { path: string; line: number; text: string };
type SearchReport = { query: string; path: string; matches: SearchMatch[]; matchCount: number; scannedFiles: number; skippedFiles: number; truncated: boolean };

function inside(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${"/"}`) && !remainder.startsWith("/"));
}

function workspacePath(root: string, requested: string): string {
  if (requested.length > maxPathLength || requested.includes("\\"))
    throw new Error("Workspace search path must be a relative POSIX path of at most 512 characters");
  const target = resolve(root, requested || ".");
  if (!inside(root, target)) throw new Error("Workspace search path must stay inside the current workspace");
  return target;
}

async function filesUnder(target: string, root: string, files: string[]): Promise<void> {
  if (files.length >= maxFiles) return;
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    files.push(target);
    return;
  }
  if (!metadata.isDirectory()) return;
  const entries = (await readdir(target, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = resolve(target, entry.name);
    if (!inside(root, child)) continue;
    await filesUnder(child, root, files);
  }
}

export default {
  name: "pi-workspace-search",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: SearchReport | undefined;
    const search = async (
      query: string,
      requestedPath: string | undefined,
      caseSensitive: boolean,
      requestedLimit: number | undefined,
    ): Promise<SearchReport> => {
      const normalizedQuery = query.trim();
      if (normalizedQuery.length === 0 || normalizedQuery.length > maxQueryLength)
        throw new Error(`Workspace search query must contain 1-${maxQueryLength} characters`);
      const root = await realpath(context.piHarnessLaunch.cwd);
      const target = workspacePath(root, requestedPath?.trim() ?? ".");
      const targetMetadata = await stat(target);
      const files: string[] = [];
      await filesUnder(target, root, files);
      const limit = Math.max(1, Math.min(maxResults, Math.trunc(requestedLimit ?? maxResults)));
      const needle = caseSensitive ? normalizedQuery : normalizedQuery.toLocaleLowerCase();
      const matches: SearchMatch[] = [];
      let scannedFiles = 0;
      let skippedFiles = targetMetadata.isFile() && targetMetadata.size > maxFileBytes ? 1 : 0;
      for (const file of files) {
        if (matches.length >= limit) break;
        const metadata = await stat(file);
        if (metadata.size > maxFileBytes) {
          skippedFiles += 1;
          continue;
        }
        const source = await readFile(file);
        if (source.includes(0)) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const lines = source.toString("utf8").split(/\r?\n/u);
        for (const [index, line] of lines.entries()) {
          if ((caseSensitive ? line : line.toLocaleLowerCase()).includes(needle)) {
            matches.push({ path: relative(root, file), line: index + 1, text: line });
            if (matches.length >= limit) break;
          }
        }
      }
      const report: SearchReport = {
        query: normalizedQuery,
        path: relative(root, target) || ".",
        matches,
        matchCount: matches.length,
        scannedFiles,
        skippedFiles,
        truncated: matches.length >= limit && files.length > scannedFiles,
      };
      latest = report;
      return report;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "workspace_search",
        label: "Search workspace",
        description: "Search bounded UTF-8 text files in the current workspace without modifying files or invoking a shell.",
        promptSnippet: "search the workspace for a text pattern",
        parameters: Type.Object({
          query: Type.String(),
          path: Type.Optional(Type.String()),
          caseSensitive: Type.Optional(Type.Boolean()),
          maxResults: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<SearchReport>> {
          const report = await search(params.query, params.path, params.caseSensitive === true, params.maxResults);
          return {
            content: [{ type: "text", text: report.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") || "No matches found." }],
            details: report,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "workspace-search-panel",
      pluginId: "@pi-harness/core/plugins/workspace-search",
      title: "Workspace Search",
      description: "在工作区内安全检索文本，跳过依赖、构建产物和版本库目录。",
      icon: "⌕",
      read: () => ({ latest: latest ?? null, query: latest?.query ?? null, matchCount: latest?.matchCount ?? 0, scannedFiles: latest?.scannedFiles ?? 0 }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
