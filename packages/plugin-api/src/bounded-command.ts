import { spawn, type ChildProcess } from "node:child_process";

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // Windows has no POSIX process groups. Terminate the tree while its root
    // still exists; killing the root first would lose taskkill's tree lookup.
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill("SIGKILL"));
    killer.once("close", (code) => {
      if (code !== 0) child.kill("SIGKILL");
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group may already be gone. ChildProcess guards an exited root.
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

/** Bounded argv execution in an owned process group; no shell or stdin channel. */
export function runBoundedCommand(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
  options: { env?: NodeJS.ProcessEnv; encoding: "buffer" },
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export function runBoundedCommand(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
  options?: { env?: NodeJS.ProcessEnv; encoding?: "utf8" },
): Promise<{ stdout: string; stderr: string }>;
export function runBoundedCommand(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
  options: { env?: NodeJS.ProcessEnv; encoding?: "utf8" | "buffer" } = {},
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  signal?.throwIfAborted();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1)
    throw new RangeError("Command timeout must be an integer between 1 and 2147483647 ms");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) throw new RangeError("Command output limit must be a non-negative safe integer");
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let stdoutBytes = 0,
      stderrBytes = 0;
    let failure: Error | undefined;
    let stopped = false;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: Error) => {
      failure ??= reason;
      if (stopped) return;
      stopped = true;
      terminate(child, "SIGTERM");
      forceTimer = setTimeout(() => {
        terminate(child, "SIGKILL");
        // Escaped descendants can retain these pipes indefinitely. Bound the
        // failed operation independently of their lifetime, not just root exit.
        child.stdout.destroy();
        child.stderr.destroy();
        finish(child.exitCode, child.signalCode);
      }, 1000);
      // Cleanup must also finish in a short-lived CLI host after the leader exits.
    };
    const onAbort = () => stop(new Error("Command cancelled", { cause: signal?.reason }));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeout = setTimeout(() => stop(Object.assign(new Error(`Command timed out after ${timeoutMs} ms`), { killed: true })), timeoutMs);
    timeout.unref();
    const append = (chunks: Buffer[], chunk: Buffer, used: number): number => {
      const remaining = Math.max(0, maxOutputBytes - used);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining)
        stop(
          Object.assign(new Error("Command output limit exceeded"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        );
      return used + Math.min(remaining, chunk.length);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes);
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    const finish = (code: number | null, childSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      // On POSIX a descendant can ignore SIGTERM and survive the leader's exit,
      // even with stdio closed. Keep the group's already-scheduled escalation.
      if (forceTimer !== undefined && process.platform === "win32") clearTimeout(forceTimer);
      const raw = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      const output = options.encoding === "buffer" ? raw : { stdout: raw.stdout.toString("utf8"), stderr: raw.stderr.toString("utf8") };
      if (failure !== undefined) {
        reject(Object.assign(failure, output));
        return;
      }
      if (code !== 0) {
        reject(Object.assign(new Error(`Command failed (${childSignal ?? code ?? "unknown"})`), { code: code ?? 1, ...output }));
        return;
      }
      resolve(output);
    };
    child.once("close", finish);
  });
}
