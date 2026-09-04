import { readdir, readFile, writeFile } from "node:fs/promises";
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

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/set-release-version.mjs <major.minor.patch>");
}

const roots = ["packages", "apps", "examples"];
const manifestPaths = ["package.json"];

for (const root of roots) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) manifestPaths.push(join(root, entry.name, "package.json"));
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
/** @type {Set<string>} */
const packageNames = new Set();
for (const { value } of manifests) {
  if (value.name?.startsWith("@pi-harness/")) packageNames.add(value.name);
}
const dependencyFields = /** @type {const} */ (["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

/** @param {PackageManifest} value */
const updateDependencies = (value) => {
  for (const field of dependencyFields) {
    for (const dependency of Object.keys(value[field] ?? {})) {
      if (packageNames.has(dependency)) value[field][dependency] = version;
    }
  }
};

for (const { manifestPath, value } of manifests) {
  if (!packageNames.has(value.name)) continue;
  value.version = version;
  updateDependencies(value);
  await writeFile(manifestPath, `${JSON.stringify(value, undefined, 2)}\n`);
}

/** @type {unknown} */
const parsedLock = JSON.parse(await readFile("package-lock.json", "utf8"));
if (!parsedLock || typeof parsedLock !== "object" || Array.isArray(parsedLock)) throw new Error("package-lock.json does not contain an object");
const packageLock = /** @type {PackageLock} */ (parsedLock);
packageLock.version = version;
for (const value of Object.values(packageLock.packages ?? {})) {
  if (!packageNames.has(value.name)) continue;
  value.version = version;
  updateDependencies(value);
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
  /** @type {unknown} */
  const parsedEntry = JSON.parse(await readFile(marketplacePath, "utf8"));
  if (!parsedEntry || typeof parsedEntry !== "object" || Array.isArray(parsedEntry)) throw new Error(`${marketplacePath} does not contain an object`);
  const entry = /** @type {MarketplaceEntry} */ (parsedEntry);
  const internal = [...packageNames].some((packageName) => entry.packageName === packageName || entry.packageName?.startsWith(`${packageName}/`));
  if (!internal) continue;
  entry.version = version;
  await writeFile(marketplacePath, `${JSON.stringify(entry, undefined, 2)}\n`);
}

process.stdout.write(`${version}\n`);
