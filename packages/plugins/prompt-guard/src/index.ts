import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "@pi-harness/plugin-api";

const maxPromptBytes = 128 * 1024;
type Risk = "safe" | "review" | "blocked";
type Finding = { code: string; severity: "medium" | "high"; message: string };
type PromptGuardReport = { source: string; risk: Risk; score: number; scannedChars: number; scannedBytes: number; truncated: boolean; findings: Finding[] };
type Pattern = { code: string; severity: Finding["severity"]; score: number; message: string; pattern: RegExp };
const scanParameterNames = new Set(["text", "source"]);

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
    pattern:
      /(?:\b(?:api[\s_-]?key|token|password|secret)\b[\s\S]{0,120}\b(?:send|upload|post|share|curl|wget)\b|\b(?:send|upload|post|share|curl|wget)\b[\s\S]{0,120}\b(?:api[\s_-]?key|token|password|secret)\b)/iu,
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

const riskRank: Record<Risk, number> = { safe: 0, review: 1, blocked: 2 };

function truncateToBytes(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;
  // Cutting inside a multi-byte sequence makes Node decode the trailing bytes as U+FFFD, which is up to two bytes longer than the cut and would push the result back over the limit, so the cut backs off to the last complete sequence.
  let end = maxBytes;
  while (end > 0 && ((encoded[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

function inspect(text: string, source: string, truncated = false): PromptGuardReport {
  if (Buffer.byteLength(text, "utf8") > maxPromptBytes) throw new Error(`Prompt guard input must be at most ${maxPromptBytes} bytes`);
  const findings: Finding[] = patterns.filter((item) => item.pattern.test(text)).map(({ code, severity, message }) => ({ code, severity, message }));
  if (truncated) findings.push({ code: "input_truncated", severity: "medium", message: "仅扫描工具输出的前 128 KiB，剩余内容未扫描。" });
  const score = findings.reduce((total, finding) => total + (patterns.find((item) => item.code === finding.code)?.score ?? 0), 0);
  const highFindings = findings.filter((finding) => finding.severity === "high").length;
  const risk: Risk = highFindings >= 2 || score >= 8 ? "blocked" : findings.length > 0 ? "review" : "safe";
  return {
    source: source.trim().slice(0, 64) || "unknown",
    risk,
    score,
    scannedChars: text.length,
    scannedBytes: Buffer.byteLength(text, "utf8"),
    truncated,
    findings,
  };
}

function dataProperty(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function messageText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const content = dataProperty(message, "content");
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const item = dataProperty(content, String(index));
    if (dataProperty(item, "type") !== "text") continue;
    const text = dataProperty(item, "text");
    if (typeof text === "string") texts.push(text);
  }
  return texts.join("\n");
}

function scanParameters(value: unknown): { text: string; source: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Prompt guard parameters must be an object");
  let prototype: unknown;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new Error("Prompt guard parameters could not be inspected safely", { cause: error });
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Prompt guard parameters must be a plain object");
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !scanParameterNames.has(key)))
    throw new Error("Prompt guard parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Prompt guard parameters must use data properties");
  const text: unknown = descriptors.text?.value;
  const source: unknown = descriptors.source?.value;
  if (typeof text !== "string") throw new Error("Prompt guard text must be a string");
  if (source !== undefined && typeof source !== "string") throw new Error("Prompt guard source must be a string");
  return { text, source: source ?? "tool" };
}

export default {
  name: "pi-prompt-guard",
  inject: ["piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
    let scans = 0;
    let latest: PromptGuardReport | undefined;
    let highest: PromptGuardReport | undefined;
    let activeSession: unknown;
    // Starting or switching a session rebinds the AgentSession without reloading plugins, so the high-water mark has to be cleared here or the panel keeps showing a blocked headline from the previous session.
    const syncSession = (): void => {
      const session: unknown = context.get("piRuntime")?.session;
      if (session === activeSession) return;
      activeSession = session;
      latest = undefined;
      highest = undefined;
      scans = 0;
    };
    const record = (report: PromptGuardReport): void => {
      syncSession();
      latest = report;
      if (highest === undefined || riskRank[report.risk] >= riskRank[highest.risk]) highest = report;
      scans += 1;
    };
    const onSessionEvent = context.on("pi/session-event", (event) => {
      if (dataProperty(event, "type") !== "message_start") return;
      const message = dataProperty(event, "message");
      const role = dataProperty(message, "role");
      if (role === "user") {
        try {
          record(inspect(messageText(message), "message_start"));
        } catch {
          record({
            source: "message_start",
            risk: "review",
            score: 0,
            scannedChars: 0,
            scannedBytes: 0,
            truncated: true,
            findings: [{ code: "input_limit", severity: "medium", message: "输入超过 Prompt Guard 扫描上限。" }],
          });
        }
        return;
      }
      if (role !== "toolResult") return;
      // Tool output is the channel injections actually arrive on. The guard's own result text would be rescanned as safe and overwrite the verdict it just produced, so it is excluded. Tool results routinely exceed the on-demand limit, so the prefix is scanned instead of reporting an input_limit finding.
      const toolName = dataProperty(message, "toolName");
      if (toolName === "prompt_guard_scan") return;
      const source = `tool:${typeof toolName === "string" ? toolName : "unknown"}`;
      // cordis dispatches synchronously, so a throw here would abort the emit for every listener registered after this one.
      try {
        const text = messageText(message);
        record(inspect(truncateToBytes(text, maxPromptBytes), source, Buffer.byteLength(text, "utf8") > maxPromptBytes));
      } catch {
        record({
          source,
          risk: "review",
          score: 0,
          scannedChars: 0,
          scannedBytes: 0,
          truncated: true,
          findings: [{ code: "scan_failed", severity: "medium", message: "工具输出未能完成 Prompt Guard 扫描。" }],
        });
      }
    });
    context.effect(() => onSessionEvent);
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "prompt_guard_scan",
        label: "Prompt guard scan",
        description:
          "Scan text for prompt injection, secret exfiltration, and remote payload indicators without retaining the source text. Reports only; does not block execution or guarantee detection.",
        promptSnippet: "scan untrusted text for prompt injection risks",
        parameters: Type.Object({ text: Type.String(), source: Type.Optional(Type.String()) }, { additionalProperties: false }),
        executionMode: "sequential",
        execute(_toolCallId, params, signal): Promise<AgentToolResult<PromptGuardReport>> {
          return Promise.resolve().then(() => {
            if (signal?.aborted === true || lifecycle.signal.aborted) throw new Error("Prompt guard scan was cancelled");
            const parsed = scanParameters(params);
            const report = inspect(parsed.text, parsed.source);
            record(report);
            return {
              content: [{ type: "text" as const, text: `${report.risk}: ${report.findings.length} finding(s), score ${report.score}.` }],
              details: structuredClone(report),
            };
          });
        },
      }),
    );
    context.effect(() => unregisterTool);
    const disposePanel = context.piPluginUi.register({
      id: "prompt-guard-panel",
      pluginId: "@pi-harness/plugin-prompt-guard",
      title: "Prompt Guard",
      description: "扫描潜在提示词注入和秘密外传风险，只保留摘要，不保存原文。",
      icon: "⊘",
      read: () => {
        syncSession();
        return structuredClone({ scans, risk: latest?.risk ?? "safe", latest: latest ?? null, highest: highest ?? null });
      },
    });
    context.effect(() => disposePanel);
  },
};
