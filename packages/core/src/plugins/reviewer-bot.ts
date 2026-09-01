import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const maxFiles = 512;
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
}
export const Config: z<ReviewerBotPluginConfig> = z.object({ maxDiffBytes: z.number().default(1024 * 1024) });

function outputOf(error: unknown, key: "stdout" | "stderr"): string {
  if (typeof error === "object" && error !== null && key in error) return String((error as Record<string, unknown>)[key] ?? "");
  return "";
}

async function git(cwd: string, args: readonly string[], maxBuffer: number): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, maxBuffer });
  return result.stdout;
}

export default {
  name: "pi-reviewer-bot",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: ReviewerBotPluginConfig) {
    const maxDiffBytes = Math.max(16 * 1024, Math.min(8 * 1024 * 1024, Math.trunc(config.maxDiffBytes ?? 1024 * 1024)));
    let latest: ReviewReport | undefined;
    const review = async (): Promise<ReviewReport> => {
      let diff = "";
      let names = "";
      const findings: ReviewFinding[] = [];
      try {
        [diff, names] = await Promise.all([
          git(context.piHarnessLaunch.cwd, ["diff", "HEAD", "--no-ext-diff", "--unified=0"], maxDiffBytes),
          git(context.piHarnessLaunch.cwd, ["diff", "HEAD", "--name-only", "--no-ext-diff"], maxDiffBytes),
        ]);
      } catch (error) {
        throw new Error(
          `Git review requires a repository with a readable HEAD: ${outputOf(error, "stderr").trim() || (error instanceof Error ? error.message : String(error))}`,
        );
      }
      const paths = names
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean)
        .slice(0, maxFiles);
      const fileMap = new Map<string, ReviewFile>();
      let addedLines = 0;
      let removedLines = 0;
      let currentPath: string | undefined;
      for (const line of diff.split("\n")) {
        if (line.startsWith("+++ b/")) {
          currentPath = line.slice(6);
          if (!fileMap.has(currentPath)) fileMap.set(currentPath, { path: currentPath, added: 0, removed: 0 });
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
        await git(context.piHarnessLaunch.cwd, ["diff", "HEAD", "--check"], maxDiffBytes);
      } catch (error) {
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
        parameters: Type.Object({}),
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
    const disposePanel = context.piPluginUi.register({
      id: "reviewer-bot-panel",
      pluginId: "@pi-harness/core/plugins/reviewer-bot",
      title: "Reviewer Bot",
      description: "只读检查 Git 改动中的空白、凭据和遗留标记风险。",
      icon: "✓",
      read: () => ({ latest: latest ?? null, maxDiffBytes }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
