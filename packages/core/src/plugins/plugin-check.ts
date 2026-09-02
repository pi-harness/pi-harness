import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";

const maxScanEntries = 50;
const packageNamePattern = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;
const coreRowIds = new Set(["tools", "session", "llm", "web", "permission", "agent"]);
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

async function checkRepository(path: string, strict: boolean): Promise<PluginCheckReport> {
  const root = resolve(path);
  const checks: Check[] = [];
  const suggestions: string[] = [];
  let manifest: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown;
    manifest = asObject(parsed);
  } catch {
    addIssue(checks, "no-manifest", "failed", "package.json is missing or invalid JSON");
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
  try {
    readme = await readFile(join(root, "README.md"), "utf8");
  } catch {
    readme = "";
  }
  let patchSource: string | undefined;
  for (const filename of ["cordis.patch.yml", "dsh.bundle.patch"]) {
    try {
      patchSource = await readFile(join(root, filename), "utf8");
      break;
    } catch {
      // Try the next supported patch filename.
    }
  }
  if (patchSource === undefined) addIssue(checks, "no-patch", "failed", "no runtime patch or bundle declaration found");
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
  if (/dsh\s+plugin\s+--profile\s+\S+\s+add/iu.test(readme))
    checks.push({ code: "missing-profile-install-example", status: "passed", message: "README has a profile install example" });
  else addIssue(checks, "missing-profile-install-example", "warning", "README has no standard profile install example");
  if (/(?:git\s+apply|cp\s+.*(?:monorepo|src\/)|modify\s+.*core)/iu.test(readme))
    addIssue(checks, "core-modification-required", "failed", "README requires host source modification");
  else checks.push({ code: "core-modification-required", status: "passed", message: "README does not require host source changes" });
  if (await isDirectory(join(root, "src"))) {
    const sourceDir = join(root, "src");
    const files = (await readdir(sourceDir, { recursive: true })).filter((entry): entry is string => typeof entry === "string" && /\.(?:ts|tsx)$/u.test(entry));
    const sources = await Promise.all(files.map((file) => readFile(join(sourceDir, file), "utf8")));
    if (sources.some((source) => /from\s+["'][.][^"']*["']/u.test(source)))
      addIssue(checks, "missing-ts-ext-imports", "warning", "a TypeScript relative import omits its file extension");
    else checks.push({ code: "missing-ts-ext-imports", status: "passed", message: "relative imports include extensions or no source files were found" });
  }
  const errors = checks.filter((check) => check.status === "failed").map(({ code, message }) => ({ code, message }));
  const warnings = checks.filter((check) => check.status === "warning").map(({ code, message }) => ({ code, message }));
  if (errors.some((entry) => entry.code === "no-manifest" || entry.code === "missing-main-or-types"))
    suggestions.push("Add a valid package.json with main/types and a buildable entry point.");
  if (errors.some((entry) => entry.code === "no-patch" || entry.code === "malformed-patch"))
    suggestions.push("Add a valid runtime patch sequence with a unique plugin row id.");
  if (warnings.some((entry) => entry.code === "missing-profile-install-example"))
    suggestions.push("Document the standard dsh plugin --profile web add installation command.");
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
  };
}

function schemaReport(): { checks: Array<{ code: string; label: string }>; verdict: "pass" } {
  return { checks: [...schemaChecks], verdict: "pass" };
}

export default {
  name: "pi-plugin-check",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context, config: { scanLimit?: number }) {
    const scanLimit = Math.max(1, Math.min(maxScanEntries, Math.trunc(config.scanLimit ?? maxScanEntries)));
    let latest: PluginCheckReport | PluginCheckScanReport | ReturnType<typeof schemaReport> | undefined;
    const run = async (action: "check" | "scan" | "schema", requestedPath: string | undefined, strict: boolean): Promise<unknown> => {
      if (action === "schema") {
        latest = schemaReport();
        return latest;
      }
      const target = resolve(context.piHarnessLaunch.cwd, requestedPath ?? ".");
      if (action === "check") {
        latest = await checkRepository(target, strict);
        return latest;
      }
      const entries = await readdir(target, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("dsh-"))
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
        description: "Read-only health checks for DSH plugin repositories; never modifies or builds the inspected path.",
        promptSnippet: "check a DSH plugin repository",
        parameters: Type.Object({
          action: Type.Union(["check", "scan", "schema"]),
          path: Type.Optional(Type.String({ description: "Repository path for check, parent directory for scan" })),
          strict: Type.Optional(Type.Boolean({ description: "Treat warnings as errors" })),
        }),
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
