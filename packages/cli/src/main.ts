import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { bootHarness, provideLaunchContext, provideStdioContext, resolveProfileConfig, type BootedHarness } from "@pi-harness/core";
import { CliUsageError, parseLauncherArgs } from "./args.js";
import { NodeStdio } from "./node-stdio.js";

export interface CliEnvironment {
  readonly cwd: string;
  readonly agentDir: string;
  readonly version: string;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  onSignal(listener: (signal: NodeJS.Signals) => void): () => void;
}

export async function runCli(_args: readonly string[], _environment: CliEnvironment): Promise<number> {
  const args = _args;
  const environment = _environment;
  let invocation: ReturnType<typeof parseLauncherArgs>;
  try {
    invocation = parseLauncherArgs(args);
  } catch (error) {
    environment.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof CliUsageError ? 2 : 1;
  }
  if (invocation.mode === "help") {
    environment.stdout.write("Usage: pih [--profile <name> | --config <path>] [--dump-config] [--] [--prompt <text> | <prompt>]\n");
    return 0;
  }
  if (invocation.mode === "version") {
    environment.stdout.write(`${environment.version}\n`);
    return 0;
  }
  let configPath: string;
  try {
    configPath = await resolveProfileConfig({
      ...(invocation.configPath === undefined ? { profile: invocation.profile ?? "default" } : { configPath: invocation.configPath }),
      cwd: environment.cwd,
    });
    if (invocation.dumpConfig) {
      environment.stdout.write(await readFile(configPath, "utf8"));
      return 0;
    }
  } catch (error) {
    environment.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let harness: BootedHarness | undefined;
  let requestedExit: ((code: number) => void) | undefined;
  const requestedExitPromise = new Promise<number>((resolve) => {
    requestedExit = resolve;
  });
  let signalledExit: ((code: number) => void) | undefined;
  const signalPromise = new Promise<number>((resolve) => {
    signalledExit = resolve;
  });
  const removeSignals = environment.onSignal((signal) => {
    signalledExit?.(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
  });
  try {
    const stdio = new NodeStdio(environment.stdin, environment.stdout, environment.stderr);
    harness = await bootHarness({
      configPath,
      prepare(context) {
        provideLaunchContext(context, {
          cwd: environment.cwd,
          agentDir: environment.agentDir,
          args: invocation.args,
          requestExit(code) {
            requestedExit?.(code);
          },
        });
        provideStdioContext(context, stdio);
      },
    });
    const application = harness.context.get("piApplication");
    if (application === undefined) throw new Error("Cordis profile did not provide a piApplication service");
    const result = await Promise.race([
      application.run().then((code) => ({ source: "application" as const, code })),
      requestedExitPromise.then((code) => ({ source: "request" as const, code })),
      signalPromise.then((code) => ({ source: "signal" as const, code })),
    ]);
    if (result.source !== "application") await harness.context.get("piRuntime")?.abort();
    return result.code;
  } catch (error) {
    environment.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return 1;
  } finally {
    removeSignals();
    await harness?.dispose();
  }
}
