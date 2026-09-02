import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { parseAllDocuments, isMap, isSeq, type YAMLParseError, type YAMLWarning } from "yaml";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxBytes = 512 * 1024;
type Diagnostic = { message: string; code?: string; line?: number; column?: number };
type YamlReport = { path: string; valid: boolean; bytes: number; documents: number; rootType: string; errors: Diagnostic[]; warnings: Diagnostic[] };

function workspacePath(workspace: string, requested: string): { absolute: string; relative: string } {
  const root = resolve(workspace);
  const target = resolve(root, requested);
  const path = relative(root, target);
  if (path.startsWith("..") || path.includes("/..")) throw new Error("YAML path must stay inside the current workspace");
  return { absolute: target, relative: path || "." };
}

function diagnostic(issue: YAMLParseError | YAMLWarning): Diagnostic {
  const position = issue.linePos?.[0];
  return {
    message: issue.message,
    ...(typeof issue.code === "string" ? { code: issue.code } : {}),
    ...(position === undefined ? {} : { line: position.line, column: position.col }),
  };
}

function rootType(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (isMap(value)) return "map";
  if (isSeq(value)) return "seq";
  return "scalar";
}

export default {
  name: "pi-yaml-validator",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: YamlReport | undefined;
    const validate = async (requested: string): Promise<YamlReport> => {
      const workspace = await realpath(context.piHarnessLaunch.cwd);
      const requestedPath = workspacePath(workspace, requested);
      const absolute = await realpath(requestedPath.absolute);
      const location = workspacePath(workspace, absolute);
      const metadata = await stat(location.absolute);
      if (!metadata.isFile()) throw new Error("YAML path is not a file");
      if (metadata.size > maxBytes) throw new Error("YAML file exceeds the 512 KiB validation limit");
      const source = await readFile(location.absolute, "utf8");
      const documents = parseAllDocuments(source);
      const errors = documents.flatMap((document) => document.errors.map(diagnostic));
      const warnings = documents.flatMap((document) => document.warnings.map(diagnostic));
      const report: YamlReport = {
        path: location.relative,
        valid: errors.length === 0,
        bytes: metadata.size,
        documents: documents.length,
        rootType: rootType(documents[0]?.contents),
        errors,
        warnings,
      };
      latest = report;
      return report;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "yaml_validate",
        label: "YAML validate",
        description: "Parse a YAML file in the current workspace and report line-aware errors without modifying it.",
        promptSnippet: "validate a YAML file and report syntax diagnostics",
        parameters: Type.Object({ path: Type.String({ description: "YAML path relative to the workspace" }) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<YamlReport>> {
          const report = await validate(params.path);
          const summary = report.valid ? `YAML is valid (${report.documents} document(s)).` : `YAML is invalid with ${report.errors.length} error(s).`;
          return {
            content: [
              { type: "text", text: `${summary}\n${report.errors.map((issue) => `${issue.line ?? "?"}:${issue.column ?? "?"} ${issue.message}`).join("\n")}` },
            ],
            details: report,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "yaml-validator-panel",
      pluginId: "@pi-harness/core/plugins/yaml-validator",
      title: "YAML Validator",
      description: "只读解析工作区 YAML，并展示行列级语法诊断。",
      icon: "⌁",
      read: () => ({ latest: latest ?? null, maxBytes }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
