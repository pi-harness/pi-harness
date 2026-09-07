import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const run = promisify(execFile);
const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

async function pih(args: string[], cwd: string, agentDir: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await run(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, PI_AGENT_DIR: agentDir, PI_HARNESS_HOME: join(agentDir, "harness-home") },
      timeout: 30_000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

describe("published binary", () => {
  test("runs through the package export map without Node internals exposed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-bin-"));

    const version = await pih(["--version"], directory, directory);
    const dump = await pih(["--profile", "default", "--dump-config"], directory, directory);

    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(dump.code).toBe(0);
    expect(dump.stdout).toContain("@pi-harness/core/plugins/models");
  });

  test("loads a bare plugin specifier installed next to the user's own profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-bin-resolve-"));
    const packageDir = join(directory, "node_modules", "@acme", "pi-probe");
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@acme/pi-probe", version: "1.0.0", type: "module", exports: { ".": "./index.mjs" } }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.mjs"),
      `export default { apply(ctx) { ctx.provide("piApplication", { async run() { ctx.piHarnessStdio.writeOutput("probe ran\\n"); return 0; } }); }, inject: ["piHarnessStdio"] };`,
      "utf8",
    );
    await writeFile(join(directory, "cordis.yml"), JSON.stringify([{ id: "probe", name: "@acme/pi-probe" }]), "utf8");

    const result = await pih(["--config", join(directory, "cordis.yml"), "--prompt", "hi"], directory, directory);

    expect(result.stderr).not.toContain("Cannot find package");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("probe ran\n");
  }, 40_000);

  test("reports an unresolvable bare plugin specifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-bin-missing-"));
    await writeFile(join(directory, "cordis.yml"), JSON.stringify([{ id: "probe", name: "@acme/definitely-not-installed" }]), "utf8");

    const result = await pih(["--config", join(directory, "cordis.yml"), "--prompt", "hi"], directory, directory);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("@acme/definitely-not-installed");
  }, 40_000);
});
