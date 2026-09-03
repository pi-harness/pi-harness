import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { resolveExistingWorkspacePath } from "../workspace-path.js";

const maxFiles = 500;
const maxFileBytes = 512 * 1024;
const ignoredDirectories = new Set([".git", ".pi", "node_modules", "dist", "build", "coverage"]);

export type AuditSeverity = "critical" | "high" | "medium";
export type AuditFindingKind = "credential" | "private-key" | "shell-pipeline" | "destructive-command";

export interface AuditFinding {
  path: string;
  line: number;
  severity: AuditSeverity;
  kind: AuditFindingKind;
  message: string;
}

export interface AuditSummary {
  root: string;
  scanned: number;
  skipped: number;
  total: number;
  critical: number;
  high: number;
  medium: number;
  changed: boolean;
  findings: AuditFinding[];
}

const credentialPattern = /\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,})\b/iu;
const privateKeyPattern = /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP )?PRIVATE KEY-----/u;
const assignmentPattern = /^\s*(?:password|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/iu;
const shellPipelinePattern = /\b(?:curl|wget)\b[^\n|]{0,240}\|\s*(?:sh|bash|zsh)\b/iu;
const destructiveCommandPattern = /\brm\s+-rf(?:\s|$)/iu;

function finding(path: string, line: number, severity: AuditSeverity, kind: AuditFindingKind, message: string): AuditFinding {
  return { path, line, severity, kind, message };
}

export function auditText(path: string, source: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  source.split("\n").forEach((lineText, index) => {
    const line = index + 1;
    if (privateKeyPattern.test(lineText)) findings.push(finding(path, line, "critical", "private-key", "Private key material is present in source text."));
    else if (credentialPattern.test(lineText) || assignmentPattern.test(lineText))
      findings.push(finding(path, line, "critical", "credential", "A credential-like value is present in source text."));
    if (shellPipelinePattern.test(lineText)) findings.push(finding(path, line, "high", "shell-pipeline", "A remote script is piped directly into a shell."));
    if (destructiveCommandPattern.test(lineText))
      findings.push(finding(path, line, "high", "destructive-command", "A recursive force delete command is present."));
  });
  return findings;
}

export function summarizeAudit(findings: readonly AuditFinding[], root = ".", scanned = 0, skipped = 0): AuditSummary {
  const critical = findings.filter((item) => item.severity === "critical").length;
  const high = findings.filter((item) => item.severity === "high").length;
  const medium = findings.filter((item) => item.severity === "medium").length;
  return { root, scanned, skipped, total: findings.length, critical, high, medium, changed: findings.length > 0, findings: [...findings] };
}

async function workspaceFiles(root: string, current: string, files: string[]): Promise<void> {
  if (files.length >= maxFiles) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await workspaceFiles(root, fullPath, files);
    } else if (entry.isFile()) {
      files.push(relative(root, fullPath));
    }
  }
}

export async function auditWorkspace(root: string, requested = "."): Promise<AuditSummary> {
  const resolved = await resolveExistingWorkspacePath(root, requested, "Audit path must stay inside the current workspace");
  root = resolved.root;
  const target = resolved.target;
  const metadata = await stat(target);
  const files: string[] = [];
  if (metadata.isFile()) files.push(relative(root, target));
  else if (metadata.isDirectory()) await workspaceFiles(root, target, files);
  else throw new Error("Audit target must be a file or directory");
  const findings: AuditFinding[] = [];
  let skipped = 0;
  for (const file of files) {
    const fullPath = resolve(root, file);
    const fileMetadata = await stat(fullPath);
    if (fileMetadata.size > maxFileBytes) {
      skipped += 1;
      continue;
    }
    const source = await readFile(fullPath, "utf8");
    if (source.includes("\u0000")) {
      skipped += 1;
      continue;
    }
    findings.push(...auditText(file || basename(fullPath), source));
  }
  return summarizeAudit(findings, relative(root, target) || ".", files.length, skipped);
}

function emptySummary(): AuditSummary {
  return summarizeAudit([], ".");
}

export default {
  name: "pi-secure-audit",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: AuditSummary | undefined;
    const unregister = context.piTools.register(
      defineTool({
        name: "security_audit",
        label: "Security audit",
        description: "Read-only scan of workspace text files for exposed credentials and dangerous shell commands; findings are value-redacted.",
        promptSnippet: "audit the workspace for secrets and dangerous commands",
        parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Workspace-relative file or directory to scan" })) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<AuditSummary>> {
          latest = await auditWorkspace(context.piHarnessLaunch.cwd, params.path ?? ".");
          return {
            content: [{ type: "text", text: `${latest.total} findings across ${latest.scanned} files (${latest.critical} critical, ${latest.high} high).` }],
            details: latest,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "secure-audit-panel",
      pluginId: "@pi-harness/core/plugins/secure-audit",
      title: "Secure Audit",
      description: "只读扫描工作区中的凭据泄露和危险命令，结果不会显示敏感值。",
      icon: "⌕",
      read: () => latest ?? emptySummary(),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
