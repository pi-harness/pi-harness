import type { Dirent } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { minVersion, Range, valid as validSemver, validRange } from "semver";
import {
  BoundedFileSizeError,
  BoundedFileTypeError,
  assertKnownConfigKeys,
  isPathInside,
  readBoundedTextFile,
  resolveExistingWorkspacePath,
} from "@pi-harness/plugin-api";

const maxManifestBytes = 1024 * 1024;
const maxManifestPathLength = 1_024;
const maxDependencyDeclarations = 2_000;
const maxPythonConstraintsPerPackage = 64;
const maxConstraintLength = 4_096;
const maxPythonDependencyNameLength = 256;
const maxPythonEnvironmentEntries = 4_096;
const maxNpmConstraintAlternatives = 256;
const maxPythonConstraintAlternatives = 256;

export type DependencyConflict = {
  name: string;
  constraints: string[];
};

export type DependencyReport = {
  manifest: string;
  ecosystem: "npm" | "python";
  declared: number;
  installed: number;
  scanLimit: number;
  missing: string[];
  optionalMissing: string[];
  invalid: string[];
  conflicts: DependencyConflict[];
  unresolved: DependencyConflict[];
};

export type ParsedRequirements = {
  names: string[];
  constraints: DependencyConflict[];
  unresolved: DependencyConflict[];
  invalid: string[];
};

export type DependencyCheckerConfig = Record<never, never>;

export const Config: z<DependencyCheckerConfig> = z.object({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? new Error(signal.reason.message, { cause: signal.reason })
    : new Error("Dependency check was cancelled", { cause: signal.reason });
}

function cloneDependencyReport(report: DependencyReport): DependencyReport {
  return {
    ...report,
    missing: [...report.missing],
    optionalMissing: [...report.optionalMissing],
    invalid: [...report.invalid],
    conflicts: report.conflicts.map((conflict) => ({ name: conflict.name, constraints: [...conflict.constraints] })),
    unresolved: report.unresolved.map((conflict) => ({ name: conflict.name, constraints: [...conflict.constraints] })),
  };
}

function normalizePythonDistributionName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, "-");
}

function constraintGroups(entries: readonly { name: string; constraint: string }[]): DependencyConflict[] {
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const values = grouped.get(entry.name) ?? [];
    if (!values.includes(entry.constraint)) values.push(entry.constraint);
    grouped.set(entry.name, values);
  }
  return [...grouped.entries()].map(([name, constraints]) => ({ name, constraints }));
}

function npmConstraintsConflict(constraints: readonly string[]): boolean {
  const ranges = constraints.flatMap((constraint) => {
    const range = validRange(constraint);
    return range === null ? [] : [range];
  });
  let intersections: string[][] = [[]];
  for (const range of ranges) {
    const next = new Map<string, string[]>();
    for (const current of intersections) {
      for (const comparatorSet of new Range(range).set) {
        const combined = [...current, ...comparatorSet.map((comparator) => comparator.value).filter((value) => value !== "")];
        if (minVersion(combined.join(" ")) === null) continue;
        const key = [...combined].sort().join("\0");
        next.set(key, combined);
        if (next.size > maxNpmConstraintAlternatives) throw new Error(`npm constraint analysis exceeds the ${maxNpmConstraintAlternatives}-alternative limit`);
      }
    }
    intersections = [...next.values()];
    if (intersections.length === 0) return true;
  }
  return false;
}

function pythonSpecifierAlternatives(constraint: string): string[] | undefined {
  const set = constraint.trim();
  if (set === "") return ["*"];
  let alternatives = [""];
  for (const specifier of set.split(",").map((part) => part.trim())) {
    const match = /^(===|==|!=|~=|>=|<=|>|<)\s*(\d+(?:\.\d+){0,2})(\.\*)?$/u.exec(specifier);
    if (match === null) return undefined;
    const operator = match[1]!;
    const release = match[2]!.split(".").map(Number);
    if (release.some((part) => !Number.isSafeInteger(part))) return undefined;
    const version = [...release, 0, 0].slice(0, 3).join(".");
    if (validSemver(version) === null) return undefined;
    let options: string[];
    if (match[3] !== undefined) {
      if ((operator !== "==" && operator !== "!=") || release.length > 2) return undefined;
      const upper = release.length === 1 ? `${release[0]! + 1}.0.0` : `${release[0]}.${release[1]! + 1}.0`;
      if (validSemver(upper) === null) return undefined;
      options = operator === "==" ? [`>=${version} <${upper}`] : [`<${version}`, `>=${upper}`];
    } else if (operator === "!=") {
      options = [`<${version}`, `>${version}`];
    } else if (operator === "~=") {
      if (release.length < 2) return undefined;
      const upper = release.length === 2 ? `${release[0]! + 1}.0.0` : `${release[0]}.${release[1]! + 1}.0`;
      if (validSemver(upper) === null) return undefined;
      options = [`>=${version} <${upper}`];
    } else {
      options = [`${operator === "==" || operator === "===" ? "=" : operator}${version}`];
    }
    alternatives = alternatives.flatMap((current) => options.map((option) => `${current} ${option}`.trim()));
    if (alternatives.length > 32) return undefined;
  }
  return alternatives;
}

function pythonConstraintsConflict(constraints: readonly string[]): boolean {
  let intersections = [""];
  for (const constraint of constraints) {
    const alternatives = pythonSpecifierAlternatives(constraint);
    if (alternatives === undefined) return false;
    const next = new Map<string, string>();
    for (const current of intersections) {
      for (const alternative of alternatives) {
        const combined = `${current} ${alternative}`.trim();
        if (minVersion(combined) === null) continue;
        const key = combined.split(/\s+/u).sort().join("\0");
        next.set(key, combined);
        if (next.size > maxPythonConstraintAlternatives)
          throw new Error(`Python constraint analysis exceeds the ${maxPythonConstraintAlternatives}-alternative limit`);
      }
    }
    intersections = [...next.values()];
    if (intersections.length === 0) return true;
  }
  return false;
}

function npmPackagePath(name: string): readonly string[] | undefined {
  if (name.length === 0 || name.length > 214) return undefined;
  const segment = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
  if (name.startsWith("@")) {
    const parts = name.slice(1).split("/");
    return parts.length === 2 && parts.every((part) => segment.test(part)) ? [`@${parts[0]}`, parts[1]!] : undefined;
  }
  return segment.test(name) ? [name] : undefined;
}

function npmDependencyEntries(record: Record<string, unknown>): Array<{ name: string; constraint: string; optional: boolean }> {
  const entries: Array<{ name: string; constraint: string; optional: boolean }> = [];
  const optionalPeers = new Set<string>();
  const peerMetadata = record.peerDependenciesMeta;
  if (peerMetadata !== undefined) {
    if (!isRecord(peerMetadata)) throw new Error("Manifest peerDependenciesMeta must be an object");
    for (const [name, metadata] of Object.entries(peerMetadata)) {
      if (!isRecord(metadata) || (metadata.optional !== undefined && typeof metadata.optional !== "boolean"))
        throw new Error("Manifest peerDependenciesMeta entries must be objects with an optional boolean optional property");
      if (metadata.optional === true) optionalPeers.add(name);
    }
  }
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const value = record[section];
    if (value === undefined) continue;
    if (!isRecord(value)) throw new Error(`Manifest dependency section ${section} must be an object`);
    for (const [name, constraint] of Object.entries(value)) {
      if (typeof constraint !== "string" || constraint.length > maxConstraintLength)
        throw new Error(`Manifest dependency constraints must be strings of at most ${maxConstraintLength} characters`);
      if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(constraint)) throw new Error("Dependency constraint cannot contain Unicode control characters");
      entries.push({ name, constraint, optional: section === "optionalDependencies" || (section === "peerDependencies" && optionalPeers.has(name)) });
    }
  }
  return entries;
}

function truncateCodePoints(value: string, maximum: number): string {
  const codePoints = [...value];
  return codePoints.length > maximum ? codePoints.slice(0, maximum).join("") : value;
}

function sanitizedRequirementDiagnostic(value: string): string {
  return truncateCodePoints(value.replaceAll(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ").trim(), maxPythonDependencyNameLength).trimEnd();
}

function sanitizedNpmNameDiagnostic(value: string): string {
  const cleaned = truncateCodePoints(value.replaceAll(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ").trim(), maxPythonDependencyNameLength).trimEnd();
  return cleaned === "" ? "(invalid dependency name)" : cleaned;
}

function hasUnsafeRequirementCharacter(value: string): boolean {
  for (const character of value) {
    if (/[\p{Cf}\p{Cs}]/u.test(character)) return true;
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && ((codePoint <= 0x1f && codePoint !== 0x09) || (codePoint >= 0x7f && codePoint <= 0x9f))) return true;
  }
  return false;
}

export function parseRequirements(source: string): ParsedRequirements {
  const entries: { name: string; constraint: string }[] = [];
  const invalid: string[] = [];
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (hasUnsafeRequirementCharacter(line)) {
      invalid.push(sanitizedRequirementDiagnostic(line));
      if (entries.length + invalid.length > maxDependencyDeclarations)
        throw new Error(`Dependency manifest exceeds the ${maxDependencyDeclarations}-dependency scan limit`);
      continue;
    }
    if (line.startsWith("-") || line.startsWith("git+") || line.startsWith("http://") || line.startsWith("https://")) {
      invalid.push(sanitizedRequirementDiagnostic(line));
      if (entries.length + invalid.length > maxDependencyDeclarations)
        throw new Error(`Dependency manifest exceeds the ${maxDependencyDeclarations}-dependency scan limit`);
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*(.*)$/u.exec(line);
    if (!match) {
      invalid.push(sanitizedRequirementDiagnostic(line));
      if (entries.length + invalid.length > maxDependencyDeclarations)
        throw new Error(`Dependency manifest exceeds the ${maxDependencyDeclarations}-dependency scan limit`);
      continue;
    }
    if (match[1]!.length > maxPythonDependencyNameLength)
      throw new Error(`Python dependency name exceeds the ${maxPythonDependencyNameLength}-character limit`);
    const name = normalizePythonDistributionName(match[1]!);
    const constraint = match[2]?.trim() ?? "";
    if (constraint.length > maxConstraintLength) throw new Error(`Python dependency ${name} constraint exceeds the ${maxConstraintLength}-character limit`);
    entries.push({ name, constraint });
    if (entries.length + invalid.length > maxDependencyDeclarations)
      throw new Error(`Dependency manifest exceeds the ${maxDependencyDeclarations}-dependency scan limit`);
  }
  const constraintCounts = new Map<string, Set<string>>();
  for (const entry of entries) {
    const constraints = constraintCounts.get(entry.name) ?? new Set<string>();
    constraints.add(entry.constraint);
    if (constraints.size > maxPythonConstraintsPerPackage)
      throw new Error(`Python dependency ${entry.name} exceeds the ${maxPythonConstraintsPerPackage}-constraint analysis limit`);
    constraintCounts.set(entry.name, constraints);
  }
  const names = [...new Set(entries.map((entry) => entry.name))];
  const groups = constraintGroups(entries);
  const unresolved = groups.filter((group) => group.constraints.some((constraint) => pythonSpecifierAlternatives(constraint) === undefined));
  const unresolvedNames = new Set(unresolved.map((group) => group.name));
  const constraints = groups.filter((group) => !unresolvedNames.has(group.name) && pythonConstraintsConflict(group.constraints));
  return { names, constraints, unresolved, invalid };
}

async function canonicalDirectoryInside(workspace: string, directory: string, signal?: AbortSignal): Promise<string | undefined> {
  throwIfCancelled(signal);
  let canonical: string;
  try {
    canonical = await realpath(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return undefined;
    throw new Error("Could not inspect the local Python environment", { cause: error });
  }
  throwIfCancelled(signal);
  return isPathInside(workspace, canonical) ? canonical : undefined;
}

type PythonEnvironmentScan = { entries: number; directories: Set<string> };

function pythonDistributionNamesFromEntry(entry: Dirent): string[] {
  const lower = entry.name.toLowerCase();
  const names: string[] = [];
  if (entry.isDirectory()) names.push(normalizePythonDistributionName(lower));
  if (entry.isFile()) {
    for (const extension of [".py", ".so", ".pyd"]) {
      if (lower.endsWith(extension)) names.push(normalizePythonDistributionName(lower.slice(0, -extension.length)));
    }
  }
  const metadata = /^(.+)-(\d[^/]*)\.(?:dist|egg)-info$/iu.exec(lower);
  if ((entry.isDirectory() || entry.isFile()) && metadata !== null) names.push(normalizePythonDistributionName(metadata[1]!));
  return names;
}

async function readDirectoryEntries(directory: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof opendir>>> {
  throwIfCancelled(signal);
  try {
    return await opendir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP")
      throw new Error("Python environment directory changed during inspection", { cause: error });
    throw new Error("Could not inspect the local Python environment", { cause: error });
  }
}

function countPythonEnvironmentEntry(scan: PythonEnvironmentScan): void {
  scan.entries += 1;
  if (scan.entries > maxPythonEnvironmentEntries) throw new Error(`Python environment exceeds the ${maxPythonEnvironmentEntries}-entry scan limit`);
}

async function readSitePackageEntries(sitePackages: string | undefined, scan: PythonEnvironmentScan, signal?: AbortSignal): Promise<Dirent[]> {
  if (sitePackages === undefined) return [];
  if (scan.directories.has(sitePackages)) return [];
  scan.directories.add(sitePackages);
  const entries: Dirent[] = [];
  for await (const entry of await readDirectoryEntries(sitePackages, signal)) {
    countPythonEnvironmentEntry(scan);
    throwIfCancelled(signal);
    entries.push(entry);
  }
  return entries;
}

async function installedPythonEntries(workspace: string, scanRoots: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
  const installed = new Set<string>();
  const scan: PythonEnvironmentScan = { entries: 0, directories: new Set() };
  for (const scanRoot of new Set(scanRoots)) {
    for (const environment of [".venv", "venv"]) {
      throwIfCancelled(signal);
      const windowsSitePackages = await canonicalDirectoryInside(workspace, join(scanRoot, environment, "Lib", "site-packages"), signal);
      for (const entry of await readSitePackageEntries(windowsSitePackages, scan, signal)) {
        for (const name of pythonDistributionNamesFromEntry(entry)) installed.add(name);
      }
      const lib = await canonicalDirectoryInside(workspace, join(scanRoot, environment, "lib"), signal);
      if (lib === undefined) continue;
      for await (const version of await readDirectoryEntries(lib, signal)) {
        countPythonEnvironmentEntry(scan);
        throwIfCancelled(signal);
        if (!version.isDirectory() || !version.name.startsWith("python")) continue;
        const sitePackages = await canonicalDirectoryInside(workspace, join(lib, version.name, "site-packages"), signal);
        for (const entry of await readSitePackageEntries(sitePackages, scan, signal)) {
          for (const name of pythonDistributionNamesFromEntry(entry)) installed.add(name);
        }
      }
    }
  }
  return installed;
}

function hasInstalledPythonPackage(entries: ReadonlySet<string>, name: string): boolean {
  return entries.has(normalizePythonDistributionName(name));
}

async function readManifestText(target: string): Promise<string> {
  try {
    return await readBoundedTextFile(target, maxManifestBytes, "Dependency manifest");
  } catch (error) {
    if (error instanceof BoundedFileSizeError) throw new Error("Dependency manifest exceeds the 1 MiB limit", { cause: error });
    if (error instanceof BoundedFileTypeError) throw error;
    throw new Error("Could not read dependency manifest", { cause: error });
  }
}

async function inspectRequirements(workspace: string, target: string, source: string, signal?: AbortSignal): Promise<DependencyReport> {
  const parsed = parseRequirements(source);
  throwIfCancelled(signal);
  const installedEntries = await installedPythonEntries(workspace, [dirname(target), workspace], signal);
  const missing: string[] = [];
  for (const name of parsed.names) {
    throwIfCancelled(signal);
    if (!hasInstalledPythonPackage(installedEntries, name)) missing.push(name);
  }
  return {
    manifest: relative(workspace, target) || ".",
    ecosystem: "python",
    declared: parsed.names.length,
    installed: parsed.names.length - missing.length,
    scanLimit: maxDependencyDeclarations,
    missing,
    optionalMissing: [],
    invalid: parsed.invalid,
    conflicts: parsed.constraints,
    unresolved: parsed.unresolved,
  };
}

export async function inspectManifest(workspace: string, requested = "package.json", signal?: AbortSignal): Promise<DependencyReport> {
  throwIfCancelled(signal);
  let resolved: Awaited<ReturnType<typeof resolveExistingWorkspacePath>>;
  try {
    resolved = await resolveExistingWorkspacePath(workspace, requested, "Manifest path must stay inside the current workspace");
  } catch (error) {
    throw new Error("Could not resolve dependency manifest inside the current workspace", { cause: error });
  }
  throwIfCancelled(signal);
  const target = resolved.target;
  workspace = resolved.root;
  const fileName = basename(target).toLowerCase();
  const requirements = fileName.startsWith("requirements") && fileName.endsWith(".txt");
  if (!requirements && fileName !== "package.json") throw new Error("Dependency manifest must be package.json or requirements*.txt");
  const source = await readManifestText(target);
  throwIfCancelled(signal);
  if (requirements) return inspectRequirements(workspace, target, source, signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("Invalid JSON dependency manifest", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Manifest root must be an object");
  const record = parsed as Record<string, unknown>;
  const entries = npmDependencyEntries(record);
  if (entries.length > maxDependencyDeclarations) throw new Error(`Dependency manifest exceeds the ${maxDependencyDeclarations}-dependency scan limit`);
  const unique = [...new Set(entries.map((entry) => entry.name))];
  const optionalNames = new Set(entries.filter((entry) => entry.optional).map((entry) => entry.name));
  const requiredNames = new Set(entries.filter((entry) => !entry.optional).map((entry) => entry.name));
  const validNames = new Set(unique.filter((name) => npmPackagePath(name) !== undefined));
  const moduleRoots: string[] = [];
  for (let directory = dirname(target); ; directory = dirname(directory)) {
    moduleRoots.push(join(directory, "node_modules"));
    if (directory === workspace) break;
  }
  const missing: string[] = [];
  const optionalMissing: string[] = [];
  const invalid = unique.filter((name) => !validNames.has(name)).map(sanitizedNpmNameDiagnostic);
  for (const name of unique) {
    throwIfCancelled(signal);
    const packagePath = npmPackagePath(name);
    if (packagePath === undefined) continue;
    let found = false;
    for (const moduleRoot of moduleRoots) {
      try {
        const moduleStat = await stat(join(moduleRoot, ...packagePath));
        throwIfCancelled(signal);
        if (moduleStat.isDirectory()) {
          found = true;
          break;
        }
        invalid.push(name);
        found = true;
        break;
      } catch (error) {
        throwIfCancelled(signal);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ELOOP") {
          invalid.push(name);
          found = true;
          break;
        }
        if (code !== "ENOENT" && code !== "ENOTDIR") throw new Error(`Could not inspect installed npm dependency ${name}`, { cause: error });
      }
    }
    if (!found) {
      if (optionalNames.has(name) && !requiredNames.has(name)) optionalMissing.push(name);
      else missing.push(name);
    }
  }
  const constraintGroupsForReport = constraintGroups(entries.filter((entry) => validNames.has(entry.name)));
  const unresolved = constraintGroupsForReport.filter(
    (group) => group.constraints.length > 1 && group.constraints.some((constraint) => validRange(constraint) === null),
  );
  const unresolvedNames = new Set(unresolved.map((group) => group.name));
  return {
    manifest: relative(workspace, target) || ".",
    ecosystem: "npm",
    declared: unique.length,
    installed: unique.length - missing.length - optionalMissing.length - invalid.length,
    scanLimit: maxDependencyDeclarations,
    missing,
    optionalMissing,
    invalid,
    conflicts: constraintGroupsForReport.filter((group) => !unresolvedNames.has(group.name) && npmConstraintsConflict(group.constraints)),
    unresolved,
  };
}

function validateParameters(value: unknown): { manifest?: string } {
  if (value === null || typeof value !== "object") throw new Error("Dependency check parameters must be an object containing only an optional manifest string");
  let descriptors: PropertyDescriptorMap;
  let prototype: unknown;
  let array: boolean;
  try {
    array = Array.isArray(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value) as unknown;
  } catch (error) {
    throw new Error("Dependency check parameters must be an accessible plain object", { cause: error });
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) throw new Error("Dependency check parameters must be a plain object");
  const manifest = descriptors.manifest;
  if (
    Reflect.ownKeys(descriptors).some((key) => key !== "manifest") ||
    (manifest !== undefined &&
      (!("value" in manifest) ||
        typeof manifest.value !== "string" ||
        manifest.value.trim() === "" ||
        manifest.value !== manifest.value.trim() ||
        manifest.value.length > maxManifestPathLength ||
        Buffer.byteLength(manifest.value, "utf8") > maxManifestPathLength ||
        isAbsolute(manifest.value) ||
        /^[A-Za-z]:[\\/]/u.test(manifest.value) ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(manifest.value)))
  )
    throw new Error("Dependency check parameters must be an object containing only an optional manifest string");
  return manifest === undefined ? {} : { manifest: manifest.value as string };
}

export default {
  name: "pi-dependency-checker",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: DependencyCheckerConfig) {
    assertKnownConfigKeys("dependency checker", config, []);
    let latest: DependencyReport | undefined;
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort(new Error("Dependency checker plugin was disposed")));
    const inspect = async (manifest: string | undefined, signal: AbortSignal): Promise<DependencyReport> => {
      const report = await inspectManifest(context.piHarnessLaunch.cwd, manifest, signal);
      throwIfCancelled(signal);
      latest = cloneDependencyReport(report);
      return cloneDependencyReport(report);
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "dependency_check",
        label: "Dependency check",
        description: "Run a bounded, offline package.json or requirements*.txt scan for local dependency presence and conflicting declarations.",
        promptSnippet: "check bounded local dependency presence and declaration conflicts",
        parameters: Type.Object(
          {
            manifest: Type.Optional(
              Type.String({ minLength: 1, maxLength: maxManifestPathLength, description: "package.json or requirements.txt path relative to the workspace" }),
            ),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<DependencyReport>> {
          const params = validateParameters(rawParams);
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([lifecycle.signal, signal]);
          throwIfCancelled(operationSignal);
          const report = await inspect(params.manifest, operationSignal);
          return {
            content: [
              {
                type: "text",
                text: `${report.manifest}: ${report.missing.length} required missing, ${report.optionalMissing.length} optional missing, ${report.invalid.length} invalid, ${report.conflicts.length} conflicts, ${report.unresolved.length} unresolved constraint groups.`,
              },
            ],
            details: report,
          };
        },
      }),
    );
    context.effect(() => unregisterTool);
    const disposePanel = context.piPluginUi.register({
      id: "dependency-checker-panel",
      pluginId: "@pi-harness/core/plugins/dependency-checker",
      title: "Dependency Checker",
      description: "离线检查有界 package.json 或 requirements*.txt 的本地依赖状态和声明冲突。",
      icon: "⊙",
      read: async () => ({ report: latest === undefined ? await inspect(undefined, lifecycle.signal) : cloneDependencyReport(latest) }),
    });
    context.effect(() => disposePanel);
  },
};
