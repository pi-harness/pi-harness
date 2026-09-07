import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

const readText = (path: string): string => readFileSync(resolve(repositoryRoot, path), "utf8");
const readJson = (path: string): Record<string, unknown> => JSON.parse(readText(path)) as Record<string, unknown>;

function sourceFiles(directory: string, extension: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [path] : [];
  });
}

// Reduces a bare module specifier such as "@scope/name/subpath" or "name/subpath" to the npm package that provides it.
function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
}

function workspaceNameFor(binTarget: string): string {
  let directory = dirname(resolve(repositoryRoot, binTarget));
  while (directory !== repositoryRoot) {
    const manifest = join(directory, "package.json");
    if (statSync(manifest, { throwIfNoEntry: false })?.isFile()) return (JSON.parse(readFileSync(manifest, "utf8")) as { name: string }).name;
    directory = dirname(directory);
  }
  throw new Error(`No workspace manifest above ${binTarget}`);
}

describe("release contract", () => {
  const workflow = readText(".github/workflows/release.yml");

  test("publish step retries after a failed publish instead of trusting the release tag", () => {
    // The tag is pushed before npm publish runs, so its existence must never be used as evidence that a package version was submitted.
    expect(workflow).not.toContain("RELEASE_TAG_EXISTS");
    expect(workflow).not.toContain("was already submitted");
    expect(workflow).not.toContain("tag_exists=$tag_exists");
    expect(workflow).toContain('npm publish --workspace "$package_name" --access public');
    expect(workflow).toContain("npm publish --access public");
  });

  test("publishes every plugin package on its own version line", () => {
    // A plugin carries its own semver, so the release has to know which plugins actually changed instead of bumping all of them behind the launcher.
    expect(workflow).toContain('node scripts/set-release-version.mjs "$version" --base "$previous_tag"');
    expect(workflow).toContain("git describe --tags --abbrev=0 --match 'v*' HEAD");
    // The publish loop walks the plugins in dependency order, and the release commit has to carry their bumped manifests.
    expect(workflow).toContain("$(node scripts/build-plugins.mjs --order)");
    expect(workflow).toContain("packages/plugins/*/package.json");
    const pluginManifests = readdirSync(resolve(repositoryRoot, "packages/plugins"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(pluginManifests.length).toBeGreaterThan(0);
    for (const directory of pluginManifests) {
      const manifest = readJson(`packages/plugins/${directory}/package.json`) as { name: string; dependencies?: Record<string, string> };
      // An exact pin would rewrite - and therefore republish - every plugin on each launcher patch release, which is the coupling the split removed.
      for (const [dependency, range] of Object.entries(manifest.dependencies ?? {}))
        if (dependency.startsWith("@pi-harness/")) expect(range, `${manifest.name} pins ${dependency} instead of tracking it through a range`).toMatch(/^\^/u);
    }
  });

  test("pins every action to a full commit SHA with its release tag recorded", () => {
    const uses = [...workflow.matchAll(/^\s+uses:\s*(.+)$/gmu)].map((match) => match[1] ?? "");
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const reference of uses) expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u);
  });

  test("prepack builds every workspace that a root bin points at", () => {
    const root = readJson("package.json") as { bin: Record<string, string>; scripts: Record<string, string> };
    // The rest of prepack prepares the manifests the tarball ships, which package-install.test.ts owns; this test only cares that the build still runs before anything is packed.
    expect(root.scripts.prepack).toContain("npm run build:web");
    const built = [...root.scripts["build:web"]!.matchAll(/npm run build -w (\S+)/gu)].map((match) => match[1]);
    for (const target of Object.values(root.bin)) expect(built, `${target} is not built by build:web`).toContain(workspaceNameFor(target));
    expect(built.indexOf("@pi-harness/core")).toBeLessThan(built.indexOf("@pi-harness/cli"));
  });

  test("core declares every package its sources load", () => {
    const core = readJson("packages/core/package.json") as { name: string; dependencies: Record<string, string>; peerDependencies: Record<string, string> };
    const specifierPattern =
      /(?:from\s*|import\s*\(\s*|import\.meta\.resolve\(\s*|require(?:\.resolve)?\(\s*)["']([@a-z][^"'\s]*)["']|"(@[a-z0-9._~-]+\/[a-z0-9._~-]+(?:\/[a-z0-9._~-]+)*)"/gu;
    const required = new Map<string, string>();
    for (const file of sourceFiles(resolve(repositoryRoot, "packages/core/src"), ".ts")) {
      for (const match of readFileSync(file, "utf8").matchAll(specifierPattern))
        required.set(packageNameOf(match[1] ?? match[2] ?? ""), relative(repositoryRoot, file));
    }
    const external = [...required].filter(([name]) => !name.startsWith("node:") && !name.includes(":") && name !== core.name);
    expect(external.length).toBeGreaterThan(0);
    // A runtime that appears in the published type surface is declared as a peer instead, so the consumer owns the single installed copy.
    for (const [name, file] of external)
      expect(
        core.dependencies[name] ?? core.peerDependencies[name],
        `${name} (used by ${file}) is declared by neither ${core.name} dependencies nor peerDependencies`,
      ).toBeDefined();
    // The curated plugin set belongs to the launcher, so installing the runtime on its own never drags a profile's plugins in.
    expect(core.files).not.toContain("profiles");
  });

  test("the published launcher declares every package its shipped profiles load, and no plugin", () => {
    // A profile entry is imported by its bare specifier, so the package a user installs has to pull the infrastructure each entry names. Pluggable plugins are the exception by design: they are ordinary npm packages installed from the plugin center, so bundling one would put it in every install whether the user wanted it or not.
    const root = readJson("package.json") as { name: string; dependencies: Record<string, string> };
    const required = new Map<string, string>();
    for (const file of sourceFiles(resolve(repositoryRoot, "packages/cli/profiles"), ".yml")) {
      for (const match of readFileSync(file, "utf8").matchAll(/^\s*name:\s*"?([^"\s]+)"?\s*$/gmu))
        required.set(packageNameOf(match[1] ?? ""), relative(repositoryRoot, file));
    }
    const external = [...required].filter(([name]) => !name.includes(":"));
    expect(external.length).toBeGreaterThan(0);
    for (const [name, file] of external) {
      expect(name.startsWith("@pi-harness/plugin-"), `${name} (loaded by ${file}) is a pluggable plugin, which a shipped profile must not enable`).toBe(false);
      expect(root.dependencies[name], `${name} (loaded by ${file}) is not declared by ${root.name}`).toBeDefined();
    }
    expect(Object.keys(root.dependencies).filter((name) => name.startsWith("@pi-harness/plugin-"))).toEqual([]);
  });

  test("the plugin API declares every package its sources import as a peer", () => {
    // A plugin author installs this package on its own, so anything it imports has to be something the author is told to install alongside it.
    const pluginApi = readJson("packages/plugin-api/package.json") as {
      name: string;
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    const required = new Map<string, string>();
    for (const file of sourceFiles(resolve(repositoryRoot, "packages/plugin-api/src"), ".ts")) {
      for (const match of readFileSync(file, "utf8").matchAll(/(?:from|declare module)\s*["']([^"'\s]+)["']/gu))
        required.set(packageNameOf(match[1] ?? ""), relative(repositoryRoot, file));
    }
    const external = [...required].filter(([name]) => !name.startsWith("node:") && !name.startsWith("."));
    expect(external.length).toBeGreaterThan(0);
    for (const [name, file] of external) expect(pluginApi.peerDependencies[name], `${name} (used by ${file}) is not a peer of ${pluginApi.name}`).toBeDefined();
    expect(pluginApi.dependencies, `${pluginApi.name} must not pull a second copy of anything a plugin already installs`).toBeUndefined();
  });
});
