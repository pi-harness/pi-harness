import { opendir, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import { BoundedFileSizeError, BoundedFileTypeError, readBoundedTextFile, resolveExistingWorkspacePath } from "@pi-harness/plugin-api";

const maxScanEntries = 50;
const maxSourceEntries = 2_000;
const maxSourceFiles = 500;
const maxSourceFileBytes = 1024 * 1024;
const maxSourceBytes = 8 * 1024 * 1024;
const maxMetadataBytes = 1024 * 1024;
const packageNamePattern = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;
const coreRowIds = new Set(["tools", "session", "llm", "web", "permission", "agent"]);
const ignoredScanDirectories = new Set([".git", "node_modules", ".pi", "dist", "build"]);

export interface PluginCheckConfig {
  scanLimit?: number;
}

export const Config: z<PluginCheckConfig> = z.object({ scanLimit: z.number().default(maxScanEntries) });

export function isPluginRepositoryName(name: string): boolean {
  return (
    name.length > 0 &&
    !ignoredScanDirectories.has(name) &&
    !name.startsWith(".") &&
    (name.startsWith("dsh-") || name.startsWith("pi-") || name.endsWith("-plugin"))
  );
}
const schemaChecks = [
  { code: "no-manifest", label: "package.json exists and is valid JSON" },
  { code: "invalid-name-format", label: "package name follows npm naming rules" },
  { code: "missing-main-or-types", label: "main or types entry is declared" },
  { code: "no-source-entry", label: "a source entry or src directory exists" },
  { code: "no-patch", label: "Runtime patch or bundle declaration exists" },
  { code: "malformed-patch", label: "patch root is a sequence of entries" },
  { code: "duplicate-row-id", label: "patch row ids are unique" },
  { code: "core-row-id", label: "patch does not replace core rows" },
  { code: "missing-profile-install-example", label: "README contains a profile install example" },
  { code: "core-modification-required", label: "installation does not require changing host source" },
  { code: "no-build-script", label: "package declares a build script" },
  { code: "missing-ts-ext-imports", label: "TypeScript relative imports include extensions" },
  { code: "source-scan-incomplete", label: "Source scan stayed within bounded resource limits" },
] as const;

type CheckStatus = "passed" | "failed" | "warning";
type Check = { code: string; status: CheckStatus; message: string };
export interface PluginCheckReport {
  repo: string;
  path: string;
  kind: "registry" | "unknown";
  verdict: "pass" | "warn" | "fail";
  checks: { total: number; passed: number; failed: number; warned: number; skipped: number };
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  suggestions: string[];
  sourceScan?: { checked: number; skipped: number; truncated: boolean };
}
export interface PluginCheckScanReport {
  root: string;
  scanned: number;
  reports: PluginCheckReport[];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
function addIssue(checks: Check[], code: string, status: "failed" | "warning", message: string): void {
  checks.push({ code, status, message });
}
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

async function readBoundedText(path: string): Promise<string> {
  return readBoundedTextFile(path, maxMetadataBytes, "Plugin metadata file");
}

// Bounded-file failures describe the inspected file, so they become a per-file diagnostic instead of being reported as a missing or malformed file.
function metadataFailure(name: string, error: unknown): string | undefined {
  if (error instanceof BoundedFileSizeError) return `${name} exceeds the 1 MiB metadata limit`;
  if (error instanceof BoundedFileTypeError) return `${name} is not a readable regular file`;
  return undefined;
}

async function scanTypeScriptSources(sourceDir: string): Promise<{ sources: string[]; checked: number; skipped: number; truncated: boolean }> {
  const sources: string[] = [];
  let checked = 0;
  let skipped = 0;
  let entries = 0;
  let totalBytes = 0;
  let truncated = false;
  const directory = await opendir(sourceDir, { recursive: true });
  for await (const entry of directory) {
    entries += 1;
    if (entries > maxSourceEntries) {
      truncated = true;
      break;
    }
    if (!/\.(?:ts|tsx)$/u.test(entry.name)) continue;
    if (!entry.isFile()) {
      skipped += 1;
      continue;
    }
    if (checked >= maxSourceFiles) {
      skipped += 1;
      truncated = true;
      continue;
    }
    const remaining = maxSourceBytes - totalBytes;
    if (remaining <= 0) {
      skipped += 1;
      truncated = true;
      continue;
    }
    try {
      const source = await readBoundedTextFile(join(entry.parentPath, entry.name), Math.min(maxSourceFileBytes, remaining), "Plugin source file");
      sources.push(source);
      checked += 1;
      totalBytes += Buffer.byteLength(source, "utf8");
    } catch (error) {
      if (!(error instanceof BoundedFileSizeError || error instanceof BoundedFileTypeError)) throw error;
      skipped += 1;
      if (remaining < maxSourceFileBytes) truncated = true;
    }
  }
  return { sources, checked, skipped, truncated };
}

// Relative ESM specifiers must carry their emitted extension; a trailing dotted segment such as ".js" or ".json" is what marks them as complete.
export function hasExtensionlessRelativeImport(source: string): boolean {
  for (const match of source.matchAll(/from\s+["'](\.[^"']*)["']/gu)) {
    const specifier = match[1];
    if (specifier !== undefined && !/\.[a-z0-9]+$/iu.test(specifier)) return true;
  }
  return false;
}

async function checkRepository(path: string, strict: boolean): Promise<PluginCheckReport> {
  const root = resolve(path);
  const checks: Check[] = [];
  const suggestions: string[] = [];
  let sourceScan: PluginCheckReport["sourceScan"];
  let manifest: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(await readBoundedText(join(root, "package.json"))) as unknown;
    manifest = asObject(parsed);
  } catch (error) {
    addIssue(checks, "no-manifest", "failed", metadataFailure("package.json", error) ?? "package.json is missing or invalid JSON");
  }
  if (manifest !== undefined) checks.push({ code: "no-manifest", status: "passed", message: "package.json is readable" });
  const packageName = typeof manifest?.name === "string" ? manifest.name : "";
  if (packageName === "" || !packageNamePattern.test(packageName)) addIssue(checks, "invalid-name-format", "failed", "package name is not a valid npm name");
  else checks.push({ code: "invalid-name-format", status: "passed", message: "package name is valid" });
  const main = typeof manifest?.main === "string" ? manifest.main : undefined;
  const types = typeof manifest?.types === "string" ? manifest.types : undefined;
  if (main === undefined && types === undefined) addIssue(checks, "missing-main-or-types", "failed", "package.json declares neither main nor types");
  else checks.push({ code: "missing-main-or-types", status: "passed", message: "an entry point is declared" });
  if (await isDirectory(join(root, "src"))) checks.push({ code: "no-source-entry", status: "passed", message: "src directory exists" });
  else if (main !== undefined && (await isDirectory(join(root, "dist"))))
    checks.push({ code: "no-source-entry", status: "passed", message: "dist directory exists" });
  else addIssue(checks, "no-source-entry", "failed", "no src or dist entry directory found");
  const scripts = asObject(manifest?.scripts);
  if (typeof scripts?.build === "string") checks.push({ code: "no-build-script", status: "passed", message: "build script exists" });
  else addIssue(checks, "no-build-script", "warning", "package has no build script");
  let readme: string;
  let readmeIssue: string | undefined;
  try {
    readme = await readBoundedText(join(root, "README.md"));
  } catch (error) {
    readme = "";
    readmeIssue = metadataFailure("README.md", error);
  }
  let patchSource: string | undefined;
  let patchIssue: string | undefined;
  for (const filename of ["cordis.patch.yml", "dsh.bundle.patch"]) {
    try {
      patchSource = await readBoundedText(join(root, filename));
      break;
    } catch (error) {
      // Try the next supported patch filename.
      patchIssue ??= metadataFailure(filename, error);
    }
  }
  if (patchSource === undefined) addIssue(checks, "no-patch", "failed", patchIssue ?? "no runtime patch or bundle declaration found");
  else {
    try {
      const parsed = parse(patchSource) as unknown;
      if (!Array.isArray(parsed)) addIssue(checks, "malformed-patch", "failed", "patch root must be a sequence");
      else {
        checks.push({ code: "malformed-patch", status: "passed", message: "patch root is a sequence" });
        const ids = parsed.flatMap((entry) => {
          const row = asObject(entry);
          return typeof row?.id === "string" ? [row.id] : [];
        });
        if (new Set(ids).size !== ids.length) addIssue(checks, "duplicate-row-id", "failed", "patch contains duplicate row ids");
        else checks.push({ code: "duplicate-row-id", status: "passed", message: "patch row ids are unique" });
        if (ids.some((id) => coreRowIds.has(id))) addIssue(checks, "core-row-id", "failed", "patch attempts to replace a core row");
        else checks.push({ code: "core-row-id", status: "passed", message: "patch does not replace core rows" });
      }
    } catch (error) {
      addIssue(checks, "malformed-patch", "failed", "patch could not be parsed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (/(?:dsh|pi)\s+plugin\s+--profile\s+\S+\s+add/iu.test(readme))
    checks.push({ code: "missing-profile-install-example", status: "passed", message: "README has a profile install example" });
  else addIssue(checks, "missing-profile-install-example", "warning", readmeIssue ?? "README has no standard profile install example");
  if (/(?:git\s+apply|cp\s+.*(?:monorepo|src\/)|modify\s+.*core)/iu.test(readme))
    addIssue(checks, "core-modification-required", "failed", "README requires host source modification");
  else checks.push({ code: "core-modification-required", status: "passed", message: "README does not require host source changes" });
  if (await isDirectory(join(root, "src"))) {
    const sourceDir = join(root, "src");
    const scan = await scanTypeScriptSources(sourceDir);
    sourceScan = { checked: scan.checked, skipped: scan.skipped, truncated: scan.truncated };
    const { sources } = scan;
    if (sources.some((source) => hasExtensionlessRelativeImport(source)))
      addIssue(checks, "missing-ts-ext-imports", "warning", "a TypeScript relative import omits its file extension");
    else checks.push({ code: "missing-ts-ext-imports", status: "passed", message: "relative imports include extensions or no source files were found" });
    if (scan.skipped > 0 || scan.truncated)
      addIssue(checks, "source-scan-incomplete", "warning", `source scan skipped ${scan.skipped} file(s)${scan.truncated ? " and was truncated" : ""}`);
    else checks.push({ code: "source-scan-incomplete", status: "passed", message: "source scan completed within bounded resource limits" });
  }
  const errors = checks.filter((check) => check.status === "failed").map(({ code, message }) => ({ code, message }));
  const warnings = checks.filter((check) => check.status === "warning").map(({ code, message }) => ({ code, message }));
  if (errors.some((entry) => entry.code === "no-manifest" || entry.code === "missing-main-or-types"))
    suggestions.push("Add a valid package.json with main/types and a buildable entry point.");
  if (errors.some((entry) => entry.code === "no-patch" || entry.code === "malformed-patch"))
    suggestions.push("Add a valid runtime patch sequence with a unique plugin row id.");
  if (warnings.some((entry) => entry.code === "missing-profile-install-example"))
    suggestions.push("Document the standard pi plugin --profile web add installation command.");
  const verdict = errors.length > 0 || (strict && warnings.length > 0) ? "fail" : warnings.length > 0 ? "warn" : "pass";
  const passed = checks.filter((check) => check.status === "passed").length;
  return {
    repo: basename(root),
    path: root,
    kind: manifest === undefined ? "unknown" : "registry",
    verdict,
    checks: { total: checks.length, passed, failed: errors.length, warned: warnings.length, skipped: Math.max(0, schemaChecks.length - checks.length) },
    errors,
    warnings,
    suggestions,
    ...(sourceScan === undefined ? {} : { sourceScan }),
  };
}

function schemaReport(): { checks: Array<{ code: string; label: string }>; verdict: "pass" } {
  return { checks: [...schemaChecks], verdict: "pass" };
}

export default {
  name: "pi-plugin-check",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: PluginCheckConfig = {}) {
    const scanLimit = Math.max(1, Math.min(maxScanEntries, Math.trunc(config.scanLimit ?? maxScanEntries)));
    let latest: PluginCheckReport | PluginCheckScanReport | ReturnType<typeof schemaReport> | undefined;
    const run = async (action: "check" | "scan" | "schema", requestedPath: string | undefined, strict: boolean): Promise<unknown> => {
      if (action === "schema") {
        latest = schemaReport();
        return latest;
      }
      const requested = requestedPath ?? ".";
      const workspaceRequest = isAbsolute(requested) ? relative(resolve(context.piHarnessLaunch.cwd), resolve(requested)) || "." : requested;
      const target = (
        await resolveExistingWorkspacePath(context.piHarnessLaunch.cwd, workspaceRequest, "Plugin repository path must stay inside the current workspace")
      ).target;
      if (action === "check") {
        latest = await checkRepository(target, strict);
        return latest;
      }
      const entries = await readdir(target, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isDirectory() && isPluginRepositoryName(entry.name))
        .slice(0, scanLimit)
        .map((entry) => join(target, entry.name));
      const reports = await Promise.all(candidates.map((candidate) => checkRepository(candidate, strict)));
      latest = { root: target, scanned: reports.length, reports };
      return latest;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "plugin_check",
        label: "Check plugins",
        description: "Read-only health checks for Pi Harness plugin repositories; never modifies or builds the inspected path.",
        promptSnippet: "check a Pi Harness plugin repository",
        parameters: Type.Object(
          {
            action: Type.Union([Type.Literal("check"), Type.Literal("scan"), Type.Literal("schema")]),
            path: Type.Optional(Type.String({ description: "Repository path for check, parent directory for scan" })),
            strict: Type.Optional(Type.Boolean({ description: "Treat warnings as errors" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
          const action = params.action;
          if (action !== "check" && action !== "scan" && action !== "schema") throw new Error("plugin_check action must be check, scan, or schema");
          const details = await run(action, params.path, params.strict === true);
          const text =
            action === "schema"
              ? schemaChecks.length + " plugin health checks available."
              : action === "scan"
                ? "Scanned " + (details as PluginCheckScanReport).scanned + " plugin repositories."
                : (details as PluginCheckReport).repo + ": " + (details as PluginCheckReport).verdict;
          return { content: [{ type: "text", text }], details };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "plugin-check-panel",
      pluginId: "@pi-harness/core/plugins/plugin-check",
      title: "Plugin Check",
      description: "只读检查插件清单、patch 和构建陷阱，不修改或构建被检仓库。",
      icon: "✓",
      read: () => ({ scanLimit, latest: latest ?? null }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
