import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");

// Stands in for the launcher's own @pi-harness/core inside the installed tree, so the smoke test can drive the marketplace stage without a real global install. Both modules are reduced to the behaviour that stage depends on.
const fakeCoreSource = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const prepareHarnessProfile = ({ builtinProfilePath, profileName, directory }) => {
  const profileDirectory = join(directory, "profiles", profileName);
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "pi-harness-home", private: true }));
  const profilePath = join(profileDirectory, "cordis.yml");
  writeFileSync(profilePath, readFileSync(builtinProfilePath, "utf8"));
  return Promise.resolve(profilePath);
};
`;

const fakeResolveSource = `import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const resolvePluginEntry = (fromFile, name) => {
  let directory = dirname(fromFile);
  for (;;) {
    const candidate = join(directory, "node_modules", ...name.split("/"), "dist", "index.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};
`;

// Stands in for npm so the smoke test can be exercised without packing and globally installing the real workspace: `pack` reports one tarball name per requested workspace, a `--prefix` install lays out the tree the script inspects, optionally without the files the root bin map points at, and a plain install lays out the marketplace package in the directory it was run from.
const fakeNpmSource = `import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
if (args[0] === "pack") {
  const workspaces = args.filter((argument, index) => args[index - 1] === "--workspace");
  process.stdout.write((workspaces.length === 0 ? ["harness.tgz"] : workspaces.map((name) => name.slice(name.indexOf("/") + 1) + ".tgz")).join("\\n") + "\\n");
  process.exit(0);
}
if (args[0] !== "install") process.exit(1);
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const prefixIndex = args.indexOf("--prefix");
if (prefixIndex < 0) {
  if (process.env.PACKED_PACKAGE_FIXTURE_MARKETPLACE !== "0") {
    const name = "@pi-harness/" + basename(args[args.length - 1]).replace(/\\.tgz$/u, "");
    const root = join(process.cwd(), "node_modules", ...name.split("/"));
    write(join(root, "package.json"), JSON.stringify({ name, version: "9.9.9", type: "module", exports: { ".": { import: "./dist/index.js" } } }));
    write(join(root, "dist", "index.js"), "export default {};\\n");
  }
  process.exit(0);
}
const prefix = args[prefixIndex + 1];
const harnessRoot = join(prefix, "lib", "node_modules", "@pi-harness", "pi-harness");
const agentRoot = join(harnessRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const bin = { "pi-harness": "./apps/web/server-dist/bin.js", pih: "./packages/cli/dist/bin.js" };
write(join(harnessRoot, "package.json"), JSON.stringify({ name: "@pi-harness/pi-harness", version: "9.9.9", bin, dependencies: { "@earendil-works/pi-coding-agent": "0.84.4" } }));
write(join(agentRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.4", dependencies: {} }));
write(join(agentRoot, "dist", "cli", "args.js"), "");
write(join(harnessRoot, "apps", "web", "profile", "cordis.yml"), "[]\\n");
write(join(harnessRoot, "node_modules", "@pi-harness", "core", "dist", "index.js"), process.env.PACKED_PACKAGE_FIXTURE_CORE);
write(join(harnessRoot, "node_modules", "@pi-harness", "core", "dist", "plugin-resolve.js"), process.env.PACKED_PACKAGE_FIXTURE_RESOLVE);
if (process.env.PACKED_PACKAGE_FIXTURE_BINS === "1") for (const target of Object.values(bin)) write(join(harnessRoot, target), "");
`;

const createFakeNpm = async (): Promise<string> => {
  const fixture = await mkdtemp(resolve(tmpdir(), "pi-harness-packed-package-fixture-"));
  fixtures.push(fixture);
  const fakeNpm = resolve(fixture, "npm.mjs");
  await writeFile(fakeNpm, fakeNpmSource);
  return fakeNpm;
};

const runSmokeTest = async (fakeNpm: string, bins: boolean, marketplace = true): ReturnType<typeof execFileAsync> =>
  execFileAsync(process.execPath, [resolve(repositoryRoot, "scripts/test-packed-package.mjs")], {
    env: {
      ...process.env,
      npm_execpath: fakeNpm,
      PACKED_PACKAGE_FIXTURE_BINS: bins ? "1" : "0",
      PACKED_PACKAGE_FIXTURE_CORE: fakeCoreSource,
      PACKED_PACKAGE_FIXTURE_RESOLVE: fakeResolveSource,
      PACKED_PACKAGE_FIXTURE_MARKETPLACE: marketplace ? "1" : "0",
    },
  });

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("packed package smoke test", () => {
  it("accepts a tarball whose bin entrypoints are present and whose marketplace install is loadable", async () => {
    const fakeNpm = await createFakeNpm();

    const { stdout } = await runSmokeTest(fakeNpm, true);

    expect(stdout).toContain("Packed package smoke test passed");
  });

  it("rejects a tarball that ships no runnable bin entrypoint", async () => {
    // `npm pack --ignore-scripts` never runs prepack, so an unbuilt workspace produces a tarball with a bin map pointing at files the tarball does not contain.
    const fakeNpm = await createFakeNpm();

    await expect(runSmokeTest(fakeNpm, false)).rejects.toThrow(/missing the pi-harness entrypoint \.\/apps\/web\/server-dist\/bin\.js/u);
  });

  it("rejects a launcher whose marketplace install lands somewhere the loader cannot resolve", async () => {
    const fakeNpm = await createFakeNpm();

    await expect(runSmokeTest(fakeNpm, true, false)).rejects.toThrow(/installed into the harness home but the loader cannot resolve it/u);
  });
});
