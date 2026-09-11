import { opendir, stat } from "node:fs/promises";
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
const ignoredScanDirectories = new Set([".git", "node_modules", ".pi", "dist", "build"]);

export interface PluginCheckConfig {
  scanLimit?: number;
}

export const Config: z<PluginCheckConfig> = z.object({ scanLimit: z.number().default(maxScanEntries) });

export function isPluginRepositoryName(name: string): boolean {
  return name.length > 0 && !ignoredScanDirectories.has(name) && !name.startsWith(".") && (name.startsWith("pi-") || name.endsWith("-plugin"));
}
const schemaChecks = [
  { code: "no-manifest", label: "package.json exists and is valid JSON" },
  { code: "invalid-name-format", label: "package name follows npm naming rules" },
  { code: "missing-main-or-types", label: "main or types entry is declared" },
  { code: "no-source-entry", label: "a source entry or src directory exists" },
  { code: "missing-plugin-metadata", label: "Cordis npm plugin keywords and peer dependency are declared" },
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
  truncated?: boolean;
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

function isNpmPlugin(manifest: Record<string, unknown> | undefined): boolean {
  const peers = asObject(manifest?.peerDependencies);
  return (
    Array.isArray(manifest?.keywords) &&
    manifest.keywords.some((keyword) => keyword === "pi-harness-plugin" || keyword === "cordis") &&
    typeof peers?.["@deepseek-ai/cordis"] === "string"
  );
}

function hasNpmProfileExample(readme: string, packageName: string): boolean {
  const installsPackage = [...readme.matchAll(/(?:^|\n)[ \t]*(?:\$[ \t]+)?npm[ \t]+install[ \t]+([^\r\n;|&#`]+)/gu)].some((command) =>
    (command[1] ?? "").split(/\s+/u).some((argument) => {
      const specifier = argument.replace(/^["']|["']$/gu, "");
      return specifier === packageName || (specifier.startsWith(`${packageName}@`) && specifier.length > packageName.length + 1);
    }),
  );
  if (!installsPackage) return false;
  for (const block of readme.matchAll(/```(?:yaml|yml)\s*\n([\s\S]*?)```/gu)) {
    try {
      const rows: unknown = parse(block[1] ?? "");
      if (Array.isArray(rows) && rows.some((row) => asObject(row)?.name === packageName)) return true;
    } catch {
      /* Invalid examples are not accepted as installation instructions. */
    }
  }
  return false;
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

async function scanTypeScriptSources(
  sourceDir: string,
  signal: AbortSignal,
): Promise<{ sources: string[]; checked: number; skipped: number; truncated: boolean }> {
  const sources: string[] = [];
  let checked = 0;
  let skipped = 0;
  let entries = 0;
  let totalBytes = 0;
  let truncated = false;
  const directory = await opendir(sourceDir, { recursive: true });
  for await (const entry of directory) {
    signal.throwIfAborted();
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

async function checkRepository(path: string, strict: boolean, signal: AbortSignal): Promise<PluginCheckReport> {
  signal.throwIfAborted();
  const root = resolve(path);
  const checks: Check[] = [];
  const suggestions: string[] = [];
  let sourceScan: PluginCheckReport["sourceScan"];
  let manifest: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(await readBoundedText(join(root, "package.json"))) as unknown;
    manifest = asObject(parsed);
    if (manifest === undefined) throw new Error("Manifest must be an object");
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
  const npmPlugin = isNpmPlugin(manifest);
  if (npmPlugin) checks.push({ code: "missing-plugin-metadata", status: "passed", message: "Cordis npm plugin metadata is declared" });
  else
    addIssue(
      checks,
      "missing-plugin-metadata",
      "failed",
      "package must declare a pi-harness-plugin or cordis keyword and the @deepseek-ai/cordis peer dependency",
    );
  if (npmPlugin && hasNpmProfileExample(readme, packageName))
    checks.push({ code: "missing-profile-install-example", status: "passed", message: "README has a profile install example" });
  else addIssue(checks, "missing-profile-install-example", "warning", readmeIssue ?? "README has no standard profile install example");
  if (/(?:git\s+apply|cp\s+.*(?:monorepo|src\/)|modify\s+.*core)/iu.test(readme))
    addIssue(checks, "core-modification-required", "failed", "README requires host source modification");
  else checks.push({ code: "core-modification-required", status: "passed", message: "README does not require host source changes" });
  if (await isDirectory(join(root, "src"))) {
    let scan: Awaited<ReturnType<typeof scanTypeScriptSources>>;
    try {
      const resolved = await resolveExistingWorkspacePath(root, "src", "Plugin source directory must stay inside the repository");
      scan = await scanTypeScriptSources(resolved.target, signal);
    } catch {
      signal.throwIfAborted();
      scan = { sources: [], checked: 0, skipped: 1, truncated: true };
    }
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
  if (errors.some((entry) => entry.code === "missing-plugin-metadata"))
    suggestions.push("Declare plugin keywords and the @deepseek-ai/cordis peer dependency in package.json.");
  if (warnings.some((entry) => entry.code === "missing-profile-install-example"))
    suggestions.push("Document npm installation and a Cordis profile entry matching the package name.");
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
  return { checks: schemaChecks.map((check) => ({ ...check })), verdict: "pass" };
}

export default {
  name: "pi-plugin-check",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: PluginCheckConfig = {}) {
    const scanLimit = Math.max(
      1,
      Math.min(maxScanEntries, Math.trunc(config.scanLimit !== undefined && Number.isFinite(config.scanLimit) ? config.scanLimit : maxScanEntries)),
    );
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort(new Error("Plugin Check disposed")));
    let latest: PluginCheckReport | PluginCheckScanReport | ReturnType<typeof schemaReport> | undefined;
    const readScope = () => {
      const session = context.get("piRuntime")?.session;
      return { session, manager: session?.sessionManager, id: session?.sessionId, cwd: session?.sessionManager.getCwd() ?? context.piHarnessLaunch.cwd };
    };
    let scope = readScope();
    const refreshScope = () => {
      const next = readScope();
      if (scope.session !== next.session || scope.manager !== next.manager || scope.id !== next.id || scope.cwd !== next.cwd) {
        scope = next;
        latest = undefined;
      }
      return scope;
    };
    const run = async (action: "check" | "scan" | "schema", requestedPath: string | undefined, strict: boolean, signal: AbortSignal): Promise<unknown> => {
      signal.throwIfAborted();
      const operationScope = refreshScope();
      if (action === "schema") {
        latest = schemaReport();
        return structuredClone(latest);
      }
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (refreshScope() !== operationScope) throw new Error("Plugin Check workspace changed during inspection");
      };
      const requested = requestedPath ?? ".";
      const workspaceRequest = isAbsolute(requested) ? relative(resolve(operationScope.cwd), resolve(requested)) || "." : requested;
      const target = (await resolveExistingWorkspacePath(operationScope.cwd, workspaceRequest, "Plugin repository path must stay inside the current workspace"))
        .target;
      if (action === "check") {
        const report = await checkRepository(target, strict, signal);
        assertCurrent();
        latest = report;
        return structuredClone(latest);
      }
      const reports: PluginCheckReport[] = [];
      const directory = await opendir(target);
      let entries = 0;
      let truncated = false;
      for await (const entry of directory) {
        signal.throwIfAborted();
        if (++entries > maxSourceEntries || reports.length >= scanLimit) {
          truncated = true;
          break;
        }
        if (!entry.isDirectory() || ignoredScanDirectories.has(entry.name) || entry.name.startsWith(".")) continue;
        const candidate = join(target, entry.name);
        let recognized = isPluginRepositoryName(entry.name);
        if (!recognized) {
          try {
            recognized = isNpmPlugin(asObject(JSON.parse(await readBoundedText(join(candidate, "package.json")))));
          } catch {
            signal.throwIfAborted();
          }
        }
        if (recognized) reports.push(await checkRepository(candidate, strict, signal));
      }
      assertCurrent();
      latest = { root: target, scanned: reports.length, reports, truncated };
      return structuredClone(latest);
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
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
          const action = params.action;
          if (action !== "check" && action !== "scan" && action !== "schema") throw new Error("plugin_check action must be check, scan, or schema");
          const details = await run(
            action,
            params.path,
            params.strict === true,
            signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]),
          );
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        },
      }),
    );
    context.effect(() => unregisterTool);
    const disposePanel = context.piPluginUi.register({
      id: "plugin-check-panel",
      pluginId: "@pi-harness/plugin-plugin-check",
      title: "Plugin Check",
      description: "只读检查 npm 插件清单、安装示例和构建陷阱，不修改或构建被检仓库。",
      icon: "✓",
      read: () => {
        refreshScope();
        return { scanLimit, latest: latest === undefined ? null : structuredClone(latest) };
      },
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
