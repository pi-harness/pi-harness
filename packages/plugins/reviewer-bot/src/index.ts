import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

const execFileAsync = promisify(execFile);
const maxFiles = 512;
const maxFindings = 100;
const defaultTimeoutMs = 15_000;
type ReviewFinding = { kind: "whitespace" | "secret" | "todo"; severity: "error" | "warning"; message: string; path?: string };
type ReviewFile = { path: string; added: number; removed: number };
type ReviewReport = {
  cwd: string;
  status: "pass" | "warning" | "error";
  files: ReviewFile[];
  findings: ReviewFinding[];
  changedFiles: number;
  findingCount: number;
  filesTruncated: boolean;
  findingsTruncated: boolean;
  addedLines: number;
  removedLines: number;
};

export interface ReviewerBotPluginConfig {
  maxDiffBytes?: number;
  timeoutMs?: number;
}
export const Config: z<ReviewerBotPluginConfig> = z.object({
  maxDiffBytes: z
    .number()
    .min(16 * 1024)
    .max(8 * 1024 * 1024)
    .step(1)
    .default(1024 * 1024),
  timeoutMs: z.number().min(100).max(60_000).step(1).default(defaultTimeoutMs),
});

function outputOf(error: unknown, key: "stdout" | "stderr"): string {
  if (typeof error === "object" && error !== null && key in error) {
    const output = (error as Record<string, unknown>)[key];
    if (typeof output === "string") return output;
    if (Buffer.isBuffer(output)) return output.toString("utf8");
  }
  return "";
}

async function git(cwd: string, args: readonly string[], maxBuffer: number, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const env = { ...process.env };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_WORK_TREE",
  ])
    delete env[name];
  // core.quotepath=false keeps non-ASCII paths as literal UTF-8 instead of octal escapes; it does nothing for the ASCII bytes git always escapes, which is why the diff headers still have to be unquoted below.
  const result = await execFileAsync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.quotepath=false",
      "-c",
      "color.ui=false",
      ...args,
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ],
    { cwd, env, maxBuffer, timeout: timeoutMs, signal },
  );
  return result.stdout;
}

const quotedEscapes = new Map<string, number>([
  ["a", 7],
  ["b", 8],
  ["f", 12],
  ["n", 10],
  ["r", 13],
  ["t", 9],
  ["v", 11],
  ["\\", 92],
  ['"', 34],
]);

// Git C-quotes a diff header path that contains a double quote, a backslash or a control byte, and the escapes stand for raw bytes, so they are decoded into a byte buffer and read back as UTF-8.
function decodeQuotedPath(value: string): string | undefined {
  const characters = [...value];
  if (characters[0] !== '"') return undefined;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let index = 1; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (character === '"') return Buffer.from(bytes).toString("utf8");
    if (character !== "\\") {
      for (const byte of encoder.encode(character)) bytes.push(byte);
      continue;
    }
    const escape = characters[index + 1];
    if (escape === undefined) return undefined;
    const simple = quotedEscapes.get(escape);
    if (simple !== undefined) {
      bytes.push(simple);
      index += 1;
      continue;
    }
    const octal = characters.slice(index + 1, index + 4).join("");
    if (!/^[0-7]{3}$/u.test(octal)) return undefined;
    bytes.push(Number.parseInt(octal, 8));
    index += 3;
  }
  return undefined;
}

// Git appends a TAB and optional metadata after an unquoted diff header path that contains a space, so the header path stops at the first TAB. `/dev/null` and anything that does not carry the expected side prefix yields undefined, which leaves the current attribution alone.
function headerPath(line: string, prefix: "a/" | "b/"): string | undefined {
  const rest = line.slice(4);
  const decoded = rest.startsWith('"') ? decodeQuotedPath(rest) : rest.split("\t")[0];
  return decoded !== undefined && decoded.startsWith(prefix) ? decoded.slice(prefix.length) : undefined;
}

function modelReport(report: ReviewReport): string {
  const preview = {
    ...report,
    files: report.files.slice(0, 20),
    findings: [...report.findings].sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error")).slice(0, 50),
  };
  const render = () => {
    preview.filesTruncated = preview.changedFiles > preview.files.length;
    preview.findingsTruncated = preview.findingCount > preview.findings.length;
    return `${report.status}: ${report.changedFiles} files, +${report.addedLines}/-${report.removedLines}, ${report.findingCount} findings.\n${JSON.stringify(preview)}`;
  };
  let text = render();
  while (Buffer.byteLength(text, "utf8") > 32 * 1024 && (preview.files.length > 0 || preview.findings.length > 0)) {
    if (preview.files.length > 0) preview.files.pop();
    else preview.findings.pop();
    text = render();
  }
  return text;
}

export default {
  name: "pi-reviewer-bot",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: ReviewerBotPluginConfig) {
    assertKnownConfigKeys("pi-reviewer-bot", config, ["maxDiffBytes", "timeoutMs"]);
    const maxDiffBytes = Number.isFinite(config.maxDiffBytes) ? Math.max(16 * 1024, Math.min(8 * 1024 * 1024, Math.trunc(config.maxDiffBytes!))) : 1024 * 1024;
    const timeoutMs = Number.isFinite(config.timeoutMs) ? Math.max(100, Math.min(60_000, Math.trunc(config.timeoutMs!))) : defaultTimeoutMs;
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
    const checkCancelled = (signal: AbortSignal) => {
      if (signal.aborted) throw new Error("Git review was cancelled");
    };
    let latest: ReviewReport | undefined;
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
    const review = async (cwd: string, signal: AbortSignal, assertCurrent: () => void): Promise<ReviewReport> => {
      checkCancelled(signal);
      let diff: string;
      let names: string;
      const findings: ReviewFinding[] = [];
      let findingCount = 0;
      let hasError = false;
      const finding = (item: ReviewFinding): void => {
        findingCount += 1;
        hasError ||= item.severity === "error";
        if (findings.length < maxFindings) findings.push(item);
        else if (item.severity === "error") {
          const warning = findings.findLastIndex((entry) => entry.severity === "warning");
          if (warning >= 0) findings[warning] = item;
        }
      };
      try {
        [diff, names] = await Promise.all([
          git(cwd, ["diff", "HEAD", "--no-ext-diff", "--unified=0"], maxDiffBytes, timeoutMs, signal),
          // -z is the only --name-only form git never quotes, so the listing always carries the same literal paths the decoded diff headers do.
          git(cwd, ["diff", "HEAD", "--name-only", "--no-ext-diff", "-z"], maxDiffBytes, timeoutMs, signal),
        ]);
      } catch (error) {
        checkCancelled(signal);
        const timedOut = typeof error === "object" && error !== null && "killed" in error && (error as { killed?: unknown }).killed === true;
        throw new Error(
          timedOut
            ? `Git review timed out after ${timeoutMs} ms`
            : `Git review requires a repository with a readable HEAD: ${outputOf(error, "stderr").trim() || (error instanceof Error ? error.message : String(error))}`,
          { cause: error },
        );
      }
      assertCurrent();
      const paths = names.split("\0").filter(Boolean);
      const fileMap = new Map<string, ReviewFile>();
      let addedLines = 0;
      let removedLines = 0;
      let currentPath: string | undefined;
      // Header parsing only applies between a `diff --git` line and the first `@@` of that file: inside a hunk a removed line whose content starts with `-- a/` is rendered as `--- a/...`, which would otherwise be mistaken for a file header and misattribute the rest of the hunk to a phantom path.
      let inHunk = false;
      for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
          inHunk = false;
          currentPath = undefined;
          continue;
        }
        if (line.startsWith("@@")) {
          inHunk = true;
          continue;
        }
        if (!inHunk && line.startsWith("+++ ")) {
          const path = headerPath(line, "b/");
          if (path !== undefined) {
            currentPath = path;
            if (!fileMap.has(path)) fileMap.set(path, { path, added: 0, removed: 0 });
          }
          continue;
        }
        // A deleted file only carries a `--- a/` header (its `+++` side is /dev/null), so the removed lines must be attributed from here.
        if (!inHunk && line.startsWith("--- ")) {
          const path = headerPath(line, "a/");
          if (path !== undefined) {
            currentPath = path;
            if (!fileMap.has(path)) fileMap.set(path, { path, added: 0, removed: 0 });
          }
          continue;
        }
        if (line.startsWith("+")) {
          if (!inHunk && line.startsWith("+++")) continue;
          addedLines += 1;
          if (currentPath !== undefined) fileMap.set(currentPath, { ...fileMap.get(currentPath)!, added: fileMap.get(currentPath)!.added + 1 });
          if (/(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}/iu.test(line))
            finding({ kind: "secret", severity: "error", message: "新增行疑似包含凭据。", ...(currentPath === undefined ? {} : { path: currentPath }) });
          if (/\b(?:TODO|FIXME)\b/u.test(line))
            finding({
              kind: "todo",
              severity: "warning",
              message: "新增行包含 TODO/FIXME。",
              ...(currentPath === undefined ? {} : { path: currentPath }),
            });
        } else if (line.startsWith("-")) {
          if (!inHunk && line.startsWith("---")) continue;
          removedLines += 1;
          if (currentPath !== undefined) fileMap.set(currentPath, { ...fileMap.get(currentPath)!, removed: fileMap.get(currentPath)!.removed + 1 });
        }
      }
      try {
        await git(cwd, ["diff", "HEAD", "--check"], maxDiffBytes, timeoutMs, signal);
      } catch (error) {
        checkCancelled(signal);
        const timedOut = typeof error === "object" && error !== null && "killed" in error && (error as { killed?: unknown }).killed === true;
        if (timedOut) throw new Error(`Git review timed out after ${timeoutMs} ms`, { cause: error });
        if (!(error instanceof Error) || !("code" in error) || error.code !== 2) throw new Error("Git whitespace check failed", { cause: error });
        finding({ kind: "whitespace", severity: "error", message: "git diff --check 检测到空白错误；为避免泄露内容，报告不包含原始行。" });
      }
      checkCancelled(signal);
      const status = hasError ? "error" : findingCount > 0 ? "warning" : "pass";
      return {
        cwd,
        status,
        files: paths.slice(0, maxFiles).map((path) => fileMap.get(path) ?? { path, added: 0, removed: 0 }),
        findings,
        changedFiles: paths.length,
        findingCount,
        filesTruncated: paths.length > maxFiles,
        findingsTruncated: findingCount > findings.length,
        addedLines,
        removedLines,
      };
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "review_changes",
        label: "Review changes",
        description: "Run a read-only Git diff review for whitespace, likely secrets, and TODO/FIXME findings.",
        promptSnippet: "review the current Git diff for release risks",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, callerSignal): Promise<AgentToolResult<ReviewReport>> {
          const signal = callerSignal === undefined ? lifecycle.signal : AbortSignal.any([callerSignal, lifecycle.signal]);
          checkCancelled(signal);
          if (params === null || typeof params !== "object" || Array.isArray(params) || Reflect.ownKeys(params).length !== 0)
            throw new Error("Review parameters must be an empty object");
          const operationScope = refreshScope();
          const assertCurrent = () => {
            checkCancelled(signal);
            if (refreshScope() !== operationScope) throw new Error("Git review workspace changed during inspection");
          };
          const report = await review(operationScope.cwd, signal, assertCurrent);
          assertCurrent();
          latest = structuredClone(report);
          return {
            content: [
              {
                type: "text",
                text: modelReport(report),
              },
            ],
            details: report,
          };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "reviewer-bot-panel",
        pluginId: "@pi-harness/plugin-reviewer-bot",
        title: "Reviewer Bot",
        description: "只读检查 Git 改动中的空白、凭据和遗留标记风险。",
        icon: "✓",
        read: () => {
          refreshScope();
          return { latest: latest === undefined ? null : structuredClone(latest), maxDiffBytes, timeoutMs };
        },
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
