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
    expect(workflow).toContain("npm publish --workspace @pi-harness/core --access public");
    expect(workflow).toContain("npm publish --access public");
  });

  test("pins every action to a full commit SHA with its release tag recorded", () => {
    const uses = [...workflow.matchAll(/^\s+uses:\s*(.+)$/gmu)].map((match) => match[1] ?? "");
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const reference of uses) expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u);
  });

  test("prepack builds every workspace that a root bin points at", () => {
    const root = readJson("package.json") as { bin: Record<string, string>; scripts: Record<string, string> };
    expect(root.scripts.prepack).toBe("npm run build:web");
    const built = [...root.scripts["build:web"]!.matchAll(/npm run build -w (\S+)/gu)].map((match) => match[1]);
    for (const target of Object.values(root.bin)) expect(built, `${target} is not built by build:web`).toContain(workspaceNameFor(target));
    expect(built.indexOf("@pi-harness/core")).toBeLessThan(built.indexOf("@pi-harness/cli"));
  });

  test("core declares every package its sources and shipped profiles load", () => {
    const core = readJson("packages/core/package.json") as { name: string; dependencies: Record<string, string> };
    const specifierPattern =
      /(?:from\s*|import\s*\(\s*|import\.meta\.resolve\(\s*|require(?:\.resolve)?\(\s*)["']([@a-z][^"'\s]*)["']|"(@[a-z0-9._~-]+\/[a-z0-9._~-]+(?:\/[a-z0-9._~-]+)*)"/gu;
    const required = new Map<string, string>();
    for (const file of sourceFiles(resolve(repositoryRoot, "packages/core/src"), ".ts")) {
      for (const match of readFileSync(file, "utf8").matchAll(specifierPattern))
        required.set(packageNameOf(match[1] ?? match[2] ?? ""), relative(repositoryRoot, file));
    }
    for (const file of sourceFiles(resolve(repositoryRoot, "packages/core/profiles"), ".yml")) {
      for (const match of readFileSync(file, "utf8").matchAll(/^\s*name:\s*"?([^"\s]+)"?\s*$/gmu))
        required.set(packageNameOf(match[1] ?? ""), relative(repositoryRoot, file));
    }
    const external = [...required].filter(([name]) => !name.startsWith("node:") && !name.includes(":") && name !== core.name);
    expect(external.length).toBeGreaterThan(0);
    for (const [name, file] of external) expect(core.dependencies[name], `${name} (used by ${file}) is missing from ${core.name} dependencies`).toBeDefined();
  });
});
