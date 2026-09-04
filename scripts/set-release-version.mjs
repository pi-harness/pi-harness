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

for (const { manifestPath, value } of manifests) {
  if (!packageNames.has(value.name)) continue;
  value.version = version;
  for (const field of dependencyFields) {
    for (const dependency of Object.keys(value[field] ?? {})) {
      if (packageNames.has(dependency)) value[field][dependency] = version;
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(value, undefined, 2)}\n`);
}

process.stdout.write(`${version}\n`);
