import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

/**
 * @typedef {object} PackageManifest
 * @property {string=} name
 * @property {string=} version
 * @property {Record<string, string>=} dependencies
 * @property {Record<string, string>=} devDependencies
 * @property {Record<string, string>=} optionalDependencies
 * @property {Record<string, string>=} peerDependencies
 */

/**
 * @typedef {object} PackageLock
 * @property {string=} version
 * @property {Record<string, PackageManifest>=} packages
 */

/**
 * @typedef {object} MarketplaceEntry
 * @property {string=} packageName
 * @property {string=} version
 */

const args = process.argv.slice(2);
const version = args[0];
const baseIndex = args.indexOf("--base");
// The previous release tag. Without it every plugin keeps the version it declares, which is what a first release wants.
const base = baseIndex === -1 ? undefined : args[baseIndex + 1];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/set-release-version.mjs <major.minor.patch> [--base <git-ref>]");
}

const pluginsRoot = join("packages", "plugins");
const roots = ["packages", pluginsRoot, "apps", "examples"];
const manifestPaths = ["package.json"];

for (const root of roots) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && join(root, entry.name) !== pluginsRoot) manifestPaths.push(join(root, entry.name, "package.json"));
  }
}

const manifests = await Promise.all(
  manifestPaths.map(async (manifestPath) => {
    /** @type {unknown} */
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${manifestPath} does not contain a package manifest`);
    return { manifestPath, value: /** @type {PackageManifest} */ (parsed) };
  }),
);

/** @param {readonly string[]} command */
const gitStatus = (command) => {
  try {
    execFileSync("git", command, { stdio: "ignore" });
    return 0;
  } catch (error) {
    return /** @type {{ status?: number }} */ (error).status ?? 1;
  }
};

/**
 * A plugin is its own npm package, so it only earns a new version when its own directory changed. An unchanged plugin keeps the version already on npm and the publish step skips it.
 * @param {string} directory
 * @param {string} declared
 */
const pluginVersionFor = (directory, declared) => {
  if (base === undefined) return declared;
  // A package that did not exist at the previous release joins the train at the current version rather than starting a version line of its own.
  if (gitStatus(["cat-file", "-e", `${base}:${directory}/package.json`]) !== 0) return version;
  if (gitStatus(["diff", "--quiet", base, "--", directory]) === 0) return declared;
  const [major, minor, patch] = declared.split(".").map(Number);
  return [major, minor, patch + 1].join(".");
};

/** @type {Map<string, string>} */
const versions = new Map();
/** @type {Set<string>} */
const pluginPackageNames = new Set();
for (const { manifestPath, value } of manifests) {
  if (!value.name?.startsWith("@pi-harness/")) continue;
  if (manifestPath.startsWith(`${pluginsRoot}/`)) {
    pluginPackageNames.add(value.name);
    versions.set(value.name, pluginVersionFor(manifestPath.slice(0, -"/package.json".length), value.version ?? version));
  } else {
    versions.set(value.name, version);
  }
}
const dependencyFields = /** @type {const} */ (["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

/** @param {string} range @param {string} candidate */
const satisfiesCaret = (range, candidate) => {
  if (!range.startsWith("^")) return false;
  const [major, minor, patch] = range.slice(1).split(".").map(Number);
  const [candidateMajor, candidateMinor, candidatePatch] = candidate.split(".").map(Number);
  if (candidateMajor !== major) return false;
  // npm reads a caret below 1.0.0 as a minor-locked range, so 0.1.x accepts 0.1.28 and rejects 0.2.0.
  if (major === 0 && candidateMinor !== minor) return false;
  if (candidateMinor !== minor) return candidateMinor > minor;
  return candidatePatch >= patch;
};

/** @param {PackageManifest} value @param {boolean} floating */
const updateDependencies = (value, floating) => {
  for (const field of dependencyFields) {
    for (const [dependency, range] of Object.entries(value[field] ?? {})) {
      const target = versions.get(dependency);
      if (target === undefined) continue;
      // A published plugin tracks the harness through a range, so a patch release of the runtime does not rewrite - and therefore does not republish - every plugin that never changed.
      if (floating) {
        if (!satisfiesCaret(range, target)) value[field][dependency] = `^${target}`;
        continue;
      }
      value[field][dependency] = dependency === "@pi-harness/core" && value.name === "@pi-harness/pi-harness" ? `^${target}` : target;
    }
  }
};

for (const { manifestPath, value } of manifests) {
  if (value.name === undefined || !versions.has(value.name)) continue;
  value.version = versions.get(value.name);
  updateDependencies(value, pluginPackageNames.has(value.name));
  await writeFile(manifestPath, `${JSON.stringify(value, undefined, 2)}\n`);
}

/** @type {unknown} */
const parsedLock = JSON.parse(await readFile("package-lock.json", "utf8"));
if (!parsedLock || typeof parsedLock !== "object" || Array.isArray(parsedLock)) throw new Error("package-lock.json does not contain an object");
const packageLock = /** @type {PackageLock} */ (parsedLock);
packageLock.version = version;
for (const value of Object.values(packageLock.packages ?? {})) {
  if (value.name === undefined || !versions.has(value.name)) continue;
  value.version = versions.get(value.name);
  updateDependencies(value, pluginPackageNames.has(value.name));
}
await writeFile("package-lock.json", `${JSON.stringify(packageLock, undefined, 2)}\n`);

const marketplaceRoot = "packages/api-gateway/src/marketplace-entries";
const marketplacePaths = [];
const directories = [marketplaceRoot];
while (directories.length) {
  const directory = directories.pop();
  if (!directory) continue;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) directories.push(entryPath);
    else if (entry.isFile() && entry.name.endsWith(".json")) marketplacePaths.push(entryPath);
  }
}
for (const marketplacePath of marketplacePaths) {
  const source = await readFile(marketplacePath, "utf8");
  /** @type {unknown} */
  const parsedEntry = JSON.parse(source);
  if (!parsedEntry || typeof parsedEntry !== "object" || Array.isArray(parsedEntry)) throw new Error(`${marketplacePath} does not contain an object`);
  const entry = /** @type {MarketplaceEntry} */ (parsedEntry);
  // The catalog pins the exact version a user installs, so each entry follows the version of its own package rather than the release train.
  const owner = [...versions.keys()].find((packageName) => entry.packageName === packageName || entry.packageName?.startsWith(`${packageName}/`));
  if (owner === undefined) continue;
  // Rewrite only the top-level version line so the formatter-approved layout of the entry (inline short arrays, key order) survives a release; re-serialising with JSON.stringify expanded every array and broke the CI formatting check after each release commit.
  const versionPattern = /^ {2}"version": "[^"]*"/mu;
  if (!versionPattern.test(source)) throw new Error(`${marketplacePath} has no top-level version field to update`);
  const updated = source.replace(versionPattern, `  "version": "${versions.get(owner) ?? version}"`);
  // A re-dispatched release re-runs against a checkout that already carries the target version, so an unchanged entry is a no-op rather than a failure.
  if (updated !== source) await writeFile(marketplacePath, updated);
}
const marketplaceDestination = "packages/api-gateway/dist/marketplace-entries";
await rm(marketplaceDestination, { recursive: true, force: true });
await mkdir("packages/api-gateway/dist", { recursive: true });
await cp(marketplaceRoot, marketplaceDestination, { recursive: true });

process.stdout.write(`${version}\n`);
