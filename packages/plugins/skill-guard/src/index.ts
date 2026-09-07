import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { BoundedFileSizeError, EmptyConfig, readBoundedFile } from "@pi-harness/plugin-api";

const maxSkillBytes = 128 * 1024;
const maxSkills = 50;
const maxPanelReports = 20;
const maxQueryLength = 120;
const maxNameCharacters = 64;
const maxSourceCharacters = 128;
const maxPathCharacters = 4_096;
const maxStatusErrorCharacters = 2_000;
const parameterNames = new Set(["query"]);

export type SkillGuardRisk = "safe" | "review" | "blocked";
export type SkillGuardFinding = { code: string; severity: "medium" | "high"; message: string };
export type SkillGuardReport = { name: string; risk: SkillGuardRisk; score: number; findings: SkillGuardFinding[] };
export type ScannedSkillReport = SkillGuardReport & { path: string; source: string; scannedBytes: number };
type SkillGuardStatus = { state: "running" | "completed" | "failed" | "cancelled"; at?: string; error?: string };

type Pattern = { code: string; severity: SkillGuardFinding["severity"]; score: number; message: string; pattern: RegExp };

const patterns: readonly Pattern[] = [
  {
    code: "instruction_override",
    severity: "high",
    score: 5,
    message: "检测到试图覆盖已有指令的文本。",
    pattern: /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|earlier|above|system|developer)\s+(?:instructions?|prompts?|rules?)\b/iu,
  },
  {
    code: "secret_exfiltration",
    severity: "high",
    score: 6,
    message: "检测到可能要求外传 API key、token 或密码的文本。",
    pattern:
      /\b(?:api[\s_-]?(?:key|token)|(?:access|auth)[\s_-]?token|token|password|secret)\b[\s\S]{0,240}\b(?:send|upload|post|share|exfiltrat\w*|curl|wget)\b/iu,
  },
  {
    code: "remote_exfiltration",
    severity: "high",
    score: 6,
    message: "检测到通过远程命令外传敏感值的文本。",
    pattern: /\b(?:curl|wget)\b[\s\S]{0,240}\b(?:api[\s_-]?(?:key|token)|(?:access|auth)[\s_-]?token|token|password|secret)\b/iu,
  },
  {
    code: "remote_payload",
    severity: "medium",
    score: 2,
    message: "检测到从远程地址加载或执行内容的文本。",
    pattern: /\b(?:curl|wget)\b[\s\S]{0,120}https?:\/\//iu,
  },
  {
    code: "destructive_command",
    severity: "high",
    score: 6,
    message: "检测到可能破坏工作区或磁盘的命令。",
    pattern:
      /\b(?:rm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive\s+--force|--force\s+--recursive)\b|git\s+reset\s+--hard\b|git\s+clean\s+-[a-z]*f|mkfs(?:\.[a-z0-9]+)?\b|dd\s+if=)/iu,
  },
  {
    code: "obfuscated_payload",
    severity: "medium",
    score: 3,
    message: "检测到可能用于隐藏执行内容的编码或动态执行。",
    pattern: /\b(?:eval|base64\s+(?:-d|--decode)|fromcharcode|atob)\b/iu,
  },
];
const maxFindingsPerSkill = patterns.length;
const maxFindingCodeCharacters = 64;
const maxFindingMessageCharacters = 256;
const maxScore = patterns.reduce((total, pattern) => total + pattern.score, 0);

class InvalidSkillEncodingError extends Error {}

function metadataText(value: unknown, maximum: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.replaceAll("\0", "�").trim().slice(0, maximum) || fallback;
}

function skillName(name: unknown): string {
  return metadataText(name, maxNameCharacters, "unknown");
}

function dataPropertyDescriptors(value: unknown, label: string): PropertyDescriptorMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error(`${label} must use data properties`);
  return descriptors;
}

function skillMetadata(value: unknown): { name: string; path: string; source: string } {
  const descriptors = dataPropertyDescriptors(value, "Skill metadata");
  const name = skillName(descriptors.name?.value);
  const path = descriptors.filePath?.value as unknown;
  if (typeof path !== "string" || path.length === 0 || path.length > maxPathCharacters || path.includes("\0")) throw new Error("Skill file path is invalid");
  const sourceDescriptors = dataPropertyDescriptors(descriptors.sourceInfo?.value, "Skill source metadata");
  const source = metadataText(sourceDescriptors.source?.value, maxSourceCharacters, "unknown");
  return { name, path, source };
}

function queryParameter(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill Guard parameters must be an object");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Skill Guard parameters must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !parameterNames.has(key)))
    throw new Error("Skill Guard parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Skill Guard parameters must use data properties");
  const query = descriptors.query?.value as unknown;
  if (query !== undefined && typeof query !== "string") throw new Error("Skill Guard query must be a string");
  const normalized = (query ?? "").trim();
  if (normalized.length > maxQueryLength) throw new Error(`Skill guard query must contain 0-${maxQueryLength} characters`);
  if (normalized.includes("\0")) throw new Error("Skill Guard query must not contain NUL characters");
  return normalized.toLocaleLowerCase();
}

export function inspectSkillText(text: string, name: string): SkillGuardReport {
  if (typeof text !== "string") throw new Error("Skill guard input must be a string");
  if (Buffer.byteLength(text, "utf8") > maxSkillBytes) throw new Error(`Skill guard input must be at most ${maxSkillBytes} bytes`);
  const findings = patterns.filter((item) => item.pattern.test(text)).map(({ code, severity, message }) => ({ code, severity, message }));
  const score = findings.reduce((total, finding) => total + (patterns.find((item) => item.code === finding.code)?.score ?? 0), 0);
  const risk: SkillGuardRisk = findings.some((finding) => finding.severity === "high") ? "blocked" : findings.length > 0 ? "review" : "safe";
  return { name: skillName(name), risk, score, findings };
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Skill Guard scan was cancelled", { cause: signal.reason });
}

function boundedError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, maxStatusErrorCharacters);
  if (error !== null && typeof error === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") return descriptor.value.slice(0, maxStatusErrorCharacters);
  }
  return "Unknown Skill Guard error";
}

function reviewReport(
  code: "metadata_error" | "size_limit" | "invalid_utf8" | "read_error",
  metadata: { name: string; path: string; source: string } = { name: "unknown", path: "", source: "unknown" },
): ScannedSkillReport {
  const messages = {
    metadata_error: "Skill 元数据无效，已跳过并标记为需要复核。",
    size_limit: `Skill 文件超过 ${maxSkillBytes} 字节，已跳过并标记为需要复核。`,
    invalid_utf8: "Skill 文件不是有效的 UTF-8，已跳过并标记为需要复核。",
    read_error: "Skill 文件无法读取，已标记为需要复核。",
  } as const;
  return {
    name: metadata.name,
    risk: "review",
    score: 2,
    findings: [{ code, severity: "medium", message: messages[code] }],
    path: metadata.path,
    source: metadata.source,
    scannedBytes: 0,
  };
}

type SkillScan = { reports: ScannedSkillReport[]; available: number; truncated: boolean };

async function scanLoadedSkills(context: Context, signal: AbortSignal): Promise<SkillScan> {
  throwIfCancelled(signal);
  const loadedDescriptors = dataPropertyDescriptors(context.piResources.resourceLoader.getSkills(), "Loaded Skills result");
  const skills = loadedDescriptors.skills?.value as unknown;
  if (!Array.isArray(skills)) throw new Error("Loaded Skills result must contain a skills array");
  const reports: ScannedSkillReport[] = [];
  for (const skill of skills.slice(0, maxSkills)) {
    throwIfCancelled(signal);
    let metadata: { name: string; path: string; source: string };
    try {
      metadata = skillMetadata(skill);
    } catch {
      reports.push(reviewReport("metadata_error"));
      continue;
    }
    try {
      const bytes = await readBoundedFile(metadata.path, maxSkillBytes, "Skill file");
      throwIfCancelled(signal);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new InvalidSkillEncodingError("Skill file must contain valid UTF-8", { cause: error });
      }
      const report = inspectSkillText(content, metadata.name);
      reports.push({ ...report, path: metadata.path, source: metadata.source, scannedBytes: bytes.byteLength });
    } catch (error) {
      throwIfCancelled(signal);
      reports.push(
        reviewReport(
          error instanceof BoundedFileSizeError ? "size_limit" : error instanceof InvalidSkillEncodingError ? "invalid_utf8" : "read_error",
          metadata,
        ),
      );
    }
  }
  throwIfCancelled(signal);
  return { reports, available: skills.length, truncated: skills.length > reports.length };
}

export default {
  name: "pi-skill-guard",
  inject: ["piResources", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  async apply(context: Context) {
    const lifecycle = new AbortController();
    let reports: ScannedSkillReport[] = [];
    let available = 0;
    let truncated = false;
    let scans = 0;
    let status: SkillGuardStatus = { state: "running" };
    const commitScan = (scan: SkillScan): void => {
      reports = structuredClone(scan.reports);
      available = scan.available;
      truncated = scan.truncated;
      scans += 1;
    };
    const unregister = context.piTools.register(
      defineTool({
        name: "skill_guard_scan",
        label: "Skill guard scan",
        description:
          "Audit loaded Agent Skills for instruction override, secret exfiltration, destructive commands, and obfuscation without retaining skill source text.",
        promptSnippet: "audit loaded skills for prompt injection and unsafe command risks",
        parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: maxQueryLength })) }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(
          _toolCallId,
          params,
          signal,
        ): Promise<
          AgentToolResult<{
            total: number;
            blocked: number;
            review: number;
            reports: ScannedSkillReport[];
            inventory: { available: number; scanned: number; truncated: boolean };
          }>
        > {
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          status = { state: "running" };
          try {
            throwIfCancelled(operationSignal);
            const query = queryParameter(params);
            const scan = await scanLoadedSkills(context, operationSignal);
            throwIfCancelled(operationSignal);
            commitScan(scan);
            const filtered = reports.filter((report) => query === "" || `${report.name} ${report.source}`.toLocaleLowerCase().includes(query));
            const result = {
              total: filtered.length,
              blocked: filtered.filter((report) => report.risk === "blocked").length,
              review: filtered.filter((report) => report.risk === "review").length,
              reports: structuredClone(filtered),
              inventory: { available, scanned: reports.length, truncated },
            };
            status = { state: "completed", at: new Date().toISOString() };
            return {
              content: [
                {
                  type: "text",
                  text: `${result.total} matching skill(s) from ${result.inventory.scanned} scanned: ${result.blocked} high-risk, ${result.review} review.`,
                },
              ],
              details: structuredClone(result),
            };
          } catch (error) {
            status = {
              state: operationSignal.aborted ? "cancelled" : "failed",
              at: new Date().toISOString(),
              error: boundedError(error),
            };
            throw error;
          }
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "skill-guard-panel",
        pluginId: "@pi-harness/plugin-skill-guard",
        title: "Skill Guard",
        description: "审计已加载 Skill 的提示词覆盖、秘密外传和危险命令，只保存风险摘要。",
        icon: "◇",
        read: () => {
          const panelReports = structuredClone(reports.slice(0, maxPanelReports));
          return {
            scans,
            total: reports.length,
            blocked: reports.filter((report) => report.risk === "blocked").length,
            review: reports.filter((report) => report.risk === "review").length,
            reports: panelReports,
            status: { ...status },
            inventory: {
              available,
              scanned: reports.length,
              shown: panelReports.length,
              truncated: truncated || reports.length > panelReports.length,
              scanTruncated: truncated,
              displayTruncated: reports.length > panelReports.length,
            },
            limits: {
              queryCharacters: maxQueryLength,
              skillBytes: maxSkillBytes,
              skills: maxSkills,
              panelReports: maxPanelReports,
              nameCharacters: maxNameCharacters,
              sourceCharacters: maxSourceCharacters,
              pathCharacters: maxPathCharacters,
              statusErrorCharacters: maxStatusErrorCharacters,
              findingsPerSkill: maxFindingsPerSkill,
              findingCodeCharacters: maxFindingCodeCharacters,
              findingMessageCharacters: maxFindingMessageCharacters,
              score: maxScore,
            },
          };
        },
      });
    } catch (error) {
      lifecycle.abort(new Error("Skill Guard plugin activation failed", { cause: error }));
      unregister();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Skill Guard plugin was disposed"));
      unregister();
      disposePanel();
    });
    try {
      const initial = await scanLoadedSkills(context, lifecycle.signal);
      commitScan(initial);
      status = { state: "completed", at: new Date().toISOString() };
    } catch (error) {
      status = {
        state: lifecycle.signal.aborted ? "cancelled" : "failed",
        at: new Date().toISOString(),
        error: boundedError(error),
      };
    }
  },
};
