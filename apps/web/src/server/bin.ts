#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { agentDirectory, bootHarness, coreUpdateNotice, prepareHarnessProfile, provideLaunchContext } from "@pi-harness/core";
import "@pi-harness/host-webserver";
import type { WebServer } from "@pi-harness/host-webserver";

// Keep the host service declaration in the server entrypoint's type graph.
type HarnessWebServer = WebServer;

// An unhandled 'error' event on a stream throws, so an EPIPE from a reader that closed early (`pi-harness | head -1`) would kill the process before the signal handlers can run the graceful shutdown. Swallowing the event leaves the write silently dropped, which is what a closed pipe means.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

/** A launcher argument or environment variable the user got wrong, reported as the single line that names it rather than as a throw out of module evaluation. */
class StartupOptionError extends Error {
  override readonly name = "StartupOptionError";
}

function commandLineValue(args: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === name) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new StartupOptionError(`${name} requires a value`);
      return value;
    }
    if (argument?.startsWith(prefix)) return argument.slice(prefix.length);
  }
  return undefined;
}

interface NetworkOptions {
  readonly host: string;
  readonly port: number;
  readonly allowedHosts: readonly string[];
}

const DEFAULT_PI_HARNESS_PORT = 3141;
// The web server compares each entry against a Host header hostname, so an entry carrying a scheme, port, path or credentials can never match; rejecting it here turns a silently ineffective deployment setting into a startup error.
const isBareHostname = (entry: string): boolean => {
  let url: URL;
  try {
    url = new URL("http://" + (entry.includes(":") && !entry.startsWith("[") ? "[" + entry + "]" : entry));
  } catch {
    return false;
  }
  return url.hostname !== "" && url.port === "" && url.pathname === "/" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
};

// Every rejection here names the source the value actually came from, because a user who typed `--port abc` cannot act on advice about PI_HARNESS_PORT, a variable they never set. The caller runs this inside the same guard as the boot itself so a wrong argument reports one line instead of a Node code frame.
function resolveNetworkOptions(args: readonly string[], env: NodeJS.ProcessEnv): NetworkOptions {
  const hostArgument = commandLineValue(args, "--host");
  const hostSource = hostArgument === undefined ? "PI_HARNESS_HOST" : "--host";
  // Accept the bracketed URL form of an IPv6 literal (e.g. "[::1]") but bind the bare address: net.Server.listen resolves the host through getaddrinfo, which rejects brackets with ENOTFOUND.
  const rawHost = hostArgument ?? env.PI_HARNESS_HOST ?? "127.0.0.1";
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const portArgument = commandLineValue(args, "--port");
  const portSource = portArgument === undefined ? "PI_HARNESS_PORT" : "--port";
  const port = Number(portArgument ?? env.PI_HARNESS_PORT ?? DEFAULT_PI_HARNESS_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new StartupOptionError(`${portSource} must be an integer between 0 and 65535`);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!loopbackHosts.has(host) && env.PI_HARNESS_ALLOW_REMOTE !== "1")
    throw new StartupOptionError(`Refusing non-loopback ${hostSource}; set PI_HARNESS_ALLOW_REMOTE=1 only on a trusted network`);
  // Extra hostnames the web server accepts in the Host header, comma separated, for a deployment reached through a reverse proxy under a name this machine does not resolve to itself.
  const allowedHosts = (env.PI_HARNESS_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const invalidAllowedHost = allowedHosts.find((entry) => !isBareHostname(entry));
  if (invalidAllowedHost !== undefined)
    throw new StartupOptionError("PI_HARNESS_ALLOWED_HOSTS entries must be bare hostnames without a scheme, port or path: " + invalidAllowedHost);
  return { host, port, allowedHosts };
}

const commandLineArgs = process.argv.slice(2);
const cwd = process.cwd();
const agentDir = agentDirectory(process.env, cwd);
const staticDir = fileURLToPath(new URL("../dist", import.meta.url));
const builtinProfilePath = fileURLToPath(new URL("../profile/cordis.yml", import.meta.url));
process.env.PI_HARNESS_WEB_DIST = staticDir;
const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
const startupAbort = new AbortController();
let shuttingDown = false;
let resolveExit: (() => void) | undefined;
const processExit = new Promise<void>((resolve) => {
  resolveExit = resolve;
});
let harness: Awaited<ReturnType<typeof bootHarness>> | undefined;
const exitCodeFor = (signal: NodeJS.Signals): number => (signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
// The Cordis loader wraps this failure in its own entry path and stack, none of which a user with an unprovisioned agent directory can act on, so the recognized case reports the remedy first and keeps exactly one line naming the model that is missing. Every other failure is still reported in full, because nothing here knows what it means.
const UNREGISTERED_EVERYAPI_MODEL = /Pi model is not registered: (everyapi\/[^\s"'`,;)\]]+)/u;
// Node reports a taken port as a bare errno, and the overwhelmingly likely cause is a Pi Harness the user already started, so the failure names that possibility and the variable that moves this one out of the way.
const ADDRESS_IN_USE = /\bEADDRINUSE\b/u;
// This launcher takes no arguments and has no help output, so the one place a user can learn that the frames are still available is the failure that dropped them.
const DEBUG_HINT = "Set PI_HARNESS_DEBUG=1 and start again to keep the stack frames.";
const formatStartupError = (error: unknown, network: NetworkOptions | undefined): string => {
  const message = error instanceof Error ? error.message : String(error);
  const debug = process.env.PI_HARNESS_DEBUG === "1";
  // The frames behind a rejected argument belong to this file's own parsing and say nothing the reader can act on, so the hint that offers them is left off rather than promising detail the debug flag does not add.
  if (error instanceof StartupOptionError) return message;
  if (network !== undefined && ADDRESS_IN_USE.test(message)) {
    const { host, port } = network;
    const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    const holder = process.platform === "win32" ? `netstat -ano | findstr :${port}` : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
    const remedy = `Port ${port} on ${host} is already in use. If that is a Pi Harness you already started, its console is at http://${authority}/. Otherwise set PI_HARNESS_PORT to a free port, or stop whatever holds this one (${holder}).`;
    return debug ? `${remedy}\n${message}` : remedy;
  }
  const unregistered = UNREGISTERED_EVERYAPI_MODEL.exec(message);
  if (unregistered === null) return debug ? message : `${message}\n${DEBUG_HINT}`;
  const remedy = `The EveryAPI model catalog is not provisioned in PI_CODING_AGENT_DIR (or its PI_AGENT_DIR compatibility alias). Start with \`everyapi use pi-web\`, or set PI_HARNESS_PROVIDER and PI_HARNESS_MODEL to a model already registered in that agent directory.`;
  // Under the debug flag the message already carries the frames bootHarness kept, and a reader who asked for them wants the remedy as well as the detail, not instead of it.
  return debug ? `${remedy}\n${message}` : `${remedy}\nPi model is not registered: ${unregistered[1]}`;
};
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  startupAbort.abort(signal);
  if (harness !== undefined) {
    let disposed = false;
    let watchdog: NodeJS.Timeout | undefined;
    await Promise.race([
      harness.dispose().then(() => {
        disposed = true;
      }),
      new Promise<void>((resolve) => {
        watchdog = setTimeout(resolve, 5_000);
      }),
    ]);
    // Once dispose settles the watchdog must not hold the event loop open for the remainder of the 5 s window.
    clearTimeout(watchdog);
    if (!disposed) {
      process.stderr.write("Pi Harness web shutdown timed out\n");
      process.exit(exitCodeFor(signal));
      return;
    }
  }
  process.exitCode = exitCodeFor(signal);
  resolveExit?.();
};
for (const signal of signals) {
  // Register with process.on rather than process.once: the Pi coding agent transitively loads signal-exit, which re-raises the signal with the default disposition (killing the process before dispose completes) whenever it finds no listener other than its own. A once-listener is removed before signal-exit runs, so it would trigger exactly that. A repeated signal during shutdown force-exits instead of waiting for the watchdog.
  process.on(signal, () => {
    if (shuttingDown) {
      process.exit(exitCodeFor(signal));
      return;
    }
    void shutdown(signal);
  });
}
// The argument checks run inside this guard rather than at module top level so a rejected value reports the same single line as a boot failure. Nothing before this point touches the disk or the network, so a wrong argument still leaves the machine exactly as it found it.
let network: NetworkOptions | undefined;
try {
  network = resolveNetworkOptions(commandLineArgs, process.env);
  process.env.PI_HARNESS_HOST = network.host;
  process.env.PI_HARNESS_PORT = String(network.port);
  process.env.PI_HARNESS_ALLOWED_HOSTS = network.allowedHosts.join(",");
  if (process.env.PI_HARNESS_DISABLE_UPDATE_CHECK !== "1") {
    void coreUpdateNotice().then(
      (notice) => {
        if (notice !== undefined) process.stderr.write(notice);
      },
      () => undefined,
    );
  }
  // The web console installs marketplace plugins with npm and then imports them, so the profile it edits and the node_modules it installs into live in a directory the user owns rather than inside the installed package, which npm replaces on every upgrade.
  const profilePath = await prepareHarnessProfile({ builtinProfilePath, profileName: "web", cwd });
  harness = await bootHarness({
    configPath: profilePath,
    pluginResolutionAnchor: fileURLToPath(import.meta.url),
    signal: startupAbort.signal,
    prepare(context) {
      provideLaunchContext(context, { cwd, agentDir, configPath: profilePath, args: [], requestExit() {} });
    },
  });
  const webServer = (harness.context as typeof harness.context & { webServer: HarnessWebServer }).webServer;
  process.stdout.write("Pi Harness web console: " + webServer.url + "\n");
  await processExit;
} catch (error) {
  if (!shuttingDown) {
    // A value the user typed exits 2, the code `pih` already returns for its own usage errors, so a script that launches either binary reads one mistake as one condition. Everything else is a runtime failure and keeps 1.
    process.exitCode = error instanceof StartupOptionError ? 2 : 1;
    process.stderr.write(formatStartupError(error, network) + "\n");
  }
}
