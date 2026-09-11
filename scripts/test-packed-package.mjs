import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

/**
 * @param {string} cwd
 * @param {...string} args
 */
const runNpmIn = (cwd, ...args) =>
  execFileSync(npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm", npmCli ? [npmCli, ...args] : args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** @param {...string} args */
const runNpm = (...args) => runNpmIn(repositoryRoot, ...args);

/**
 * Reports whether a dependency is reachable from a directory the way Node and npm look for it, which is anywhere along the node_modules chain above it rather than at one fixed path.
 *
 * @param {string} from
 * @param {string} dependency
 */
const isInstalled = (from, dependency) => {
  let cursor = from;
  for (;;) {
    if (existsSync(join(cursor, "node_modules", ...dependency.split("/"), "package.json"))) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
};

/** @param {string} file */
const readManifest = (file) => {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(join(repositoryRoot, file), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed) || typeof parsed.name !== "string")
    throw new Error(`${file} is not a package manifest`);
  return /** @type {PackageManifest & { private?: boolean }} */ (parsed);
};

// Every publishable workspace is a package the launcher installs from the registry like any other dependency, so the smoke test has to resolve them from the tarballs this commit produces. On a release commit the versions being packed are not on npm yet, and a plugin introduced by a pull request never is.
/** @type {Map<string, PackageManifest & { private?: boolean }>} */
const publishable = new Map();
for (const workspaceRoot of ["packages", join("packages", "plugins")]) {
  for (const entry of readdirSync(join(repositoryRoot, workspaceRoot), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(workspaceRoot, entry.name, "package.json");
    if (!existsSync(join(repositoryRoot, manifestPath))) continue;
    const manifest = readManifest(manifestPath);
    if (manifest.private === true) continue;
    publishable.set(manifest.name, manifest);
  }
}

// A plugin can depend on another plugin, so the closure is what has to be packed, not just the names the root manifest happens to list. The post-order walk packs a dependency before the package that needs it.
/** @type {string[]} */
const workspacesToPack = [];
const visited = new Set();
/** @param {string} name */
const collect = (name) => {
  const manifest = publishable.get(name);
  if (manifest === undefined || visited.has(name)) return;
  visited.add(name);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) collect(dependency);
  workspacesToPack.push(name);
};
for (const dependency of Object.keys(readManifest("package.json").dependencies ?? {})) collect(dependency);
if (!workspacesToPack.includes("@pi-harness/core")) throw new Error("The packed launcher no longer depends on @pi-harness/core");

let smokePassed = false;
try {
  process.stdout.write("Packing local dependency tarballs...\n");
  const packed = runNpm(
    "pack",
    ...workspacesToPack.flatMap((name) => ["--workspace", name]),
    "--ignore-scripts",
    "--silent",
    "--pack-destination",
    temporaryRoot,
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (packed.length !== workspacesToPack.length) throw new Error(`npm pack returned ${packed.length} tarballs for ${workspacesToPack.length} workspaces`);
  // The root is packed with its scripts, unlike the workspaces above: prepack is what builds the web application into the tarball and strips the dependency lists the installation can never resolve, so a root tarball produced without it is not the artifact `npm publish` uploads and would prove nothing about it.
  // prepack writes the build it runs to the same stdout, and --silent only quietens npm itself, so the tarball name is the last thing on it rather than the whole of it.
  process.stdout.write("Building and packing the release launcher...\n");
  const filename =
    runNpm("pack", "--silent", "--pack-destination", temporaryRoot)
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.endsWith(".tgz")) ?? "";
  if (filename.length === 0) throw new Error("npm pack did not return a tarball filename");

  // Reproduce npm's global-install collision: users may already have the Pi CLI
  // installed at a different version when they install Pi Harness.
  process.stdout.write("Installing release tarballs into the isolated global prefix...\n");
  runNpm(
    "install",
    "--global",
    "--ignore-scripts",
    "--prefix",
    installPrefix,
    "@earendil-works/pi-coding-agent@0.84.3",
    ...packed.map((tarball) => join(temporaryRoot, tarball)),
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
    if (!isInstalled(agentRoot, dependency)) throw new Error(`Packed pi-coding-agent is missing runtime dependency ${dependency}`);
  }

  // The installation is a workspace root, because that is how the shipped packages/* directories satisfy the launcher's own dependencies, so any npm command a user runs inside it reifies every workspace the tarball ships. A shipped manifest naming an internal package that is neither published nor shipped fails all of them with E404, which is how 0.1.29 turned the installation into a directory npm refused to work in.
  const shippedManifests = ["apps", "packages"].flatMap((group) => {
    const directory = join(harnessRoot, group);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .map((entry) => join(directory, entry.name, "package.json"))
      .filter((candidate) => existsSync(candidate));
  });
  if (shippedManifests.length === 0) throw new Error("The tarball ships no workspace manifest, so the check below would prove nothing");
  for (const manifestPath of shippedManifests) {
    /** @type {unknown} */
    const parsedShipped = JSON.parse(readFileSync(manifestPath, "utf8"));
    const shipped = /** @type {{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }} */ (parsedShipped);
    for (const dependency of Object.keys({ ...shipped.dependencies, ...shipped.devDependencies })) {
      if (!dependency.startsWith("@pi-harness/") || isInstalled(dirname(manifestPath), dependency)) continue;
      throw new Error(
        `${manifestPath.slice(harnessRoot.length + 1)} depends on ${dependency}, which the install neither contains nor can fetch from the registry`,
      );
    }
  }

  await import(pathToFileURL(join(agentRoot, "dist", "cli", "args.js")).href);

  // npm nests a workspace package under the launcher only when a version collision forces it to, and hoists it beside the launcher otherwise, so both layouts are a correct install.
  const coreRoot = [join(harnessRoot, "node_modules", "@pi-harness", "core"), join(installPrefix, "lib", "node_modules", "@pi-harness", "core")].find(
    (candidate) => existsSync(join(candidate, "dist", "index.js")),
  );
  if (coreRoot === undefined) throw new Error("The installed launcher ships no @pi-harness/core to drive the marketplace stage with");
  /** @type {unknown} */
  const importedCore = await import(pathToFileURL(join(coreRoot, "dist", "index.js")).href);
  const installedCore =
    /** @type {{ prepareHarnessProfile: (options: { builtinProfilePath: string; profileName: string; directory: string }) => Promise<string> }} */ (
      importedCore
    );
  // The resolver the loader uses is internal to the package, so the stage reaches for the module the loader itself imports rather than the public surface.
  /** @type {unknown} */
  const importedResolve = await import(pathToFileURL(join(coreRoot, "dist", "plugin-resolve.js")).href);
  const installedResolve = /** @type {{ resolvePluginEntry: (fromFile: string, name: string) => string | undefined }} */ (importedResolve);

  // Bundled entries resolve from the launcher anchor, not the core loader (which
  // npm may hoist beside the launcher). Profile-installed entries take priority
  // at runtime. 0.1.29 named 45 packages that its launcher never depended on.
  const launcherEntry = join(harnessRoot, "apps", "web", "server-dist", "bin.js");
  const shippedProfile = readFileSync(join(harnessRoot, "apps", "web", "profile", "cordis.yml"), "utf8");
  const enabledEntries = [...new Set([...shippedProfile.matchAll(/name: "(@[^"]+)"/gu)].map((match) => match[1] ?? ""))];
  if (enabledEntries.length === 0) throw new Error("The installed profile names no packages, so the checks below would prove nothing");
  const absent = enabledEntries.filter((name) => installedResolve.resolvePluginEntry(launcherEntry, name) === undefined);
  if (absent.length > 0) throw new Error(`The installed profile enables ${absent.length} entr(ies) the install does not contain: ${absent.join(", ")}`);

  // The shipped profile is infrastructure only. A pluggable plugin in it would be bundled into every install and switched on before the user ever opened the plugin center, which is the opposite of installing one from there.
  const bundledPlugins = enabledEntries.filter((name) => name.startsWith("@pi-harness/plugin-"));
  if (bundledPlugins.length > 0) throw new Error(`The installed profile enables ${bundledPlugins.length} pluggable plugin(s): ${bundledPlugins.join(", ")}`);

  // Everything above proves the tarball is well formed; this proves the launcher can still do the one thing that needs the tarball to be well formed at runtime. Installing a marketplace plugin runs npm inside whatever directory owns the booted profile and then imports the package from there, and both halves have failed silently before: npm refused to run inside the installed package at all, and the loader could not resolve an ESM-only package once npm had installed it.
  const harnessHome = join(temporaryRoot, "harness-home");
  const profilePath = await installedCore.prepareHarnessProfile({
    builtinProfilePath: join(harnessRoot, "apps", "web", "profile", "cordis.yml"),
    profileName: "web",
    directory: harnessHome,
  });
  if (!existsSync(join(harnessHome, "package.json"))) throw new Error("Preparing the harness home left no manifest for npm to install against");
  // A plugin the launcher already bundles would resolve from its own node_modules whether or not the install worked, so the subject has to be one that is only reachable through the harness home.
  const marketplacePlugin = [...publishable.keys()].find((name) => name.startsWith("@pi-harness/plugin-") && !workspacesToPack.includes(name));
  if (marketplacePlugin === undefined) throw new Error("No publishable plugin is outside the bundled set to install as a marketplace package");
  const marketplaceTarball = runNpm("pack", "--workspace", marketplacePlugin, "--ignore-scripts", "--silent", "--pack-destination", temporaryRoot).trim();
  if (marketplaceTarball.length === 0) throw new Error(`npm pack produced no tarball for ${marketplacePlugin}`);
  runNpmIn(harnessHome, "install", "--save-exact", "--package-lock=false", "--ignore-scripts", join(temporaryRoot, marketplaceTarball));
  const entry = installedResolve.resolvePluginEntry(profilePath, marketplacePlugin);
  if (entry === undefined || !existsSync(entry)) throw new Error(`${marketplacePlugin} installed into the harness home but the loader cannot resolve it`);

  // Optional headed acceptance runs against the installed entrypoint, before the
  // owned prefix is removed. It must not resolve runtime code from this checkout.
  const browserPython = process.env.PI_HARNESS_PACKED_BROWSER_PYTHON;
  if (browserPython !== undefined) {
    execFileSync(browserPython, [join(repositoryRoot, "scripts", "verify-packed-browser.py"), harnessRoot, temporaryRoot], {
      cwd: temporaryRoot,
      stdio: "inherit",
      timeout: 180_000,
    });
  }

  process.stdout.write(`Packed package smoke test passed (${harnessManifest.name}@${harnessManifest.version})\n`);
  smokePassed = true;
} finally {
  if (!smokePassed && process.env.PI_HARNESS_PACKED_BROWSER_PYTHON !== undefined) {
    process.stderr.write(`Failed headed package installation retained for diagnosis: ${temporaryRoot}\n`);
  } else {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
