import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * @typedef {object} PackageManifest
 * @property {string} name
 * @property {string} version
 * @property {Record<string, string>} dependencies
 * @property {Record<string, string>=} bin
 */

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-harness-packed-package-"));
const installPrefix = join(temporaryRoot, "prefix");
const npmCli = process.env.npm_execpath;

/** @param {...string} args */
const runNpm = (...args) =>
  execFileSync(npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm", npmCli ? [npmCli, ...args] : args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

try {
  // Core depends on the plugin API at the exact version being packed, so the tarball has to be installed alongside it rather than fetched from the registry.
  const pluginApiFilename = runNpm("pack", "--workspace", "@pi-harness/plugin-api", "--ignore-scripts", "--silent", "--pack-destination", temporaryRoot).trim();
  if (pluginApiFilename.length === 0) throw new Error("npm pack did not return a plugin API tarball filename");
  const coreFilename = runNpm("pack", "--workspace", "@pi-harness/core", "--ignore-scripts", "--silent", "--pack-destination", temporaryRoot).trim();
  if (coreFilename.length === 0) throw new Error("npm pack did not return a core tarball filename");
  const filename = runNpm("pack", "--ignore-scripts", "--silent", "--pack-destination", temporaryRoot).trim();
  if (filename.length === 0) throw new Error("npm pack did not return a tarball filename");

  // Reproduce npm's global-install collision: users may already have the Pi CLI
  // installed at a different version when they install Pi Harness.
  runNpm(
    "install",
    "--global",
    "--ignore-scripts",
    "--prefix",
    installPrefix,
    "@earendil-works/pi-coding-agent@0.84.3",
    join(temporaryRoot, pluginApiFilename),
    join(temporaryRoot, coreFilename),
    join(temporaryRoot, filename),
  );

  const harnessRoot = join(installPrefix, "lib", "node_modules", "@pi-harness", "pi-harness");
  const agentRoot = join(harnessRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  /** @type {unknown} */
  const parsedHarnessManifest = JSON.parse(await readFile(join(harnessRoot, "package.json"), "utf8"));
  /** @type {unknown} */
  const parsedAgentManifest = JSON.parse(await readFile(join(agentRoot, "package.json"), "utf8"));
  /** @param {unknown} value */
  const isPackageManifest = (value) =>
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "version" in value &&
    typeof value.version === "string" &&
    "dependencies" in value &&
    typeof value.dependencies === "object" &&
    value.dependencies !== null &&
    !Array.isArray(value.dependencies);
  if (!isPackageManifest(parsedHarnessManifest) || !isPackageManifest(parsedAgentManifest)) throw new Error("Packed package contains an invalid manifest");
  const harnessManifest = /** @type {PackageManifest} */ (parsedHarnessManifest);
  const agentManifest = /** @type {PackageManifest} */ (parsedAgentManifest);

  // The tarball ships build output that is not tracked in git, so an unbuilt or misdeclared `files` allowlist would otherwise publish bin links pointing at nothing.
  const binTargets = Object.entries(harnessManifest.bin ?? {});
  if (binTargets.length === 0) throw new Error("Packed package declares no bin entrypoints");
  for (const [binName, binTarget] of binTargets) {
    if (typeof binTarget !== "string") throw new Error(`Packed package bin ${binName} is not a path`);
    if (!existsSync(join(harnessRoot, binTarget))) throw new Error(`Packed package is missing the ${binName} entrypoint ${binTarget}`);
  }

  const expectedAgentVersion = harnessManifest.dependencies["@earendil-works/pi-coding-agent"];
  if (agentManifest.version !== expectedAgentVersion)
    throw new Error(`Expected bundled pi-coding-agent@${expectedAgentVersion}, received ${agentManifest.version}`);

  for (const dependency of Object.keys(agentManifest.dependencies ?? {})) {
    let cursor = agentRoot;
    let found = false;
    while (true) {
      const candidate = join(cursor, "node_modules", ...dependency.split("/"), "package.json");
      if (existsSync(candidate)) {
        found = true;
        break;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (!found) throw new Error(`Packed pi-coding-agent is missing runtime dependency ${dependency}`);
  }

  await import(pathToFileURL(join(agentRoot, "dist", "cli", "args.js")).href);
  process.stdout.write(`Packed package smoke test passed (${harnessManifest.name}@${harnessManifest.version})\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
