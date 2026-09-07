import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Conditions applied to an "exports" target, in the order Node applies them for a dynamic import. "types" is deliberately absent: it names a declaration file, never something that can be imported at runtime.
const importConditions = ["node", "import", "default"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// An "exports" value is either a target (string, array of targets, or a conditions object) or a subpath map. A record is a subpath map only when its keys are subpaths, and the two forms cannot be mixed, so the first key decides.
function isSubpathMap(value: Record<string, unknown>): boolean {
  const first = Object.keys(value)[0];
  return first !== undefined && first.startsWith(".");
}

function splitSpecifier(name: string): { packageName: string; subpath: string } | undefined {
  const segments = name.split("/");
  const scoped = name.startsWith("@");
  if (scoped && segments.length < 2) return undefined;
  const consumed = scoped ? 2 : 1;
  const packageName = segments.slice(0, consumed).join("/");
  if (packageName.length === 0 || segments.slice(0, consumed).some((segment) => segment.length === 0)) return undefined;
  const rest = segments.slice(consumed);
  return { packageName, subpath: rest.length === 0 ? "." : `./${rest.join("/")}` };
}

// Walks the node_modules chain the way Node does, so a package installed next to the profile is found even when the file that names it lives elsewhere.
function findPackageDirectory(fromFile: string, packageName: string): string | undefined {
  let directory = dirname(resolve(fromFile));
  for (;;) {
    const candidate = join(directory, "node_modules", packageName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function readManifest(packageDirectory: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

function selectTarget(target: unknown, match: string | undefined): string | undefined {
  if (typeof target === "string") return match === undefined ? target : target.replaceAll("*", match);
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const selected = selectTarget(candidate, match);
      if (selected !== undefined) return selected;
    }
    return undefined;
  }
  if (!isRecord(target)) return undefined;
  for (const condition of importConditions) {
    if (!(condition in target)) continue;
    const selected = selectTarget(target[condition], match);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

// Resolves one subpath against a subpath map, honouring the single "*" pattern form Node supports. The longest matching pattern wins, as in the specification.
function selectSubpath(map: Record<string, unknown>, subpath: string): string | undefined {
  if (subpath in map) return selectTarget(map[subpath], undefined);
  let bestPrefix: string | undefined;
  let bestMatch: string | undefined;
  let bestKey: string | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) continue;
    if (bestPrefix !== undefined && prefix.length <= bestPrefix.length) continue;
    bestPrefix = prefix;
    bestMatch = subpath.slice(prefix.length, subpath.length - suffix.length);
    bestKey = key;
  }
  if (bestKey === undefined || bestMatch === undefined) return undefined;
  return selectTarget(map[bestKey], bestMatch);
}

/**
 * Resolves a bare plugin specifier to a file path, starting the node_modules walk at `fromFile`.
 *
 * `createRequire(fromFile).resolve(name)` cannot do this: it applies the "require" condition, and a package whose "exports" declares only "import" — every ESM-only plugin, including all of the published Pi Harness ones — is reported as ERR_PACKAGE_PATH_NOT_EXPORTED rather than resolved. That left a marketplace package installed beside the profile installable but not loadable.
 *
 * Returns undefined when the package is absent or its manifest exports nothing for the subpath, which leaves the caller free to fall back to the loader's own import.
 */
export function resolvePluginEntry(fromFile: string, name: string): string | undefined {
  const specifier = splitSpecifier(name);
  if (specifier === undefined) return undefined;
  const packageDirectory = findPackageDirectory(fromFile, specifier.packageName);
  if (packageDirectory === undefined) return undefined;
  const manifest = readManifest(packageDirectory);
  if (manifest === undefined) return undefined;
  const exported = manifest.exports;
  let target: string | undefined;
  if (exported === undefined || exported === null) {
    // A package without "exports" leaves every file reachable, so a subpath is the file and the root is whatever "main" names.
    target = specifier.subpath === "." ? (typeof manifest.main === "string" ? manifest.main : "./index.js") : specifier.subpath;
  } else if (isRecord(exported) && isSubpathMap(exported)) {
    target = selectSubpath(exported, specifier.subpath);
  } else if (specifier.subpath === ".") {
    target = selectTarget(exported, undefined);
  }
  if (target === undefined || !target.startsWith(".")) return undefined;
  const entry = join(packageDirectory, target);
  return existsSync(entry) ? entry : undefined;
}
