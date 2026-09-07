import { basename, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig, readBoundedTextFile } from "@pi-harness/plugin-api";
import { listWorkspaceNodes, type WorkspaceNode } from "./workspace-navigator.js";

const defaultMaxNodes = 300;
const maxComponents = 40;
const maxDependencies = 40;
const maxManifestBytes = 1024 * 1024;
const maxDependencyNameLength = 214;

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
  return value.replace(/[&<>"\r\n]/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return character === '"' ? "&quot;" : " ";
  });
}

function normalizeMaxNodes(value: number): number {
  const finite = Number.isFinite(value) ? value : defaultMaxNodes;
  return Math.max(1, Math.min(500, Math.trunc(finite)));
}

function topLevelComponents(nodes: readonly WorkspaceNode[]): { components: ArchitectureComponent[]; truncated: boolean } {
  const directories = nodes.filter((node) => node.kind === "directory" && node.depth === 1);
  const idCounts = new Map<string, number>();
  const components = directories.slice(0, maxComponents).map((directory) => {
    const prefix = `${directory.path}/`;
    const descendants = nodes.filter((node) => node.path.startsWith(prefix));
    const baseId = componentId(directory.path);
    const idCount = (idCounts.get(baseId) ?? 0) + 1;
    idCounts.set(baseId, idCount);
    return {
      id: idCount === 1 ? baseId : `${baseId}_${idCount}`,
      label: directory.name,
      path: directory.path,
      files: descendants.filter((node) => node.kind === "file").length,
      directories: descendants.filter((node) => node.kind === "directory").length,
    };
  });
  return { components, truncated: directories.length > maxComponents };
}

async function packageDependencies(root: string): Promise<{ dependencies: string[]; truncated: boolean }> {
  try {
    const source = await readBoundedTextFile(resolve(root, "package.json"), maxManifestBytes, "Architecture package manifest");
    const parsed: unknown = JSON.parse(source);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { dependencies: [], truncated: true };
    const record = parsed as Record<string, unknown>;
    const sections = [record.dependencies, record.devDependencies, record.peerDependencies, record.optionalDependencies];
    const invalidSection = sections.some((section) => section !== undefined && (section === null || typeof section !== "object" || Array.isArray(section)));
    const all = [
      ...new Set(sections.flatMap((section) => (section !== null && typeof section === "object" && !Array.isArray(section) ? Object.keys(section) : []))),
    ].sort((left, right) => left.localeCompare(right));
    const valid = all.filter((name) => name.length > 0 && name.length <= maxDependencyNameLength);
    return {
      dependencies: valid.slice(0, maxDependencies),
      truncated: invalidSection || valid.length !== all.length || valid.length > maxDependencies,
    };
  } catch (error) {
    const missing = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
    return { dependencies: [], truncated: !missing };
  }
}

function render(workspace: string, components: readonly ArchitectureComponent[], dependencies: readonly string[]): string {
  const lines = [`flowchart LR`, `    project["${escapeLabel(basename(workspace) || "workspace")}"]`];
  for (const component of components) {
    lines.push(`    ${component.id}["${escapeLabel(component.label)}\\n${component.files} files · ${component.directories} dirs"]`);
    lines.push(`    project --> ${component.id}`);
  }
  const dependencyIdCounts = new Map<string, number>();
  for (const dependency of dependencies) {
    const baseId = dependencyId(dependency);
    const idCount = (dependencyIdCounts.get(baseId) ?? 0) + 1;
    dependencyIdCounts.set(baseId, idCount);
    const id = idCount === 1 ? baseId : `${baseId}_${idCount}`;
    lines.push(`    ${id}["${escapeLabel(dependency)}"]`);
    lines.push(`    project --> ${id}`);
  }
  return lines.join("\n");
}

export async function buildArchitectureReport(root: string, maxNodes = defaultMaxNodes): Promise<ArchitectureReport> {
  const workspace = resolve(root);
  const tree = await listWorkspaceNodes(workspace, { maxDepth: 4, maxNodes: normalizeMaxNodes(maxNodes) });
  const componentScan = topLevelComponents(tree.nodes);
  const dependencyScan = await packageDependencies(workspace);
  return {
    workspace,
    components: componentScan.components,
    dependencies: dependencyScan.dependencies,
    truncated: tree.truncated || componentScan.truncated || dependencyScan.truncated,
    mermaid: render(workspace, componentScan.components, dependencyScan.dependencies),
  };
}

export default {
  name: "pi-archify",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let latest: ArchitectureReport | undefined;
    const unregister = context.piTools.register(
      defineTool({
        name: "architecture_map",
        label: "Architecture map",
        description: "Build a bounded, read-only architecture map from top-level workspace components and package dependencies.",
        promptSnippet: "map the current workspace architecture",
        parameters: Type.Object(
          {
            maxNodes: Type.Optional(Type.Integer({ description: "Maximum scanned workspace nodes, 1-500", minimum: 1, maximum: 500 })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params): Promise<AgentToolResult<ArchitectureReport>> {
          latest = await buildArchitectureReport(context.piHarnessLaunch.cwd, params.maxNodes);
          return { content: [{ type: "text", text: latest.mermaid }], details: structuredClone(latest) };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "archify-panel",
      pluginId: "@pi-harness/core/plugins/archify",
      title: "Architecture Map",
      description: "从工作区目录和 package.json 依赖生成可审计的架构图源码。",
      icon: "⌘",
      read: () => ({
        latest: latest === undefined ? null : structuredClone(latest),
        componentCount: latest?.components.length ?? 0,
        dependencyCount: latest?.dependencies.length ?? 0,
      }),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
