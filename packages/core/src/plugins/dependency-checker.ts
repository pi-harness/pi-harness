import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { resolveExistingWorkspacePath } from "../workspace-path.js";

export type DependencyConflict = {
  name: string;
  constraints: string[];
};

export type DependencyReport = {
  manifest: string;
  ecosystem: "npm" | "python";
  declared: number;
  installed: number;
  missing: string[];
  invalid: string[];
  conflicts: DependencyConflict[];
};

export type ParsedRequirements = {
  names: string[];
  constraints: DependencyConflict[];
};

function conflictList(entries: readonly { name: string; constraint: string }[]): DependencyConflict[] {
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const values = grouped.get(entry.name) ?? [];
    if (!values.includes(entry.constraint)) values.push(entry.constraint);
    grouped.set(entry.name, values);
  }
  return [...grouped.entries()].filter(([, constraints]) => constraintsConflict(constraints)).map(([name, constraints]) => ({ name, constraints }));
}

type NumericVersion = readonly number[];

function numericVersion(value: string): NumericVersion | undefined {
  const match = /^v?(\d+(?:\.\d+){0,3})(?:[-+].*)?$/u.exec(value.trim());
  return match?.[1]?.split(".").map(Number);
}

function compareVersions(left: NumericVersion, right: NumericVersion): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function constraintAllows(constraint: string, version: NumericVersion): boolean {
  const parts = constraint
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.every((part) => {
    const match = /^(===|==|=|>=|<=|>|<|\^|~)?\s*(v?\d+(?:\.\d+){0,3}(?:[-+][^\s]+)?)$/u.exec(part);
    if (match === null) return true;
    const candidate = numericVersion(match[2] ?? "");
    if (candidate === undefined) return true;
    const comparison = compareVersions(version, candidate);
    switch (match[1] ?? "=") {
      case ">=":
        return comparison >= 0;
      case "<=":
        return comparison <= 0;
      case ">":
        return comparison > 0;
      case "<":
        return comparison < 0;
      case "^":
        return (
          comparison >= 0 &&
          version[0] === candidate[0] &&
          ((candidate[0] ?? 0) > 0 || (version[1] === candidate[1] && ((candidate[1] ?? 0) > 0 || version[2] === candidate[2])))
        );
      case "~":
        return comparison >= 0 && version[0] === candidate[0] && version[1] === candidate[1];
      default:
        return comparison === 0;
    }
  });
}

function constraintsConflict(constraints: readonly string[]): boolean {
  if (constraints.length < 2) return false;
  const pinned = constraints.flatMap((constraint) => {
    const match = /^(?:===|==|=)?\s*(v?\d+(?:\.\d+){0,3}(?:[-+][^\s]+)?)$/u.exec(constraint);
    const version = match === null ? undefined : numericVersion(match[1] ?? "");
    return version === undefined ? [] : [version];
  });
  if (pinned.length === 0) return false;
  return pinned.some((version) => constraints.some((constraint) => !constraintAllows(constraint, version)));
}

export function parseRequirements(source: string): ParsedRequirements {
  const entries: { name: string; constraint: string }[] = [];
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("-") || line.startsWith("git+") || line.startsWith("http://") || line.startsWith("https://"))
      continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*(.*)$/u.exec(line);
    if (!match) continue;
    const name = match[1]!.toLowerCase().replaceAll("_", "-");
    entries.push({ name, constraint: match[2]?.trim() ?? "" });
  }
  const names = [...new Set(entries.map((entry) => entry.name))];
  return { names, constraints: conflictList(entries) };
}

async function installedPythonPackage(workspace: string, name: string): Promise<boolean> {
  const normalized = name.toLowerCase().replaceAll("-", "_");
  for (const environment of [".venv", "venv"]) {
    const lib = join(workspace, environment, "lib");
    const versions = await readdir(lib, { withFileTypes: true }).catch(() => []);
    for (const version of versions) {
      if (!version.isDirectory() || !version.name.startsWith("python")) continue;
      const sitePackages = join(lib, version.name, "site-packages");
      const entries = await readdir(sitePackages, { withFileTypes: true }).catch(() => []);
      if (entries.some((entry) => entry.name === normalized || entry.name.startsWith(`${normalized}-`) || entry.name.startsWith(`${normalized}.`))) return true;
    }
  }
  return false;
}

async function inspectRequirements(workspace: string, target: string): Promise<DependencyReport> {
  const parsed = parseRequirements(await readFile(target, "utf8"));
  const missing: string[] = [];
  for (const name of parsed.names) {
    if (!(await installedPythonPackage(dirname(target), name)) && !(await installedPythonPackage(workspace, name))) missing.push(name);
  }
  return {
    manifest: relative(workspace, target) || ".",
    ecosystem: "python",
    declared: parsed.names.length,
    installed: parsed.names.length - missing.length,
    missing,
    invalid: [],
    conflicts: parsed.constraints,
  };
}

export async function inspectManifest(workspace: string, requested = "package.json"): Promise<DependencyReport> {
  const resolved = await resolveExistingWorkspacePath(workspace, requested, "Manifest path must stay inside the current workspace");
  const target = resolved.target;
  workspace = resolved.root;
  const source = await readFile(target, "utf8");
  if (basename(target).toLowerCase().startsWith("requirements") && target.toLowerCase().endsWith(".txt")) return inspectRequirements(workspace, target);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON manifest: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Manifest root must be an object");
  const record = parsed as Record<string, unknown>;
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const entries = sections.flatMap((section) => {
    const value = record[section];
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value).map(([name, constraint]) => ({ name, constraint: typeof constraint === "string" ? constraint : String(constraint) }))
      : [];
  });
  const unique = [...new Set(entries.map((entry) => entry.name))];
  const moduleRoots: string[] = [];
  for (let directory = dirname(target); ; directory = dirname(directory)) {
    moduleRoots.push(join(directory, "node_modules"));
    if (directory === workspace) break;
  }
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const name of unique) {
    let found = false;
    for (const moduleRoot of moduleRoots) {
      try {
        const moduleStat = await stat(join(moduleRoot, ...name.split("/")));
        if (moduleStat.isDirectory()) {
          found = true;
          break;
        }
        invalid.push(name);
        found = true;
        break;
      } catch {
        continue;
      }
    }
    if (!found) missing.push(name);
  }
  return {
    manifest: relative(workspace, target) || ".",
    ecosystem: "npm",
    declared: unique.length,
    installed: unique.length - missing.length - invalid.length,
    missing,
    invalid,
    conflicts: conflictList(entries),
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
        description: "Inspect package.json or requirements.txt and report missing dependencies plus conflicting version constraints.",
        promptSnippet: "check local dependency installation and version conflicts",
        parameters: Type.Object({ manifest: Type.Optional(Type.String({ description: "package.json or requirements.txt path relative to the workspace" })) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<DependencyReport>> {
          const report = await inspect(params.manifest);
          return {
            content: [{ type: "text", text: `${report.manifest}: ${report.missing.length} missing dependencies, ${report.conflicts.length} conflicts.` }],
            details: report,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "dependency-checker-panel",
      pluginId: "@pi-harness/core/plugins/dependency-checker",
      title: "Dependency Checker",
      description: "检查 package.json 或 requirements.txt 的依赖安装状态和版本冲突。",
      icon: "⊙",
      read: async () => ({ report: latest ?? (await inspect()) }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
