import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxPromptBytes = 128 * 1024;
type Risk = "safe" | "review" | "blocked";
type Finding = { code: string; severity: "medium" | "high"; message: string };
type PromptGuardReport = { source: string; risk: Risk; score: number; scannedChars: number; findings: Finding[] };
type Pattern = { code: string; severity: Finding["severity"]; score: number; message: string; pattern: RegExp };

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
    score: 5,
    message: "检测到可能要求外传 API key、token 或密码的文本。",
    pattern: /\b(?:api[\s_-]?key|token|password|secret)\b.{0,120}\b(?:send|upload|post|share|curl|wget)\b/iu,
  },
  { code: "remote_payload", severity: "medium", score: 2, message: "检测到从远程地址加载或执行内容的文本。", pattern: /\b(?:curl|wget)\s+https?:\/\//iu },
  {
    code: "system_prompt_probe",
    severity: "medium",
    score: 2,
    message: "检测到探测系统或开发者提示词的文本。",
    pattern: /\b(?:system|developer)\s+(?:prompt|message|instruction)s?\b/iu,
  },
  {
    code: "hidden_instruction",
    severity: "medium",
    score: 2,
    message: "检测到要求隐藏执行意图或绕过披露的文本。",
    pattern: /\b(?:do not|don't)\s+(?:tell|show|disclose)\s+(?:the\s+)?(?:user|human)\b/iu,
  },
];

function inspect(text: string, source: string): PromptGuardReport {
  if (Buffer.byteLength(text, "utf8") > maxPromptBytes) throw new Error(`Prompt guard input must be at most ${maxPromptBytes} bytes`);
  const findings = patterns.filter((item) => item.pattern.test(text)).map(({ code, severity, message }) => ({ code, severity, message }));
  const score = findings.reduce((total, finding) => total + (patterns.find((item) => item.code === finding.code)?.score ?? 0), 0);
  const highFindings = findings.filter((finding) => finding.severity === "high").length;
  const risk: Risk = highFindings >= 2 || score >= 8 ? "blocked" : findings.length > 0 ? "review" : "safe";
  return { source: source.trim().slice(0, 64) || "unknown", risk, score, scannedChars: text.length, findings };
}

function messageText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item !== null && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

export default {
  name: "pi-prompt-guard",
  inject: ["piPluginUi", "piTools"],
  apply(context: Context) {
    let scans = 0;
    let latest: PromptGuardReport | undefined;
    const onSessionEvent = context.on("pi/session-event", (event) => {
      if (event.type !== "message_start" || event.message.role !== "user") return;
      try {
        latest = inspect(messageText(event.message), "message_start");
        scans += 1;
      } catch {
        latest = {
          source: "message_start",
          risk: "review",
          score: 0,
          scannedChars: 0,
          findings: [{ code: "input_limit", severity: "medium", message: "输入超过 Prompt Guard 扫描上限。" }],
        };
        scans += 1;
      }
    });
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "prompt_guard_scan",
        label: "Prompt guard scan",
        description: "Scan text for prompt injection, secret exfiltration, and remote payload indicators without retaining the source text.",
        promptSnippet: "scan untrusted text for prompt injection risks",
        parameters: Type.Object({ text: Type.String(), source: Type.Optional(Type.String()) }),
        execute(_toolCallId, params): Promise<AgentToolResult<PromptGuardReport>> {
          return Promise.resolve().then(() => {
            const report = inspect(params.text, params.source ?? "tool");
            latest = report;
            scans += 1;
            return {
              content: [{ type: "text" as const, text: `${report.risk}: ${report.findings.length} finding(s), score ${report.score}.` }],
              details: report,
            };
          });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "prompt-guard-panel",
      pluginId: "@pi-harness/core/plugins/prompt-guard",
      title: "Prompt Guard",
      description: "扫描潜在提示词注入和秘密外传风险，只保留摘要，不保存原文。",
      icon: "⊘",
      read: () => ({ scans, risk: latest?.risk ?? "safe", latest: latest ?? null }),
    });
    context.effect(() => () => {
      onSessionEvent();
      unregisterTool();
      disposePanel();
    });
  },
};
