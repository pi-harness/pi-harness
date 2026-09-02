import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { listWorkspaceNodes, type WorkspaceNode } from "./workspace-navigator.js";

const defaultMaxNodes = 300;
const maxComponents = 40;
const maxDependencies = 40;

export interface ArchitectureComponent {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly files: number;
  readonly directories: number;
}

export interface ArchitectureReport {
  readonly workspace: string;
  readonly components: readonly ArchitectureComponent[];
  readonly dependencies: readonly string[];
  readonly truncated: boolean;
  readonly mermaid: string;
}

function componentId(path: string): string {
  const normalized = path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `component_${normalized || "root"}`;
}

function dependencyId(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `dependency_${normalized || "package"}`;
}

function escapeLabel(value: string): string {
  return value.replace(/["\r\n]/g, (character) => (character === '"' ? "&quot;" : " "));
}

function topLevelComponents(nodes: readonly WorkspaceNode[]): ArchitectureComponent[] {
  return nodes
    .filter((node) => node.kind === "directory" && node.depth === 1)
    .slice(0, maxComponents)
    .map((directory) => {
      const prefix = `${directory.path}/`;
      const descendants = nodes.filter((node) => node.path.startsWith(prefix));
      return {
        id: componentId(directory.path),
        label: directory.name,
        path: directory.path,
        files: descendants.filter((node) => node.kind === "file").length,
        directories: descendants.filter((node) => node.kind === "directory").length,
      };
    });
}

async function packageDependencies(root: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as Record<string, unknown>;
    const sections = [parsed.dependencies, parsed.devDependencies, parsed.peerDependencies, parsed.optionalDependencies];
    return [...new Set(sections.flatMap((section) => (section !== null && typeof section === "object" && !Array.isArray(section) ? Object.keys(section) : [])))]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, maxDependencies);
  } catch {
    return [];
  }
}

function render(workspace: string, components: readonly ArchitectureComponent[], dependencies: readonly string[]): string {
  const lines = [`flowchart LR`, `    project["${escapeLabel(basename(workspace) || "workspace")}"]`];
  for (const component of components) {
    lines.push(`    ${component.id}["${escapeLabel(component.label)}\\n${component.files} files · ${component.directories} dirs"]`);
    lines.push(`    project --> ${component.id}`);
  }
  for (const dependency of dependencies) {
    const id = dependencyId(dependency);
    lines.push(`    ${id}["${escapeLabel(dependency)}"]`);
    lines.push(`    project --> ${id}`);
  }
  return lines.join("\n");
}

export async function buildArchitectureReport(root: string, maxNodes = defaultMaxNodes): Promise<ArchitectureReport> {
  const workspace = resolve(root);
  const tree = await listWorkspaceNodes(workspace, { maxDepth: 4, maxNodes: Math.max(1, Math.min(500, Math.trunc(maxNodes))) });
  const components = topLevelComponents(tree.nodes);
  const dependencies = await packageDependencies(workspace);
  return { workspace, components, dependencies, truncated: tree.truncated, mermaid: render(workspace, components, dependencies) };
}

export default {
  name: "pi-archify",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: ArchitectureReport | undefined;
    const unregister = context.piTools.register(
      defineTool({
        name: "architecture_map",
        label: "Architecture map",
        description: "Build a bounded, read-only architecture map from top-level workspace components and package dependencies.",
        promptSnippet: "map the current workspace architecture",
        parameters: Type.Object({ maxNodes: Type.Optional(Type.Number({ description: "Maximum scanned workspace nodes, 1-500" })) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<ArchitectureReport>> {
          latest = await buildArchitectureReport(context.piHarnessLaunch.cwd, params.maxNodes);
          return { content: [{ type: "text", text: latest.mermaid }], details: latest };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "archify-panel",
      pluginId: "@pi-harness/core/plugins/archify",
      title: "Architecture Map",
      description: "从工作区目录和 package.json 依赖生成可审计的架构图源码。",
      icon: "⌘",
      read: () => ({ latest: latest ?? null, componentCount: latest?.components.length ?? 0, dependencyCount: latest?.dependencies.length ?? 0 }),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
