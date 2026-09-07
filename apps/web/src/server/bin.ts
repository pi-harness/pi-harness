#!/usr/bin/env node

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootHarness, coreUpdateNotice, prepareHarnessProfile, provideLaunchContext } from "@pi-harness/core";
import "@pi-harness/host-webserver";
import type { WebServer } from "@pi-harness/host-webserver";

// Keep the host service declaration in the server entrypoint's type graph.
type HarnessWebServer = WebServer;

// An unhandled 'error' event on a stream throws, so an EPIPE from a reader that closed early (`pi-harness | head -1`) would kill the process before the signal handlers can run the graceful shutdown. Swallowing the event leaves the write silently dropped, which is what a closed pipe means.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

// Accept the bracketed URL form of an IPv6 literal (e.g. "[::1]") but bind the bare address: net.Server.listen resolves the host through getaddrinfo, which rejects brackets with ENOTFOUND.
const rawHost = process.env.PI_HARNESS_HOST ?? "127.0.0.1";
const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
const DEFAULT_PI_HARNESS_PORT = 3141;
const port = Number(process.env.PI_HARNESS_PORT ?? DEFAULT_PI_HARNESS_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PI_HARNESS_PORT must be an integer between 0 and 65535");
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!loopbackHosts.has(host) && process.env.PI_HARNESS_ALLOW_REMOTE !== "1")
  throw new Error("Refusing non-loopback PI_HARNESS_HOST; set PI_HARNESS_ALLOW_REMOTE=1 only on a trusted network");
// Extra hostnames the web server accepts in the Host header, comma separated, for a deployment reached through a reverse proxy under a name this machine does not resolve to itself.
const allowedHosts = (process.env.PI_HARNESS_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
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
const invalidAllowedHost = allowedHosts.find((entry) => !isBareHostname(entry));
if (invalidAllowedHost !== undefined)
  throw new Error("PI_HARNESS_ALLOWED_HOSTS entries must be bare hostnames without a scheme, port or path: " + invalidAllowedHost);
const cwd = process.cwd();
// PI_AGENT_DIR is one documented variable shared with the CLI launcher, so normalize it the same way there: blank means unset, and a relative value resolves against the working directory rather than failing the absolute-path check in provideLaunchContext.
const configuredAgentDir = process.env.PI_AGENT_DIR?.trim();
const agentDir = configuredAgentDir === undefined || configuredAgentDir.length === 0 ? join(homedir(), ".pi", "agent") : resolve(cwd, configuredAgentDir);
const staticDir = fileURLToPath(new URL("../dist", import.meta.url));
const builtinProfilePath = fileURLToPath(new URL("../profile/cordis.yml", import.meta.url));
// The web console installs marketplace plugins with npm and then imports them, so the profile it edits and the node_modules it installs into live in a directory the user owns rather than inside the installed package, which npm replaces on every upgrade.
const profilePath = await prepareHarnessProfile({ builtinProfilePath, profileName: "web", cwd });
process.env.PI_HARNESS_WEB_DIST = staticDir;
process.env.PI_HARNESS_HOST = host;
process.env.PI_HARNESS_PORT = String(port);
process.env.PI_HARNESS_ALLOWED_HOSTS = allowedHosts.join(",");
if (process.env.PI_HARNESS_DISABLE_UPDATE_CHECK !== "1") {
  void coreUpdateNotice().then(
    (notice) => {
      if (notice !== undefined) process.stderr.write(notice);
    },
    () => undefined,
  );
}
const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
const startupAbort = new AbortController();
let shuttingDown = false;
let resolveExit: (() => void) | undefined;
const processExit = new Promise<void>((resolve) => {
  resolveExit = resolve;
});
let harness: Awaited<ReturnType<typeof bootHarness>> | undefined;
const exitCodeFor = (signal: NodeJS.Signals): number => (signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
const formatStartupError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (!/Pi model is not registered: everyapi\//u.test(message)) return message;
  return `${message}\n\nThe EveryAPI model catalog is not provisioned in PI_AGENT_DIR. Start with \`everyapi use pi-harness\`, or set PI_HARNESS_PROVIDER and PI_HARNESS_MODEL to a model already registered in that agent directory.`;
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
try {
  harness = await bootHarness({
    configPath: profilePath,
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
    process.exitCode = 1;
    process.stderr.write(formatStartupError(error) + "\n");
  }
}
