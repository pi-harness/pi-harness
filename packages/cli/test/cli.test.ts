import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCli, type CliEnvironment } from "../src/main.js";

interface TestEnvironment extends CliEnvironment {
  readonly output: string[];
  readonly errors: string[];
  readonly forcedExitCodes: number[];
  emitSignal(signal: NodeJS.Signals): void;
}

function createEnvironment(cwd = process.cwd(), input = "", shutdownTimeoutMs = 5_000): TestEnvironment {
  const output: string[] = [];
  const errors: string[] = [];
  const forcedExitCodes: number[] = [];
  const signals = new Set<(signal: NodeJS.Signals) => void>();
  return {
    cwd,
    agentDir: join(cwd, ".pi-agent-test"),
    version: "0.1.0-test",
    stdin: Readable.from([input]),
    stdout: new Writable({
      write(chunk, _encoding, callback) {
        output.push(String(chunk));
        callback();
      },
    }),
    stderr: new Writable({
      write(chunk, _encoding, callback) {
        errors.push(String(chunk));
        callback();
      },
    }),
    output,
    errors,
    forcedExitCodes,
    shutdownTimeoutMs,
    forceExit(code) {
      forcedExitCodes.push(code);
    },
    onSignal(listener) {
      signals.add(listener);
      return () => signals.delete(listener);
    },
    emitSignal(signal) {
      for (const listener of signals) listener(signal);
    },
  };
}

async function createApplicationProfile(source: string): Promise<{ configPath: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-harness-cli-"));
  const pluginPath = join(directory, "application.mjs");
  const configPath = join(directory, "cordis.yml");
  await writeFile(pluginPath, source, "utf8");
  await writeFile(configPath, JSON.stringify([{ name: pathToFileURL(pluginPath).href, config: { markerPath: join(directory, "marker.txt") } }]), "utf8");
  return { configPath, directory };
}

async function waitForFileContent(path: string, expected: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      if ((await readFile(path, "utf8")) === expected) return;
    } catch {
      // The producer has not created the marker yet.
    }
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${path} to contain ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("runCli", () => {
  test("prints help without booting a profile", async () => {
    const environment = createEnvironment();

    const exitCode = await runCli(["--help"], environment);

    expect(exitCode).toBe(0);
    expect(environment.output.join("")).toContain("Usage: pih");
    expect(environment.errors).toEqual([]);
  });

  test("prints the package version", async () => {
    const environment = createEnvironment();

    const exitCode = await runCli(["--version"], environment);

    expect(exitCode).toBe(0);
    expect(environment.output.join("")).toBe("0.1.0-test\n");
  });

  test("dumps an explicit profile without importing its plugins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-dump-"));
    const configPath = join(directory, "cordis.yml");
    await writeFile(configPath, "- name: ./not-imported.mjs\n", "utf8");
    const environment = createEnvironment(directory);

    const exitCode = await runCli(["--config", configPath, "--dump-config"], environment);

    expect(exitCode).toBe(0);
    expect(environment.output.join("")).toBe("- name: ./not-imported.mjs\n");
  });

  test("runs the application plugin and disposes the Cordis tree", async () => {
    const profile = await createApplicationProfile(
      `import { appendFileSync, writeFileSync } from "node:fs"; export default { apply(ctx, config) { writeFileSync(config.markerPath, "started"); ctx.effect(() => () => appendFileSync(config.markerPath, ":disposed")); ctx.provide("piApplication", { async run() { appendFileSync(config.markerPath, ":run"); return 7; } }); } };`,
    );
    const environment = createEnvironment(profile.directory);

    const exitCode = await runCli(["--config", profile.configPath], environment);

    expect(exitCode).toBe(7);
    await expect(readFile(join(profile.directory, "marker.txt"), "utf8")).resolves.toBe("started:run:disposed");
  });

  test("aborts and disposes a running application on SIGINT", async () => {
    const profile = await createApplicationProfile(
      `import { appendFileSync, writeFileSync } from "node:fs"; export default { apply(ctx, config) { writeFileSync(config.markerPath, "started"); ctx.effect(() => () => appendFileSync(config.markerPath, ":disposed")); ctx.provide("piApplication", { async run() { appendFileSync(config.markerPath, ":run"); return new Promise(() => {}); } }); } };`,
    );
    const environment = createEnvironment(profile.directory);
    const result = runCli(["--config", profile.configPath], environment);
    const markerPath = join(profile.directory, "marker.txt");
    await waitForFileContent(markerPath, "started:run");

    environment.emitSignal("SIGINT");

    await expect(result).resolves.toBe(130);
    await expect(readFile(markerPath, "utf8")).resolves.toBe("started:run:disposed");
  });

  test("handles SIGTERM while the Cordis plugin tree is still starting", async () => {
    const profile = await createApplicationProfile(
      `import { writeFileSync } from "node:fs"; export default { async apply(_ctx, config) { writeFileSync(config.markerPath, "starting"); await new Promise(() => {}); } };`,
    );
    const environment = createEnvironment(profile.directory, "", 50);
    const result = runCli(["--config", profile.configPath], environment);
    await waitForFileContent(join(profile.directory, "marker.txt"), "starting");

    environment.emitSignal("SIGTERM");

    await expect(result).resolves.toBe(143);
  });

  test("forces the bin exit when a Cordis disposer exceeds the shutdown deadline", async () => {
    const profile = await createApplicationProfile(
      `import { writeFileSync } from "node:fs"; export default { apply(ctx, config) { writeFileSync(config.markerPath, "started"); ctx.effect(() => async () => new Promise(() => {})); ctx.provide("piApplication", { async run() { return new Promise(() => {}); } }); } };`,
    );
    const environment = createEnvironment(profile.directory, "", 25);
    const result = runCli(["--config", profile.configPath], environment);
    await waitForFileContent(join(profile.directory, "marker.txt"), "started");

    environment.emitSignal("SIGTERM");

    await expect(result).resolves.toBe(143);
    expect(environment.forcedExitCodes).toEqual([143]);
  });

  test("returns a usage error for a missing config", async () => {
    const environment = createEnvironment();

    const exitCode = await runCli(["--config", "missing.yml", "--dump-config"], environment);

    expect(exitCode).toBe(2);
    expect(environment.errors.join("")).toContain("missing.yml");
  });
});
