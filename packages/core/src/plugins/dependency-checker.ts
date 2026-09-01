import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type DependencyReport = {
  manifest: string;
  declared: number;
  installed: number;
  missing: string[];
  invalid: string[];
};

function workspacePath(workspace: string, requested: string): string {
  const root = resolve(workspace);
  const target = resolve(root, requested);
  const path = relative(root, target);
  if (path.startsWith("..") || path.includes("/..")) throw new Error("Manifest path must stay inside the current workspace");
  return target;
}

async function inspectManifest(workspace: string, requested = "package.json"): Promise<DependencyReport> {
  const target = workspacePath(workspace, requested);
  const source = await readFile(target, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Manifest root must be an object");
  const record = parsed as Record<string, unknown>;
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const names = sections.flatMap((section) => {
    const value = record[section];
    return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : [];
  });
  const unique = [...new Set(names)];
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const name of unique) {
    const modulePath = join(workspace, "node_modules", ...name.split("/"));
    try {
      const moduleStat = await stat(modulePath);
      if (!moduleStat.isDirectory()) invalid.push(name);
    } catch {
      missing.push(name);
    }
  }
  return {
    manifest: relative(workspace, target) || ".",
    declared: unique.length,
    installed: unique.length - missing.length - invalid.length,
    missing,
    invalid,
  };
}

export default {
  name: "pi-dependency-checker",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: DependencyReport | undefined;
    const inspect = async (manifest?: string): Promise<DependencyReport> => {
      latest = await inspectManifest(context.piHarnessLaunch.cwd, manifest);
      return latest;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "dependency_check",
        label: "Dependency check",
        description: "Inspect a local package.json and report declared dependencies that are missing from node_modules.",
        promptSnippet: "check local dependency installation",
        parameters: Type.Object({ manifest: Type.Optional(Type.String({ description: "Manifest path relative to the workspace" })) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<DependencyReport>> {
          const report = await inspect(params.manifest);
          return { content: [{ type: "text", text: `${report.manifest}: ${report.missing.length} missing dependencies.` }], details: report };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "dependency-checker-panel",
      pluginId: "@pi-harness/core/plugins/dependency-checker",
      title: "Dependency Checker",
      description: "检查 package.json 声明和本地 node_modules 是否一致。",
      icon: "⊙",
      read: async () => ({ report: latest ?? (await inspect()) }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
