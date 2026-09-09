import { lstat, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig, readBoundedFile, resolveExistingWorkspacePath } from "@pi-harness/plugin-api";

const maxQueryLength = 120;
const maxPathLength = 512;
const maxFileBytes = 2 * 1024 * 1024;
const maxFiles = 1_000;
const maxDirectories = 512;
const maxDepth = 16;
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

// `index` is the statement start used to report the line; `order` is the position of the name itself so results follow source order.
type NamedMatch = { kind: ModuleMatchKind; name: string; index: number; order: number };
type BindingName = { name: string; offset: number };
type SourceRange = { start: number; end: number };

// Import and export statements are matched against the whole source so that brace lists spanning several lines and the TypeScript `type` modifier are recognised. The brace list excludes `{` and `}` and the statement tail is required so an unbalanced `import {` inside a comment or string cannot swallow the code that follows it.
const importBindings = /\bimport\b\s*(?:type\b\s*)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^{}]*)\}(?=\s*from\s*["'])/gu;
const importDefaults = /\bimport\b\s*(?:type\b\s*)?([A-Za-z_$][\w$]*)\s*(?:,|\bfrom\b)/gu;
const importNamespaces = /\bimport\b\s*(?:type\b\s*)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\*\s*as\s+([A-Za-z_$][\w$]*)/gu;
const exportDeclarations = /\bexport\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gu;
const exportBindings = /\bexport\b\s*(?:type\b\s*)?\{([^{}]*)\}(?=\s*(?:from\s*["']|;|$))/gmu;
const symbolDeclarations = /\b(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gu;

function bindingNames(match: RegExpMatchArray, side: "local" | "exported"): BindingName[] {
  const list = match[1] ?? "";
  const listOffset = (match.index ?? 0) + match[0].indexOf(list);
  const names: BindingName[] = [];
  let cursor = 0;
  for (const item of list.split(",")) {
    const parts = item
      .trim()
      .replace(/^type\s+/u, "")
      .split(/\s+as\s+/iu);
    const name = (side === "local" ? parts[0] : parts.at(-1))?.trim() ?? "";
    if (name) names.push({ name, offset: listOffset + cursor + item.indexOf(name) });
    cursor += item.length + 1;
  }
  return names;
}

function rangeOf(match: RegExpMatchArray): SourceRange {
  return { start: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
}

function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (const lineBreak of source.matchAll(/\r?\n/gu)) starts.push((lineBreak.index ?? 0) + lineBreak[0].length);
  return starts;
}

function lineIndexAt(lineStarts: number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle]! <= index) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function extractModuleMatches(source: string, path: string, query: string, kind: ModuleSearchKind): ModuleMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length < 1 || normalizedQuery.length > maxQueryLength) throw new Error("Module search query must contain 1-120 characters");
  const kinds = new Set<ModuleMatchKind>(kind === "all" ? ["import", "export", "symbol"] : [kind]);
  const candidates: NamedMatch[] = [];
  // Binding statements are always collected so their ranges can exclude spurious symbol matches such as `type Foo` inside `import { type Foo }`.
  const bindingRanges: SourceRange[] = [];
  for (const match of source.matchAll(importBindings)) {
    bindingRanges.push(rangeOf(match));
    if (kinds.has("import"))
      for (const { name, offset } of bindingNames(match, "local")) candidates.push({ kind: "import", name, index: match.index ?? 0, order: offset });
  }
  for (const pattern of [importDefaults, importNamespaces]) {
    for (const match of source.matchAll(pattern)) {
      bindingRanges.push(rangeOf(match));
      if (kinds.has("import") && match[1])
        candidates.push({ kind: "import", name: match[1], index: match.index ?? 0, order: (match.index ?? 0) + match[0].indexOf(match[1]) });
    }
  }
  for (const match of source.matchAll(exportBindings)) {
    bindingRanges.push(rangeOf(match));
    if (kinds.has("export"))
      for (const { name, offset } of bindingNames(match, "exported")) candidates.push({ kind: "export", name, index: match.index ?? 0, order: offset });
  }
  if (kinds.has("export")) {
    for (const match of source.matchAll(exportDeclarations))
      if (match[1]) candidates.push({ kind: "export", name: match[1], index: match.index ?? 0, order: match.index ?? 0 });
  }
  const lines = source.split(/\r?\n/u);
  const lineStarts = lineStartsOf(source);
  if (kinds.has("symbol")) {
    for (const match of source.matchAll(symbolDeclarations)) {
      const index = match.index ?? 0;
      if (!match[1] || bindingRanges.some((range) => range.start <= index && index < range.end)) continue;
      if (kind === "all" && /\bexport\b/u.test(lines[lineIndexAt(lineStarts, index)] ?? "")) continue;
      candidates.push({ kind: "symbol", name: match[1], index, order: index });
    }
  }
  return candidates
    .filter((candidate) => candidate.name.toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => left.order - right.order)
    .map((candidate) => {
      const lineIndex = lineIndexAt(lineStarts, candidate.index);
      return { kind: candidate.kind, name: candidate.name, path, line: lineIndex + 1, text: lines[lineIndex] ?? "" };
    });
}

type WalkState = { files: string[]; directories: number };

async function filesUnder(target: string, root: string, state: WalkState, assertCurrent: () => void, depth = 0): Promise<boolean> {
  assertCurrent();
  if (state.files.length >= maxFiles || state.directories >= maxDirectories || depth > maxDepth) return true;
  const metadata = await lstat(target);
  assertCurrent();
  if (metadata.isSymbolicLink()) return false;
  if (metadata.isFile()) {
    if (sourceExtensions.has(target.slice(target.lastIndexOf(".")).toLocaleLowerCase())) state.files.push(target);
    return false;
  }
  if (!metadata.isDirectory()) return false;
  state.directories += 1;
  if (depth >= maxDepth) return true;
  const entries = (await readdir(target, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    assertCurrent();
    if (state.files.length >= maxFiles || state.directories >= maxDirectories) return true;
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = resolve(target, entry.name);
    if (await filesUnder(child, root, state, assertCurrent, depth + 1)) return true;
  }
  return false;
}

export default {
  name: "pi-module-search",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort(new Error("Module search plugin disposed")));
    let latest: ModuleSearchReport | undefined;
    const readScope = () => {
      const session = context.get("piRuntime")?.session;
      return { session, manager: session?.sessionManager, id: session?.sessionId, cwd: session?.sessionManager.getCwd() ?? context.piHarnessLaunch.cwd };
    };
    let scope = readScope();
    const refreshScope = () => {
      const next = readScope();
      if (next.session !== scope.session || next.manager !== scope.manager || next.id !== scope.id || next.cwd !== scope.cwd) {
        scope = next;
        latest = undefined;
      }
      return scope;
    };
    const search = async (
      query: string,
      requestedPath: string | undefined,
      kind: ModuleSearchKind,
      requestedLimit: number | undefined,
      cwd: string,
      assertCurrent: () => void,
    ): Promise<ModuleSearchReport> => {
      assertCurrent();
      const normalizedQuery = query.trim();
      if (normalizedQuery.length < 1 || normalizedQuery.length > maxQueryLength) throw new Error("Module search query must contain 1-120 characters");
      const normalizedKind = kind === "import" || kind === "export" || kind === "symbol" ? kind : "all";
      const requested = requestedPath?.trim() ?? ".";
      if (requested.length > maxPathLength || requested.includes("\\"))
        throw new Error("Module search path must be a relative POSIX path of at most 512 characters");
      const resolved = await resolveExistingWorkspacePath(cwd, requested, "Module search path must stay inside the current workspace");
      assertCurrent();
      const root = resolved.root;
      const target = resolved.target;
      const walkState: WalkState = { files: [], directories: 0 };
      const filesTruncated = await filesUnder(target, root, walkState, assertCurrent);
      assertCurrent();
      const files = walkState.files;
      const limit = Math.max(
        1,
        Math.min(maxResults, Math.trunc(requestedLimit !== undefined && Number.isFinite(requestedLimit) ? requestedLimit : maxResults)),
      );
      const matches: ModuleMatch[] = [];
      let truncated = false;
      let scannedFiles = 0;
      let skippedFiles = 0;
      for (const file of files) {
        assertCurrent();
        if (matches.length >= limit) break;
        const metadata = await stat(file);
        assertCurrent();
        if (metadata.size > maxFileBytes) {
          skippedFiles += 1;
          continue;
        }
        let source: string;
        try {
          source = new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedFile(file, maxFileBytes, "Module search file"));
        } catch {
          assertCurrent();
          skippedFiles += 1;
          continue;
        }
        assertCurrent();
        scannedFiles += 1;
        const fileMatches = extractModuleMatches(source, relative(root, file), normalizedQuery, normalizedKind);
        const remaining = limit - matches.length;
        matches.push(...fileMatches.slice(0, remaining));
        if (fileMatches.length > remaining) truncated = true;
      }
      const report: ModuleSearchReport = {
        query: normalizedQuery,
        kind: normalizedKind,
        path: relative(root, target) || ".",
        matches,
        scannedFiles,
        skippedFiles,
        truncated: filesTruncated || truncated || (matches.length >= limit && files.length > scannedFiles + skippedFiles),
      };
      assertCurrent();
      return report;
    };
    const unregister = context.piTools.register(
      defineTool({
        name: "module_search",
        label: "Search modules",
        description: "Find imports, exports, or declared symbols in bounded workspace source files without modifying them.",
        promptSnippet: "find a module import, export, or symbol in the workspace",
        parameters: Type.Object(
          {
            query: Type.String({ description: "Name fragment to find, 1-120 characters" }),
            kind: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("import"), Type.Literal("export"), Type.Literal("symbol")])),
            path: Type.Optional(Type.String({ description: "Relative workspace path" })),
            maxResults: Type.Optional(Type.Number({ description: "Maximum matches, 1-100" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<ModuleSearchReport>> {
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          operationSignal.throwIfAborted();
          const current = refreshScope();
          const assertCurrent = () => {
            operationSignal.throwIfAborted();
            if (refreshScope() !== current) throw new Error("Module search workspace changed during execution");
          };
          const report = await search(params.query, params.path, params.kind ?? "all", params.maxResults, current.cwd, assertCurrent);
          assertCurrent();
          latest = report;
          return {
            content: [
              {
                type: "text",
                text: report.matches.map((match) => `${match.path}:${match.line} ${match.kind} ${match.name}`).join("\n") || "No module matches found.",
              },
            ],
            details: structuredClone(report),
          };
        },
      }),
    );
    context.effect(() => unregister);
    const disposePanel = context.piPluginUi.register({
      id: "module-search-panel",
      pluginId: "@pi-harness/plugin-module-search",
      title: "Module Search",
      description: "按导入、导出和声明符号检索工作区源码。",
      icon: "⌕",
      read: () => {
        refreshScope();
        return { latest: latest === undefined ? null : structuredClone(latest), matchCount: latest?.matches.length ?? 0 };
      },
    });
    context.effect(() => disposePanel);
  },
};
