import type { Context } from "@deepseek-ai/cordis";
import { parseAllDocuments, isMap, isSeq, type YAMLParseError, type YAMLWarning } from "yaml";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig, readBoundedFile, resolveExistingWorkspacePath } from "@pi-harness/plugin-api";

const maxBytes = 512 * 1024;
const maxPathLength = 4_096;
const maxDocuments = 100;
const maxDiagnostics = 1_000;
const maxToolDiagnostics = 50;
const maxPanelDiagnostics = 50;
const maxDiagnosticMessageLength = 2_000;
const maxStatusErrorLength = 2_000;
const pathParameterNames = new Set(["path"]);
type Diagnostic = { message: string; code?: string; line?: number; column?: number };
type ValidationStatus = { state: "idle" | "running" | "completed" | "failed" | "cancelled"; at?: string; error?: string };
type YamlReport = {
  path: string;
  valid: boolean;
  bytes: number;
  documents: number;
  rootType: string;
  errorCount: number;
  warningCount: number;
  diagnosticsTruncated: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
};

function diagnostic(issue: YAMLParseError | YAMLWarning): Diagnostic {
  const position = issue.linePos?.[0];
  return {
    message: issue.message.slice(0, maxDiagnosticMessageLength),
    ...(typeof issue.code === "string" ? { code: issue.code.slice(0, 128) } : {}),
    ...(position === undefined ? {} : { line: position.line, column: position.col }),
  };
}

function rootType(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (isMap(value)) return "map";
  if (isSeq(value)) return "seq";
  return "scalar";
}

function pathParameter(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("YAML validator parameters must be an object");
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("YAML validator parameters must be a plain object");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !pathParameterNames.has(key)))
      throw new Error("YAML validator parameters contain an unknown property");
    if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("YAML validator parameters must use data properties");
    const path: unknown = descriptors.path?.value as unknown;
    if (typeof path !== "string") throw new Error("YAML validator path must be a string");
    if (path.length === 0 || path.length > maxPathLength) throw new Error(`YAML validator path must contain 1-${maxPathLength} characters`);
    if (path.includes("\0")) throw new Error("YAML validator path must not contain NUL characters");
    return path;
  } catch (error) {
    if (
      error instanceof Error &&
      /^(?:YAML validator parameters must be a plain object|YAML validator parameters contain an unknown property|YAML validator parameters must use data properties|YAML validator path)/u.test(
        error.message,
      )
    )
      throw error;
    throw new Error("YAML validator parameters must be an accessible plain object", { cause: error });
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("YAML validation was cancelled", { cause: signal.reason });
}

function boundedError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, maxStatusErrorLength);
  if (typeof error === "object" && error !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") return descriptor.value.slice(0, maxStatusErrorLength);
  }
  return "Unknown YAML validation error";
}

export default {
  name: "pi-yaml-validator",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    let latest: YamlReport | undefined;
    let status: ValidationStatus = { state: "idle" };
    const validate = async (requested: string, signal: AbortSignal): Promise<YamlReport> => {
      throwIfAborted(signal);
      const location = await resolveExistingWorkspacePath(context.piHarnessLaunch.cwd, requested, "YAML path must stay inside the current workspace");
      throwIfAborted(signal);
      const bytes = await readBoundedFile(location.target, maxBytes, "YAML file");
      throwIfAborted(signal);
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new Error("YAML file must contain valid UTF-8", { cause: error });
      }
      const documents = parseAllDocuments(source);
      throwIfAborted(signal);
      if (documents.length > maxDocuments) throw new Error(`YAML streams cannot exceed ${maxDocuments} documents`);
      const errorCount = documents.reduce((total, document) => total + document.errors.length, 0);
      const warningCount = documents.reduce((total, document) => total + document.warnings.length, 0);
      const errors = documents
        .flatMap((document) => document.errors)
        .slice(0, maxDiagnostics)
        .map(diagnostic);
      const warnings = documents
        .flatMap((document) => document.warnings)
        .slice(0, Math.max(0, maxDiagnostics - errors.length))
        .map(diagnostic);
      const report: YamlReport = {
        path: location.relativePath,
        valid: errorCount === 0,
        bytes: bytes.byteLength,
        documents: documents.length,
        rootType: rootType(documents[0]?.contents),
        errorCount,
        warningCount,
        diagnosticsTruncated: errorCount + warningCount > errors.length + warnings.length,
        errors,
        warnings,
      };
      latest = structuredClone(report);
      return report;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "yaml_validate",
        label: "YAML validate",
        description: "Parse a YAML file in the current workspace and report line-aware errors without modifying it.",
        promptSnippet: "validate a YAML file and report syntax diagnostics",
        parameters: Type.Object(
          { path: Type.String({ description: "YAML path relative to the workspace", minLength: 1, maxLength: maxPathLength }) },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<YamlReport>> {
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          status = { state: "running" };
          try {
            throwIfAborted(operationSignal);
            const report = await validate(pathParameter(params), operationSignal);
            status = { state: "completed", at: new Date().toISOString() };
            const summary = report.valid ? `YAML is valid (${report.documents} document(s)).` : `YAML is invalid with ${report.errorCount} error(s).`;
            const preview = report.errors.slice(0, maxToolDiagnostics);
            const omitted = report.errorCount - preview.length;
            return {
              content: [
                {
                  type: "text",
                  text: `${summary}\n${preview.map((issue) => `${issue.line ?? "?"}:${issue.column ?? "?"} ${issue.message}`).join("\n")}${omitted > 0 ? `\n… ${omitted} additional error(s) omitted from the text preview.` : ""}`,
                },
              ],
              details: structuredClone(report),
            };
          } catch (error) {
            status = { state: operationSignal.aborted ? "cancelled" : "failed", at: new Date().toISOString(), error: boundedError(error) };
            throw error;
          }
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "yaml-validator-panel",
        pluginId: "@pi-harness/plugin-yaml-validator",
        title: "YAML Validator",
        description: "只读解析工作区 YAML，并展示行列级语法诊断。",
        icon: "⌁",
        read: () => {
          const errors = structuredClone(latest?.errors.slice(0, maxPanelDiagnostics) ?? []);
          const warnings = structuredClone(latest?.warnings.slice(0, Math.max(0, maxPanelDiagnostics - errors.length)) ?? []);
          return {
            latest: latest === undefined ? null : { ...structuredClone(latest), errors, warnings },
            status: structuredClone(status),
            maxBytes,
            inventory: {
              errors: { total: latest?.errorCount ?? 0, shown: errors.length, truncated: (latest?.errorCount ?? 0) > errors.length },
              warnings: { total: latest?.warningCount ?? 0, shown: warnings.length, truncated: (latest?.warningCount ?? 0) > warnings.length },
            },
            limits: {
              fileBytes: maxBytes,
              pathCharacters: maxPathLength,
              documents: maxDocuments,
              diagnostics: maxDiagnostics,
              panelDiagnostics: maxPanelDiagnostics,
              toolDiagnostics: maxToolDiagnostics,
              diagnosticMessageCharacters: maxDiagnosticMessageLength,
              statusErrorCharacters: maxStatusErrorLength,
            },
          };
        },
      });
    } catch (error) {
      lifecycle.abort(new Error("YAML validator plugin activation failed", { cause: error }));
      unregisterTool();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("YAML validator plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
