import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

const defaultMaxReceipts = 32;
const maxAllowedReceipts = 256;
const defaultMaxScanBytes = 128 * 1024;
const maxAllowedScanBytes = 512 * 1024;

export interface HolGuardPluginConfig {
  maxReceipts?: number;
  maxScanBytes?: number;
}

export const Config: z<HolGuardPluginConfig> = z.object({
  maxReceipts: z.number().default(defaultMaxReceipts),
  maxScanBytes: z.number().default(defaultMaxScanBytes),
});

export type GuardRisk = "safe" | "review" | "blocked";
export type GuardFinding = { code: string; severity: "medium" | "high"; message: string };
export type GuardReport = { source: string; risk: GuardRisk; score: number; scannedBytes: number; findings: GuardFinding[] };

type GuardPattern = { code: string; severity: GuardFinding["severity"]; score: number; message: string; pattern: RegExp };

const patterns: readonly GuardPattern[] = [
  {
    code: "destructive_command",
    severity: "high",
    score: 6,
    message: "检测到可能删除、重置或覆盖数据的命令。",
    pattern: /\b(?:rm\s+-[a-z]*r[a-z]*f|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|mkfs(?:\.\w+)?|dd\s+if=|:\(\)\s*\{)/iu,
  },
  {
    code: "sensitive_path",
    severity: "high",
    score: 5,
    message: "检测到凭据或私钥所在的敏感路径。",
    pattern: /(?:^|[\s"'=])(?:\.env(?:\.[\w.-]+)?|(?:~\/)?\.ssh\/(?:id_[\w-]+|config|known_hosts)|\.aws\/credentials)(?:$|[\s"'=])/iu,
  },
  {
    code: "credential_pattern",
    severity: "high",
    score: 6,
    message: "检测到可能的 API key、token、密码或私钥内容。",
    pattern: /(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u,
  },
  {
    code: "credential_assignment",
    severity: "high",
    score: 6,
    message: "检测到疑似凭据赋值，例如 API_KEY=、TOKEN= 或 password:。",
    pattern: /(?:api[_-]?key|access[_-]?key|password|secret|token)\s*[:=]\s*\S+/iu,
  },
  {
    code: "remote_exfiltration",
    severity: "medium",
    score: 3,
    message: "检测到向远程地址发送数据的命令，需要人工复核。",
    pattern: /\b(?:curl|wget)\b.{0,200}\b(?:https?:\/\/|--data(?:-raw)?|-d)\b/iu,
  },
  {
    code: "package_install",
    severity: "medium",
    score: 2,
    message: "检测到安装新依赖的操作，需要确认供应链来源。",
    pattern: /\b(?:npm|pnpm|yarn|pip|uv)\s+(?:install|add)\b/iu,
  },
];

function ownData(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function serializeInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return "[unserializable input]";
  }
}

export function inspectGuardInput(input: unknown, source: string, maxScanBytes = defaultMaxScanBytes): GuardReport {
  const serialized = serializeInput(input);
  const sourceLabel = source.trim().slice(0, 64) || "unknown";
  const totalBytes = Buffer.byteLength(serialized, "utf8");
  const scanText = totalBytes > maxScanBytes ? Buffer.from(serialized, "utf8").subarray(0, maxScanBytes).toString("utf8") : serialized;
  const findings = patterns.filter((item) => item.pattern.test(scanText)).map(({ code, severity, message }) => ({ code, severity, message }));
  if (totalBytes > maxScanBytes)
    findings.push({ code: "scan_limit", severity: "medium", message: `输入超过 ${maxScanBytes} bytes 扫描上限，结果需要人工复核。` });
  const score = findings.reduce((total, finding) => total + (patterns.find((item) => item.code === finding.code)?.score ?? 1), 0);
  const risk: GuardRisk = findings.some((finding) => finding.severity === "high") ? "blocked" : findings.length > 0 ? "review" : "safe";
  return { source: sourceLabel, risk, score, scannedBytes: Math.min(totalBytes, maxScanBytes), findings };
}

export default {
  name: "pi-hol-guard",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: HolGuardPluginConfig) {
    assertKnownConfigKeys("pi-hol-guard", config, ["maxReceipts", "maxScanBytes"]);
    const maxReceipts = Math.max(1, Math.min(maxAllowedReceipts, Math.trunc(config.maxReceipts ?? defaultMaxReceipts)));
    const maxScanBytes = Math.max(1024, Math.min(maxAllowedScanBytes, Math.trunc(config.maxScanBytes ?? defaultMaxScanBytes)));
    let events = 0;
    let blocked = 0;
    let review = 0;
    let safe = 0;
    let latest: GuardReport | undefined;
    const receipts: GuardReport[] = [];
    const record = (report: GuardReport): void => {
      events += 1;
      latest = report;
      if (report.risk === "blocked") blocked += 1;
      else if (report.risk === "review") review += 1;
      else safe += 1;
      receipts.unshift(report);
      if (receipts.length > maxReceipts) receipts.length = maxReceipts;
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      if (ownData(event, "type") !== "tool_execution_start") return;
      const toolNameValue = ownData(event, "toolName");
      const toolName = typeof toolNameValue === "string" ? toolNameValue : "unknown";
      const input = ownData(event, "args");
      record(inspectGuardInput({ toolName, input }, `tool:${toolName}`, maxScanBytes));
    });
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "hol_guard_scan",
        label: "HOL Guard scan",
        description:
          "Scan text or tool arguments for destructive commands, sensitive paths, credentials, remote exfiltration, and package-install risks without retaining the source. Advisory only: returns a risk label (safe, review, blocked) and never prevents a tool call from running.",
        promptSnippet: "scan a command or tool payload through the local security guard",
        parameters: Type.Object({ text: Type.String(), source: Type.Optional(Type.String()) }, { additionalProperties: false }),
        executionMode: "sequential",
        execute(_toolCallId, params): Promise<AgentToolResult<GuardReport>> {
          return Promise.resolve().then(() => {
            const report = inspectGuardInput(params.text, params.source ?? "tool", maxScanBytes);
            record(report);
            return {
              content: [{ type: "text" as const, text: `${report.risk}: ${report.findings.length} finding(s), score ${report.score}.` }],
              details: report,
            };
          });
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "hol-guard-panel",
        pluginId: "@pi-harness/core/plugins/hol-guard",
        title: "HOL Guard",
        description: "本地风险扫描和工具调用审计，仅提供建议，不会阻止任何工具执行；只保存风险摘要，不保存原始输入。",
        icon: "⬢",
        read: () => ({ mode: "audit", events, blocked, review, safe, latest: latest ?? null, receipts: receipts.slice(0, 8) }),
      });
    } catch (error) {
      unregisterTool();
      unsubscribe();
      throw error;
    }
    context.effect(() => () => {
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
