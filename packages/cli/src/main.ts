import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { BUILTIN_PROFILES, bootHarness, provideLaunchContext, provideStdioContext, resolveProfileConfig, type BootedHarness } from "@pi-harness/core";
import { CliUsageError, parseLauncherArgs } from "./args.js";
import { NodeStdio } from "./node-stdio.js";
import { PI_HARNESS_RESTART_EXIT_CODE } from "./relaunch.js";

export interface CliEnvironment {
  readonly cwd: string;
  readonly agentDir: string;
  readonly version: string;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly shutdownTimeoutMs: number;
  readonly checkForUpdates?: () => Promise<string | undefined>;
  readonly supervised?: boolean;
  forceExit(code: number): void;
  onSignal(listener: (signal: NodeJS.Signals) => void): () => void;
}

type BootOutcome = { kind: "ready"; harness: BootedHarness } | { kind: "error"; error: unknown };

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  const result = await Promise.race([promise.then((value) => ({ settled: true as const, value })), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

const HELP_TEXT = `Usage: pih [--profile <name> | --config <path>] [--dump-config] [--] [--prompt <text> | <prompt>]

Launcher options (recognized before the first application argument):
  --profile <name>   Built-in profile to boot; one of ${BUILTIN_PROFILES.join(", ")} (default: default)
  --config <path>    Cordis entry-tree YAML or JSON to boot instead of a built-in profile
  --dump-config      Print the resolved profile file and exit without importing any plugin
  -h, --help         Print this message and exit
  -v, --version      Print the launcher version and exit

Every remaining argument, including a \`--\` separator, is passed unchanged to the active
application plugin. The bundled stdio application reads its prompt from --prompt <text>,
--prompt=<text>, a positional prompt, or stdin, and needs \`--\` before a prompt that starts
with a dash.
`;

const FLUSH_TIMEOUT_MS = 2_000;

// A terminal broadcasts Ctrl-C to the whole foreground process group, so under `pih --profile development` this process receives SIGINT twice: once from the terminal and once relayed by the supervisor, measured under a millisecond apart. 50ms is far above that relay latency and far below the hundreds of milliseconds between two deliberate key presses, so a repeat inside the window is one keypress delivered twice and a repeat after it is still a force-quit request.
export const DUPLICATE_SIGNAL_WINDOW_MS = 50;

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
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
    environment.stdout.write(HELP_TEXT);
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
    if (environment.checkForUpdates !== undefined) {
      void Promise.resolve()
        .then(() => environment.checkForUpdates?.())
        .then((notice) => {
          if (notice !== undefined) environment.stderr.write(notice);
        })
        .catch(() => undefined);
    }
  } catch (error) {
    environment.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let harness: BootedHarness | undefined;
  let resultCode: number | undefined;
  let forcedExit = false;
  const forceExit = async (code: number, flush = true) => {
    if (forcedExit) return;
    forcedExit = true;
    // process.exit discards whatever is still buffered for a pipe, so the answer is flushed first.
    // A repeated signal is the user asking to leave now, so that path skips the wait.
    if (flush) await settleWithin(stdio.flush(), FLUSH_TIMEOUT_MS);
    environment.forceExit(code);
  };
  let requestedExit: ((code: number) => void) | undefined;
  const requestedExitPromise = new Promise<number>((resolve) => {
    requestedExit = resolve;
  });
  let signalledExit: ((code: number) => void) | undefined;
  const signalPromise = new Promise<number>((resolve) => {
    signalledExit = resolve;
  });
  const startupAbort = new AbortController();
  const stdio = new NodeStdio(environment.stdin, environment.stdout, environment.stderr);
  let signalCount = 0;
  let lastSignal: NodeJS.Signals | undefined;
  let lastSignalAt = 0;
  const removeSignals = environment.onSignal((signal) => {
    const code = signalExitCode(signal);
    // performance.now() is monotonic, so a clock adjustment cannot turn a duplicate into a force-quit or the reverse.
    const receivedAt = performance.now();
    // The window is measured from the first delivery, not the previous one, so a burst cannot postpone the force-quit indefinitely.
    if (signal === lastSignal && receivedAt - lastSignalAt < DUPLICATE_SIGNAL_WINDOW_MS) return;
    lastSignal = signal;
    lastSignalAt = receivedAt;
    signalCount += 1;
    if (signalCount > 1) {
      environment.stderr.write(`Received ${signal} again; exiting immediately\n`);
      void forceExit(code, false);
      return;
    }
    signalledExit?.(code);
    stdio.close();
    startupAbort.abort(new Error(`Received ${signal}`));
  });
  try {
    const bootOutcome: Promise<BootOutcome> = bootHarness({
      configPath,
      signal: startupAbort.signal,
      onFullReload() {
        if (environment.supervised !== true) {
          environment.stderr.write("Cordis requested a full reload but this process is not supervised; restart the CLI to apply the change\n");
          return;
        }
        requestedExit?.(PI_HARNESS_RESTART_EXIT_CODE);
      },
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
    }).then(
      (booted): BootOutcome => ({ kind: "ready", harness: booted }),
      (error: unknown): BootOutcome => ({ kind: "error", error }),
    );
    const startup = await Promise.race([bootOutcome, signalPromise.then((code) => ({ kind: "signal" as const, code }))]);
    if (startup.kind === "signal") {
      resultCode = startup.code;
      const settled = await settleWithin(bootOutcome, environment.shutdownTimeoutMs);
      if (!settled.settled) {
        await forceExit(startup.code);
        return startup.code;
      }
      if (settled.value.kind === "ready") harness = settled.value.harness;
      return startup.code;
    }
    if (startup.kind === "error") throw startup.error;
    harness = startup.harness;
    const application = harness.context.get("piApplication");
    if (application === undefined) throw new Error("Cordis profile did not provide a piApplication service");
    const shutdownAbort = new AbortController();
    const applicationRun = application.run(shutdownAbort.signal).then((code) => ({ source: "application" as const, code }));
    const result = await Promise.race([
      applicationRun,
      requestedExitPromise.then((code) => ({ source: "request" as const, code })),
      signalPromise.then((code) => ({ source: "signal" as const, code })),
    ]);
    resultCode = result.code;
    if (result.source !== "application") {
      shutdownAbort.abort(new Error("Pi Harness is shutting down"));
      const runtime = harness.context.get("piRuntime");
      if (runtime !== undefined) {
        const aborted = await settleWithin(
          runtime.abort().then(
            () => undefined,
            (error: unknown) => {
              environment.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
            },
          ),
          environment.shutdownTimeoutMs,
        );
        if (!aborted.settled) await forceExit(result.code);
      }
      // The application surface outlives the runtime abort unless it honours the signal, and
      // Node waits for it before exiting, so it gets the same deadline as everything else.
      const finished = await settleWithin(
        applicationRun.then(
          () => undefined,
          () => undefined,
        ),
        environment.shutdownTimeoutMs,
      );
      if (!finished.settled) await forceExit(result.code);
    }
    return result.code;
  } catch (error) {
    environment.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    resultCode = 1;
    return 1;
  } finally {
    removeSignals();
    stdio.close();
    if (harness !== undefined) {
      const disposed = await settleWithin(
        harness.dispose().then(
          () => undefined,
          (error: unknown) => {
            environment.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
          },
        ),
        environment.shutdownTimeoutMs,
      );
      if (!disposed.settled) await forceExit(resultCode ?? 1);
    }
  }
}
