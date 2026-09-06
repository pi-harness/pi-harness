import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");

// Stands in for npm so the smoke test can be exercised without packing and globally installing the real workspace: `pack` reports tarball names and `install` lays out
// the tree the script inspects, optionally without the files the root bin map points at.
const fakeNpmSource = `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
if (args[0] === "pack") {
  process.stdout.write(args.includes("--workspace") ? "core.tgz\\n" : "harness.tgz\\n");
  process.exit(0);
}
if (args[0] !== "install") process.exit(1);
const prefix = args[args.indexOf("--prefix") + 1];
const harnessRoot = join(prefix, "lib", "node_modules", "@pi-harness", "pi-harness");
const agentRoot = join(harnessRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const bin = { "pi-harness": "./apps/web/server-dist/bin.js", pih: "./packages/cli/dist/bin.js" };
write(join(harnessRoot, "package.json"), JSON.stringify({ name: "@pi-harness/pi-harness", version: "9.9.9", bin, dependencies: { "@earendil-works/pi-coding-agent": "0.84.4" } }));
write(join(agentRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.4", dependencies: {} }));
write(join(agentRoot, "dist", "cli", "args.js"), "");
if (process.env.PACKED_PACKAGE_FIXTURE_BINS === "1") for (const target of Object.values(bin)) write(join(harnessRoot, target), "");
`;

const createFakeNpm = async (): Promise<string> => {
  const fixture = await mkdtemp(resolve(tmpdir(), "pi-harness-packed-package-fixture-"));
  fixtures.push(fixture);
  const fakeNpm = resolve(fixture, "npm.mjs");
  await writeFile(fakeNpm, fakeNpmSource);
  return fakeNpm;
};

const runSmokeTest = async (fakeNpm: string, bins: boolean): ReturnType<typeof execFileAsync> =>
  execFileAsync(process.execPath, [resolve(repositoryRoot, "scripts/test-packed-package.mjs")], {
    env: { ...process.env, npm_execpath: fakeNpm, PACKED_PACKAGE_FIXTURE_BINS: bins ? "1" : "0" },
  });

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("packed package smoke test", () => {
  it("accepts a tarball whose bin entrypoints are present", async () => {
    const fakeNpm = await createFakeNpm();

    const { stdout } = await runSmokeTest(fakeNpm, true);

    expect(stdout).toContain("Packed package smoke test passed");
  });

  it("rejects a tarball that ships no runnable bin entrypoint", async () => {
    // `npm pack --ignore-scripts` never runs prepack, so an unbuilt workspace produces a tarball with a bin map pointing at files the tarball does not contain.
    const fakeNpm = await createFakeNpm();

    await expect(runSmokeTest(fakeNpm, false)).rejects.toThrow(/missing the pi-harness entrypoint \.\/apps\/web\/server-dist\/bin\.js/u);
  });
});
