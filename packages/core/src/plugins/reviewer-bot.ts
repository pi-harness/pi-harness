import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const maxFiles = 512;
const defaultTimeoutMs = 15_000;
type ReviewFinding = { kind: "whitespace" | "secret" | "todo"; severity: "error" | "warning"; message: string; path?: string };
type ReviewFile = { path: string; added: number; removed: number };
type ReviewReport = {
  status: "pass" | "warning" | "error";
  files: ReviewFile[];
  findings: ReviewFinding[];
  changedFiles: number;
  addedLines: number;
  removedLines: number;
};

export interface ReviewerBotPluginConfig {
  maxDiffBytes?: number;
  timeoutMs?: number;
}
export const Config: z<ReviewerBotPluginConfig> = z.object({
  maxDiffBytes: z.number().default(1024 * 1024),
  timeoutMs: z.number().default(defaultTimeoutMs),
});

function outputOf(error: unknown, key: "stdout" | "stderr"): string {
  if (typeof error === "object" && error !== null && key in error) {
    const output = (error as Record<string, unknown>)[key];
    if (typeof output === "string") return output;
    if (Buffer.isBuffer(output)) return output.toString("utf8");
  }
  return "";
}

async function git(cwd: string, args: readonly string[], maxBuffer: number, timeoutMs: number): Promise<string> {
  // core.quotepath=false keeps non-ASCII paths as literal UTF-8 instead of octal escapes; it does nothing for the ASCII bytes git always escapes, which is why the diff headers still have to be unquoted below.
  const result = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], { cwd, maxBuffer, timeout: timeoutMs });
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

export default {
  name: "pi-reviewer-bot",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: ReviewerBotPluginConfig) {
    const maxDiffBytes = Math.max(16 * 1024, Math.min(8 * 1024 * 1024, Math.trunc(config.maxDiffBytes ?? 1024 * 1024)));
    const timeoutMs = Math.max(100, Math.min(60_000, Math.trunc(config.timeoutMs ?? defaultTimeoutMs)));
    let latest: ReviewReport | undefined;
    const review = async (): Promise<ReviewReport> => {
      let diff: string;
      let names: string;
      const findings: ReviewFinding[] = [];
      try {
        [diff, names] = await Promise.all([
          git(context.piHarnessLaunch.cwd, ["diff", "HEAD", "--no-ext-diff", "--unified=0"], maxDiffBytes, timeoutMs),
          // -z is the only --name-only form git never quotes, so the listing always carries the same literal paths the decoded diff headers do.
          git(context.piHarnessLaunch.cwd, ["diff", "HEAD", "--name-only", "--no-ext-diff", "-z"], maxDiffBytes, timeoutMs),
        ]);
      } catch (error) {
        const timedOut = typeof error === "object" && error !== null && "killed" in error && (error as { killed?: unknown }).killed === true;
        throw new Error(
          timedOut
            ? `Git review timed out after ${timeoutMs} ms`
            : `Git review requires a repository with a readable HEAD: ${outputOf(error, "stderr").trim() || (error instanceof Error ? error.message : String(error))}`,
          { cause: error },
        );
      }
      const paths = names.split("\0").filter(Boolean).slice(0, maxFiles);
      const fileMap = new Map<string, ReviewFile>();
      let addedLines = 0;
      let removedLines = 0;
      let currentPath: string | undefined;
      for (const line of diff.split("\n")) {
        if (line.startsWith("+++ ")) {
          const path = headerPath(line, "b/");
          if (path !== undefined) {
            currentPath = path;
            if (!fileMap.has(path)) fileMap.set(path, { path, added: 0, removed: 0 });
          }
          continue;
        }
        // A deleted file only carries a `--- a/` header (its `+++` side is /dev/null), so the removed lines must be attributed from here.
        if (line.startsWith("--- ")) {
          const path = headerPath(line, "a/");
          if (path !== undefined) {
            currentPath = path;
            if (!fileMap.has(path)) fileMap.set(path, { path, added: 0, removed: 0 });
          }
          continue;
        }
        if (line.startsWith("+")) {
          if (line.startsWith("+++")) continue;
          addedLines += 1;
          if (currentPath !== undefined) fileMap.set(currentPath, { ...fileMap.get(currentPath)!, added: fileMap.get(currentPath)!.added + 1 });
          if (/(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}/iu.test(line))
            findings.push({ kind: "secret", severity: "error", message: "新增行疑似包含凭据。", ...(currentPath === undefined ? {} : { path: currentPath }) });
          if (/\b(?:TODO|FIXME)\b/u.test(line))
            findings.push({
              kind: "todo",
              severity: "warning",
              message: "新增行包含 TODO/FIXME。",
              ...(currentPath === undefined ? {} : { path: currentPath }),
            });
        } else if (line.startsWith("-")) {
          if (line.startsWith("---")) continue;
          removedLines += 1;
          if (currentPath !== undefined) fileMap.set(currentPath, { ...fileMap.get(currentPath)!, removed: fileMap.get(currentPath)!.removed + 1 });
        }
      }
      try {
        await git(context.piHarnessLaunch.cwd, ["diff", "HEAD", "--check"], maxDiffBytes, timeoutMs);
      } catch (error) {
        const timedOut = typeof error === "object" && error !== null && "killed" in error && (error as { killed?: unknown }).killed === true;
        if (timedOut) throw new Error(`Git review timed out after ${timeoutMs} ms`, { cause: error });
        const output = `${outputOf(error, "stdout")}\n${outputOf(error, "stderr")}`.trim();
        findings.push({ kind: "whitespace", severity: "error", message: output || "git diff --check 检测到空白错误。" });
      }
      const status = findings.some((finding) => finding.severity === "error") ? "error" : findings.length > 0 ? "warning" : "pass";
      return {
        status,
        files: paths.map((path) => fileMap.get(path) ?? { path, added: 0, removed: 0 }),
        findings,
        changedFiles: paths.length,
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
        async execute(): Promise<AgentToolResult<ReviewReport>> {
          latest = await review();
          return {
            content: [
              {
                type: "text",
                text: `${latest.status}: ${latest.changedFiles} files, +${latest.addedLines}/-${latest.removedLines}, ${latest.findings.length} findings.`,
              },
            ],
            details: latest,
          };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "reviewer-bot-panel",
        pluginId: "@pi-harness/core/plugins/reviewer-bot",
        title: "Reviewer Bot",
        description: "只读检查 Git 改动中的空白、凭据和遗留标记风险。",
        icon: "✓",
        read: () => ({ latest: latest ?? null, maxDiffBytes, timeoutMs }),
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
