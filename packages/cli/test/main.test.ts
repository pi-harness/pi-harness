import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { DUPLICATE_SIGNAL_WINDOW_MS, runCli, type CliEnvironment } from "../src/main.js";

interface TestEnvironment extends CliEnvironment {
  readonly output: string[];
  readonly errors: string[];
  readonly forcedExitCodes: number[];
  emitSignal(signal: NodeJS.Signals): void;
}

function createEnvironment(cwd: string, shutdownTimeoutMs = 5_000): TestEnvironment {
  const output: string[] = [];
  const errors: string[] = [];
  const forcedExitCodes: number[] = [];
  const signals = new Set<(signal: NodeJS.Signals) => void>();
  const stdin = new Readable({ read() {} });
  stdin.push(null);
  return {
    cwd,
    agentDir: join(cwd, ".pi-agent-test"),
    version: "0.1.0-test",
    stdin,
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

async function createApplicationProfile(source: string): Promise<{ configPath: string; directory: string; markerPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-harness-signal-"));
  const pluginPath = join(directory, "application.mjs");
  const configPath = join(directory, "cordis.yml");
  const markerPath = join(directory, "marker.txt");
  await writeFile(pluginPath, source, "utf8");
  await writeFile(configPath, JSON.stringify([{ name: pathToFileURL(pluginPath).href, config: { markerPath } }]), "utf8");
  return { configPath, directory, markerPath };
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A shutdown that outlives the duplicate window is what makes the second delivery observable at all; a 20ms abort handler stands in for a plugin dispose or a stdio flush.
const SLOW_SHUTDOWN_APPLICATION = `import { appendFileSync, writeFileSync } from "node:fs"; export default { apply(ctx, config) { writeFileSync(config.markerPath, "started"); ctx.effect(() => () => appendFileSync(config.markerPath, ":disposed")); ctx.provide("piApplication", { async run(signal) { appendFileSync(config.markerPath, ":run"); await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); await new Promise((resolve) => setTimeout(resolve, 20)); appendFileSync(config.markerPath, ":aborted"); return 0; } }); } };`;
// A shutdown that never finishes keeps the signal listener registered, so a deliberate second Ctrl-C arriving long after the first still has something to interrupt.
const STUCK_SHUTDOWN_APPLICATION = `import { writeFileSync } from "node:fs"; export default { apply(ctx, config) { writeFileSync(config.markerPath, "started"); ctx.provide("piRuntime", { async abort() { return new Promise(() => {}); }, async dispose() {} }); ctx.provide("piApplication", { async run() { return new Promise(() => {}); } }); } };`;

describe("runCli duplicate signal delivery", () => {
  test("collapses the same signal delivered twice inside the duplicate window into one graceful shutdown", async () => {
    const profile = await createApplicationProfile(SLOW_SHUTDOWN_APPLICATION);
    const environment = createEnvironment(profile.directory);
    const result = runCli(["--config", profile.configPath], environment);
    await waitForFileContent(profile.markerPath, "started:run");

    // The terminal broadcasts Ctrl-C to the process group and the development supervisor relays the same signal; both land within a millisecond or two of each other.
    environment.emitSignal("SIGINT");
    await sleep(2);
    environment.emitSignal("SIGINT");

    await expect(result).resolves.toBe(130);
    expect(environment.forcedExitCodes).toEqual([]);
    expect(environment.errors.join("")).not.toContain("Received SIGINT again");
    await expect(readFile(profile.markerPath, "utf8")).resolves.toBe("started:run:aborted:disposed");
  });

  test("still force-quits when the same signal arrives again after the duplicate window", async () => {
    const profile = await createApplicationProfile(STUCK_SHUTDOWN_APPLICATION);
    const environment = createEnvironment(profile.directory, 60_000);
    const result = runCli(["--config", profile.configPath], environment);
    await waitForFileContent(profile.markerPath, "started");

    environment.emitSignal("SIGINT");
    await sleep(DUPLICATE_SIGNAL_WINDOW_MS + 10);
    environment.emitSignal("SIGINT");

    expect(environment.forcedExitCodes).toEqual([130]);
    expect(environment.errors.join("")).toContain("Received SIGINT again");
    await expect(Promise.race([result, sleep(200).then(() => "pending")])).resolves.toBe("pending");
  });

  test("does not collapse two different signals that arrive inside the duplicate window", async () => {
    const profile = await createApplicationProfile(STUCK_SHUTDOWN_APPLICATION);
    const environment = createEnvironment(profile.directory, 60_000);
    const result = runCli(["--config", profile.configPath], environment);
    await waitForFileContent(profile.markerPath, "started");

    environment.emitSignal("SIGINT");
    await sleep(2);
    environment.emitSignal("SIGTERM");

    expect(environment.forcedExitCodes).toEqual([143]);
    expect(environment.errors.join("")).toContain("Received SIGTERM again");
    await expect(Promise.race([result, sleep(200).then(() => "pending")])).resolves.toBe("pending");
  });
});
