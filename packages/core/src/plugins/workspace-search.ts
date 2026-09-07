import { lstat, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig, readBoundedFile, resolveExistingWorkspacePath } from "@pi-harness/plugin-api";

const maxQueryLength = 256;
const maxPathLength = 512;
const maxFileBytes = 2 * 1024 * 1024;
const maxFiles = 2_000;
const maxDirectories = 512;
const maxDepth = 16;
const maxResults = 100;
const maxMatchTextLength = 500;
const ignoredDirectories = new Set([".git", "node_modules", ".pi", "dist", "build"]);
type SearchMatch = { path: string; line: number; text: string };
type SearchReport = { query: string; path: string; matches: SearchMatch[]; matchCount: number; scannedFiles: number; skippedFiles: number; truncated: boolean };

type PathSemantics = { isAbsolute(path: string): boolean; relative(from: string, to: string): string; sep: string };
const nativePathSemantics: PathSemantics = { isAbsolute, relative, sep };

export function isWorkspaceSearchPathInside(root: string, target: string, pathSemantics: PathSemantics = nativePathSemantics): boolean {
  const remainder = pathSemantics.relative(root, target);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${pathSemantics.sep}`) && !pathSemantics.isAbsolute(remainder));
}

type WalkState = { files: string[]; directories: number };

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Workspace search was cancelled", { cause: signal.reason });
}

async function filesUnder(target: string, root: string, state: WalkState, signal: AbortSignal | undefined, depth = 0): Promise<boolean> {
  throwIfAborted(signal);
  if (state.files.length >= maxFiles || state.directories >= maxDirectories || depth > maxDepth) return true;
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) return false;
  if (metadata.isFile()) {
    state.files.push(target);
    return false;
  }
  if (!metadata.isDirectory()) return false;
  state.directories += 1;
  if (depth >= maxDepth) return true;
  const entries = (await readdir(target, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (state.files.length >= maxFiles || state.directories >= maxDirectories) return true;
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = resolve(target, entry.name);
    if (!isWorkspaceSearchPathInside(root, child)) continue;
    if (await filesUnder(child, root, state, signal, depth + 1)) return true;
  }
  return false;
}

export default {
  name: "pi-workspace-search",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let latest: SearchReport | undefined;
    const search = async (
      query: string,
      requestedPath: string | undefined,
      caseSensitive: boolean,
      requestedLimit: number | undefined,
      signal: AbortSignal | undefined,
    ): Promise<SearchReport> => {
      throwIfAborted(signal);
      const normalizedQuery = query.trim();
      if (normalizedQuery.length === 0 || normalizedQuery.length > maxQueryLength)
        throw new Error(`Workspace search query must contain 1-${maxQueryLength} characters`);
      const requested = requestedPath?.trim() || ".";
      if (requested.length > maxPathLength || requested.includes("\\"))
        throw new Error("Workspace search path must be a relative POSIX path of at most 512 characters");
      // Canonicalise both ends before the containment check so a symlinked intermediate directory cannot lead outside the workspace.
      const resolved = await resolveExistingWorkspacePath(
        context.piHarnessLaunch.cwd,
        requested,
        "Workspace search path must stay inside the current workspace",
      );
      const root = resolved.root;
      const target = resolved.target;
      const walkState: WalkState = { files: [], directories: 0 };
      const filesTruncated = await filesUnder(target, root, walkState, signal);
      const files = walkState.files;
      const limit = Math.max(1, Math.min(maxResults, Math.trunc(requestedLimit ?? maxResults)));
      const needle = caseSensitive ? normalizedQuery : normalizedQuery.toLocaleLowerCase();
      const matches: SearchMatch[] = [];
      let scannedFiles = 0;
      let skippedFiles = 0;
      let stoppedAtLimit = false;
      let clippedText = false;
      for (const file of files) {
        throwIfAborted(signal);
        if (matches.length >= limit) {
          stoppedAtLimit = true;
          break;
        }
        const metadata = await stat(file);
        if (metadata.size > maxFileBytes) {
          skippedFiles += 1;
          continue;
        }
        let source: string;
        try {
          const bytes = await readBoundedFile(file, maxFileBytes, "Workspace search file");
          if (bytes.includes(0)) {
            skippedFiles += 1;
            continue;
          }
          source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const lines = source.split(/\r?\n/u);
        for (const [index, line] of lines.entries()) {
          if ((caseSensitive ? line : line.toLocaleLowerCase()).includes(needle)) {
            // A minified bundle or a single-line JSON document is one legitimate line of up to maxFileBytes, so each match text is clipped before it reaches the agent content and the panel state.
            const clipped = line.length > maxMatchTextLength;
            if (clipped) clippedText = true;
            matches.push({ path: relative(root, file), line: index + 1, text: clipped ? `${line.slice(0, maxMatchTextLength)}…` : line });
            if (matches.length >= limit) {
              stoppedAtLimit = true;
              break;
            }
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
        truncated: filesTruncated || stoppedAtLimit || clippedText,
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
        parameters: Type.Object(
          {
            query: Type.String(),
            path: Type.Optional(Type.String()),
            caseSensitive: Type.Optional(Type.Boolean()),
            maxResults: Type.Optional(Type.Number()),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<SearchReport>> {
          const report = await search(params.query, params.path, params.caseSensitive === true, params.maxResults, signal);
          return {
            content: [{ type: "text", text: report.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") || "No matches found." }],
            details: report,
          };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "workspace-search-panel",
        pluginId: "@pi-harness/core/plugins/workspace-search",
        title: "Workspace Search",
        description: "在工作区内安全检索文本，跳过依赖、构建产物和版本库目录。",
        icon: "⌕",
        read: () => ({ latest: latest ?? null, query: latest?.query ?? null, matchCount: latest?.matchCount ?? 0, scannedFiles: latest?.scannedFiles ?? 0 }),
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
