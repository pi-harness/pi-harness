import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  bootHarness,
  prepareHarnessProfile,
  provideLaunchContext,
  provideStdioContext,
  readHarnessProfile,
  resolveProfileConfig,
  type BootedHarness,
} from "@pi-harness/core";
import { CliUsageError, parseLauncherArgs } from "./args.js";
import { NodeStdio } from "./node-stdio.js";
import { BUILTIN_PROFILES, BUILTIN_PROFILES_DIR } from "./profiles.js";
import { PI_HARNESS_RESTART_EXIT_CODE } from "./relaunch.js";

export interface CliEnvironment {
  readonly cwd: string;
  readonly agentDir: string;
  /** Directory that owns the booted copy of a built-in profile and the node_modules the marketplace installs into. */
  readonly harnessHome: string;
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

The profile that boots is a copy under <PI_HARNESS_HOME or ~/.pi-harness>/profiles/<name>/cordis.yml;
edit it to change the provider and model, or set PI_HARNESS_PROVIDER and PI_HARNESS_MODEL, which the
built-in profiles read before their everyapi/deepseek-v4-flash default. Provider credentials are read
from auth.json in <PI_CODING_AGENT_DIR, PI_AGENT_DIR, or ~/.pi/agent>; there is no /login command. Set
PI_HARNESS_DEBUG=1 to keep the stack frames in a startup failure.
`;

const FLUSH_TIMEOUT_MS = 2_000;

// The shipped profiles select the EveryAPI catalog, which nothing registers until the user provisions it, so the first run of a fresh installation is the run most likely to hit this failure. Cordis reports it through its own loader entry and fiber frames, none of which name the one step that fixes it, so the recognized case leads with the remedy exactly as the web launcher does.
const UNREGISTERED_EVERYAPI_MODEL = /Pi model is not registered: (everyapi\/[^\s"'`,;)\]]+)/u;

/** A failure report is a message a user can act on; the frames behind it belong to Cordis and the launcher's own async plumbing, so they are kept behind the same flag `bootHarness` uses. The hint rides along with the report because a user who needs the frames is reading this line, not the help text. */
function errorReport(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const debug = process.env.PI_HARNESS_DEBUG === "1";
  const unregistered = UNREGISTERED_EVERYAPI_MODEL.exec(error.message);
  if (unregistered !== null) {
    // `everyapi use pi-harness` writes the catalog into the durable agent directory, so it does fix this failure, but the relay key it injects reaches only the process it starts and the catalog names that key by environment reference, so a bare `pih` run afterwards would fail one step later on the missing credential. The remedy therefore says how the CLI itself is launched under that tool rather than implying the web console's one command provisions both surfaces.
    const remedy = `The EveryAPI model catalog is not provisioned in PI_CODING_AGENT_DIR (or its PI_AGENT_DIR compatibility alias). Install the EveryAPI CLI with \`curl -fsSL https://dl.everyapi.ai/install.sh | bash\`; \`everyapi use pi-harness\` then registers the catalog there and starts the web console, but it injects the relay key only into the process it starts, so run pih itself through it as \`everyapi use pi-harness -- <pih arguments>\` with a \`pi-harness\` PATH shim that execs pih (an executable named pi-harness on PATH whose body is \`exec pih "$@"\`), or set PI_HARNESS_PROVIDER and PI_HARNESS_MODEL to a model already registered in that agent directory.`;
    // Under the debug flag the reader asked for the detail as well as the remedy, so the full chain and its frames follow rather than replace it.
    return debug ? `${remedy}\n${error.stack ?? error.message}` : `${remedy}\nPi model is not registered: ${unregistered[1]}`;
  }
  if (debug) return error.stack ?? error.message;
  return error.stack === undefined ? error.message : `${error.message}\nSet PI_HARNESS_DEBUG=1 and run again to keep the stack frames.`;
}

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
    // The core resolver deliberately knows nothing about which profiles exist, so an unknown name would otherwise surface as a missing path inside the installation directory rather than as the list of names this launcher ships.
    if (invocation.configPath === undefined && !(BUILTIN_PROFILES as readonly string[]).includes(invocation.profile ?? "default"))
      throw new CliUsageError(`Unknown profile: ${invocation.profile ?? "default"}; expected one of ${BUILTIN_PROFILES.join(", ")}, or pass --config <path>`);
    configPath = await resolveProfileConfig({
      ...(invocation.configPath === undefined
        ? { profile: invocation.profile ?? "default", profilesDir: BUILTIN_PROFILES_DIR }
        : { configPath: invocation.configPath }),
      cwd: environment.cwd,
    });
    // --dump-config is an inspection, so it runs before anything is materialized: preparing the harness home here would create the directory and pull an existing copy forward to the shipped template, which is exactly the state the reader asked to see. The path goes to stderr so stdout stays a YAML document a pipe can consume.
    if (invocation.dumpConfig) {
      if (invocation.configPath !== undefined) {
        environment.stderr.write(`Profile: ${configPath}\n`);
        environment.stdout.write(await readFile(configPath, "utf8"));
        return 0;
      }
      const profile = await readHarnessProfile({
        builtinProfilePath: configPath,
        profileName: invocation.profile ?? "default",
        directory: environment.harnessHome,
      });
      environment.stderr.write(`Profile: ${profile.path}\n`);
      if (profile.origin === "builtin")
        environment.stderr.write("No copy exists under the harness home yet; this is the profile the next run would install there.\n");
      if (profile.origin === "home-outdated")
        environment.stderr.write(
          `This copy is untouched since an earlier release, so the next run replaces it with the profile the installation ships at ${configPath}; that replacement is the document printed here.\n`,
        );
      if (profile.origin === "home-modified") environment.stderr.write(`This copy differs from the profile the installation ships at ${configPath}.\n`);
      environment.stdout.write(profile.contents);
      return 0;
    }
    // A built-in profile is a template: the copy under the harness home is what boots, because that is the file the web console appends marketplace entries to and the directory those packages are installed beside. An explicit --config already names a file the user owns, so it is booted as given.
    if (invocation.configPath === undefined)
      configPath = await prepareHarnessProfile({
        builtinProfilePath: configPath,
        profileName: invocation.profile ?? "default",
        directory: environment.harnessHome,
      });
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
      pluginResolutionAnchor: fileURLToPath(import.meta.url),
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
          // The booted profile, so a diagnostic that tells the user to edit it can name the file instead of the two placeholders it was resolved from.
          configPath,
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
              environment.stderr.write(`${errorReport(error)}\n`);
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
    environment.stderr.write(`${errorReport(error)}\n`);
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
            environment.stderr.write(`${errorReport(error)}\n`);
          },
        ),
        environment.shutdownTimeoutMs,
      );
      if (!disposed.settled) await forceExit(resultCode ?? 1);
    }
  }
}
