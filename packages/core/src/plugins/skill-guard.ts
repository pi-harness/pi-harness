import { readFile } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxSkillBytes = 128 * 1024;
const maxSkills = 50;

export type SkillGuardRisk = "safe" | "review" | "blocked";
export type SkillGuardFinding = { code: string; severity: "medium" | "high"; message: string };
export type SkillGuardReport = { name: string; risk: SkillGuardRisk; score: number; findings: SkillGuardFinding[] };
export type ScannedSkillReport = SkillGuardReport & { path: string; source: string; scannedBytes: number };

type Pattern = { code: string; severity: SkillGuardFinding["severity"]; score: number; message: string; pattern: RegExp };

const patterns: readonly Pattern[] = [
  {
    code: "instruction_override",
    severity: "high",
    score: 5,
    message: "检测到试图覆盖已有指令的文本。",
    pattern: /\bignore\s+(?:all\s+)?(?:previous|earlier|above)\s+instructions\b/iu,
  },
  {
    code: "secret_exfiltration",
    severity: "high",
    score: 6,
    message: "检测到可能要求外传 API key、token 或密码的文本。",
    pattern: /\b(?:api[\s_-]?key|token|password|secret)\b.{0,120}\b(?:send|upload|post|share|curl|wget)\b/iu,
  },
  {
    code: "remote_exfiltration",
    severity: "high",
    score: 6,
    message: "检测到通过远程命令外传敏感值的文本。",
    pattern: /\b(?:curl|wget)\b.{0,180}\b(?:api[\s_-]?key|token|password|secret)\b/iu,
  },
  {
    code: "remote_payload",
    severity: "medium",
    score: 2,
    message: "检测到从远程地址加载或执行内容的文本。",
    pattern: /\b(?:curl|wget)\s+https?:\/\//iu,
  },
  {
    code: "destructive_command",
    severity: "high",
    score: 6,
    message: "检测到可能破坏工作区或磁盘的命令。",
    pattern: /\b(?:rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-f|mkfs(?:\.[a-z0-9]+)?|dd\s+if=)\b/iu,
  },
  {
    code: "obfuscated_payload",
    severity: "medium",
    score: 3,
    message: "检测到可能用于隐藏执行内容的编码或动态执行。",
    pattern: /\b(?:eval|base64\s+-d|fromcharcode)\b/iu,
  },
];

function skillName(name: string): string {
  return name.trim().slice(0, 64) || "unknown";
}

export function inspectSkillText(text: string, name: string): SkillGuardReport {
  if (Buffer.byteLength(text, "utf8") > maxSkillBytes) throw new Error(`Skill guard input must be at most ${maxSkillBytes} bytes`);
  const findings = patterns.filter((item) => item.pattern.test(text)).map(({ code, severity, message }) => ({ code, severity, message }));
  const score = findings.reduce((total, finding) => total + (patterns.find((item) => item.code === finding.code)?.score ?? 0), 0);
  const risk: SkillGuardRisk = findings.some((finding) => finding.severity === "high") ? "blocked" : findings.length > 0 ? "review" : "safe";
  return { name: skillName(name), risk, score, findings };
}

async function scanLoadedSkills(context: Context): Promise<ScannedSkillReport[]> {
  const loaded = context.piResources.resourceLoader.getSkills();
  const reports: ScannedSkillReport[] = [];
  for (const skill of loaded.skills.slice(0, maxSkills)) {
    try {
      const content = await readFile(skill.filePath, "utf8");
      const report = inspectSkillText(content, skill.name);
      reports.push({ ...report, path: skill.filePath, source: skill.sourceInfo.source, scannedBytes: Buffer.byteLength(content, "utf8") });
    } catch {
      reports.push({
        name: skillName(skill.name),
        risk: "review",
        score: 2,
        findings: [{ code: "read_error", severity: "medium", message: "Skill 文件无法读取，已标记为需要复核。" }],
        path: skill.filePath,
        source: skill.sourceInfo.source,
        scannedBytes: 0,
      });
    }
  }
  return reports;
}

export default {
  name: "pi-skill-guard",
  inject: ["piResources", "piPluginUi", "piTools"],
  apply(context: Context) {
    let reports: ScannedSkillReport[] = [];
    let scans = 0;
    const unregister = context.piTools.register(
      defineTool({
        name: "skill_guard_scan",
        label: "Skill guard scan",
        description:
          "Audit loaded Agent Skills for instruction override, secret exfiltration, destructive commands, and obfuscation without retaining skill source text.",
        promptSnippet: "audit loaded skills for prompt injection and unsafe command risks",
        parameters: Type.Object({ query: Type.Optional(Type.String()) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ total: number; blocked: number; review: number; reports: ScannedSkillReport[] }>> {
          const query = (params.query ?? "").trim().toLocaleLowerCase();
          if (query.length > 120) throw new Error("Skill guard query must contain 0-120 characters");
          reports = await scanLoadedSkills(context);
          scans += 1;
          const filtered = reports.filter((report) => query === "" || `${report.name} ${report.source}`.toLocaleLowerCase().includes(query));
          const result = {
            total: filtered.length,
            blocked: filtered.filter((report) => report.risk === "blocked").length,
            review: filtered.filter((report) => report.risk === "review").length,
            reports: filtered,
          };
          return {
            content: [{ type: "text", text: `${result.total} skill(s) scanned: ${result.blocked} blocked, ${result.review} review.` }],
            details: result,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "skill-guard-panel",
      pluginId: "@pi-harness/core/plugins/skill-guard",
      title: "Skill Guard",
      description: "审计已加载 Skill 的提示词覆盖、秘密外传和危险命令，只保存风险摘要。",
      icon: "◇",
      read: () => ({
        scans,
        total: reports.length,
        blocked: reports.filter((report) => report.risk === "blocked").length,
        review: reports.filter((report) => report.risk === "review").length,
        reports,
      }),
    });
    void scanLoadedSkills(context).then((nextReports) => {
      reports = nextReports;
      scans = 1;
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
