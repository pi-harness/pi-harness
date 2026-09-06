import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DUPLICATE_SIGNAL_WINDOW_MS } from "../src/main.js";
import { PI_HARNESS_RESTART_EXIT_CODE, shouldRelaunchForDevelopmentProfile, superviseDevelopmentProcess } from "../src/relaunch.js";

describe("development profile relaunch", () => {
  test("requests Node internals only for an executable built-in development profile", () => {
    expect(shouldRelaunchForDevelopmentProfile(["--profile", "development"], [])).toBe(true);
    expect(shouldRelaunchForDevelopmentProfile(["--profile=development", "hello"], [])).toBe(true);
    expect(shouldRelaunchForDevelopmentProfile(["--profile", "default"], [])).toBe(false);
    expect(shouldRelaunchForDevelopmentProfile(["--config", "cordis.yml"], [])).toBe(false);
    expect(shouldRelaunchForDevelopmentProfile(["--profile", "development", "--dump-config"], [])).toBe(false);
    expect(shouldRelaunchForDevelopmentProfile(["--profile", "development"], ["--expose-internals"])).toBe(false);
    expect(shouldRelaunchForDevelopmentProfile(["--profile"], [])).toBe(false);
  });

  test("restarts a development child after Cordis requests a full reload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-supervisor-"));
    const markerPath = join(directory, "runs.txt");
    const childPath = join(directory, "child.mjs");
    await writeFile(
      childPath,
      `import { appendFileSync, existsSync } from "node:fs"; const marker = process.argv[2]; const first = !existsSync(marker); appendFileSync(marker, "run\\n"); process.exit(first ? ${PI_HARNESS_RESTART_EXIT_CODE} : 7);`,
      "utf8",
    );

    const exitCode = await superviseDevelopmentProcess(process.execPath, [childPath, markerPath], { stdio: "ignore" });

    expect(exitCode).toBe(7);
    expect((await readFile(markerPath, "utf8")).split("\n").filter(Boolean)).toEqual(["run", "run"]);
  });

  test("gives up instead of respawning a child that requests restarts in a tight loop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-supervisor-loop-"));
    const markerPath = join(directory, "runs.txt");
    const childPath = join(directory, "child.mjs");
    await writeFile(
      childPath,
      `import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], "run\\n"); process.exit(${PI_HARNESS_RESTART_EXIT_CODE});`,
      "utf8",
    );

    const exitCode = await superviseDevelopmentProcess(process.execPath, [childPath, markerPath], { stdio: "ignore" });

    expect(exitCode).toBe(1);
    expect((await readFile(markerPath, "utf8")).split("\n").filter(Boolean).length).toBe(6);
  });

  test("reports a signal-killed child with the shell's 128 + signal number convention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-supervisor-signal-"));
    const childPath = join(directory, "child.mjs");
    await writeFile(childPath, `process.kill(process.pid, "SIGKILL");`, "utf8");

    await expect(superviseDevelopmentProcess(process.execPath, [childPath], { stdio: "ignore" })).resolves.toBe(137);
  });

  test("rejects with a spawn failure instead of hanging", async () => {
    await expect(superviseDevelopmentProcess(join(tmpdir(), "pi-harness-not-a-binary"), [], { stdio: "ignore" })).rejects.toThrow(/ENOENT/);
  });
});

describe("development profile signal forwarding", () => {
  async function startChild(label: string, body: string): Promise<{ markerPath: string; childPath: string }> {
    const directory = await mkdtemp(join(tmpdir(), `pi-harness-supervisor-${label}-`));
    const markerPath = join(directory, "started.txt");
    const childPath = join(directory, "child.mjs");
    // The marker is written last, after the body has installed its handlers. Written first, it announces a child that node would still kill outright with the default disposition, because a signal only becomes catchable once a listener for it exists - which is how this test was seen to observe exit 130 where it expected 31.
    await writeFile(childPath, `import { writeFileSync } from "node:fs"; ${body} writeFileSync(process.argv[2], "started");`, "utf8");
    return { markerPath, childPath };
  }

  test("relays SIGTERM to the child and reports its signal exit", async () => {
    const { markerPath, childPath } = await startChild("term", "setInterval(() => {}, 1_000);");
    const supervised = superviseDevelopmentProcess(process.execPath, [childPath, markerPath], { stdio: "ignore" });
    await expect.poll(() => existsSync(markerPath), { interval: 20, timeout: 5_000 }).toBe(true);

    process.emit("SIGTERM", "SIGTERM");

    await expect(supervised).resolves.toBe(143);
  });

  // The vitest worker has no terminal on any of the three descriptors, so the tty state is faked here to pin that relaying does not depend on it.
  function withTerminalStdio<T>(isTTY: boolean, spawnChild: () => T): T {
    const streams = [process.stdin, process.stdout, process.stderr];
    const original = streams.map((stream) => stream.isTTY);
    for (const stream of streams) stream.isTTY = isTTY;
    try {
      return spawnChild();
    } finally {
      for (const [index, stream] of streams.entries()) stream.isTTY = original[index] ?? false;
    }
  }

  test.skipIf(process.platform === "win32")(
    "relays SIGINT and SIGHUP to the child whether or not the inherited stdio is a terminal",
    async () => {
      for (const isTTY of [true, false]) {
        for (const [signal, code] of [
          ["SIGINT", 31],
          ["SIGHUP", 32],
        ] as const) {
          const { markerPath, childPath } = await startChild(
            `${signal.toLowerCase()}-${String(isTTY)}`,
            // Exiting with 21 when no signal arrives distinguishes a swallowed relay from a slow one.
            `process.on("SIGINT", () => process.exit(31)); process.on("SIGHUP", () => process.exit(32)); setTimeout(() => process.exit(21), 2_000);`,
          );
          const supervised = withTerminalStdio(isTTY, () => superviseDevelopmentProcess(process.execPath, [childPath, markerPath], { stdio: "ignore" }));
          await expect.poll(() => existsSync(markerPath), { interval: 20, timeout: 5_000 }).toBe(true);

          expect(process.emit(signal, signal)).toBe(true);

          await expect(supervised).resolves.toBe(code);
        }
      }
    },
    30_000,
  );

  // A real `kill -INT -<pgid>` would also hit the vitest worker, so the group broadcast is simulated: the signal is delivered straight to the child (the terminal's copy) and emitted on this process (the copy the supervisor relays), 2ms apart, which matches the sub-millisecond spacing measured between the two copies and is well inside the duplicate window.
  // How many deliveries the child sees is the kernel's decision, not this code's: two SIGINTs that are pending together are coalesced into one, which was observed on roughly one run in five and is why the count is asserted as at least one rather than exactly two. What this test pins is the outcome under a group broadcast - one graceful shutdown, exit 130, no force-quit - and it holds under either delivery count. The window logic itself is pinned deterministically and in-process against the real runCli in main.test.ts.
  test.skipIf(process.platform === "win32")("a group broadcast that reaches the child directly and through the relay shuts the child down once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-supervisor-broadcast-"));
    const markerPath = join(directory, "signals.txt");
    const pidPath = join(directory, "pid.txt");
    const childPath = join(directory, "child.mjs");
    await writeFile(
      childPath,
      // The child mirrors runCli's handler: every delivery is recorded, but a repeat of the same signal inside DUPLICATE_SIGNAL_WINDOW_MS is ignored instead of counting toward the force-quit path.
      `import { appendFileSync, writeFileSync } from "node:fs";
const marker = process.argv[2];
let lastSignal;
let lastSignalAt = 0;
let signalCount = 0;
process.on("SIGINT", () => {
  appendFileSync(marker, "delivery\\n");
  const receivedAt = performance.now();
  if (lastSignal === "SIGINT" && receivedAt - lastSignalAt < ${DUPLICATE_SIGNAL_WINDOW_MS}) return;
  lastSignal = "SIGINT";
  lastSignalAt = receivedAt;
  signalCount += 1;
  if (signalCount > 1) {
    appendFileSync(marker, "force-quit\\n");
    process.exit(1);
  }
  setTimeout(() => {
    appendFileSync(marker, "graceful\\n");
    process.exit(130);
  }, 25);
});
writeFileSync(process.argv[3], String(process.pid));
setInterval(() => {}, 1_000);`,
      "utf8",
    );
    const supervised = superviseDevelopmentProcess(process.execPath, [childPath, markerPath, pidPath], { stdio: "ignore" });
    await expect.poll(() => (existsSync(pidPath) ? readFileSync(pidPath, "utf8") : ""), { interval: 20, timeout: 5_000 }).not.toBe("");
    const childPid = Number(readFileSync(pidPath, "utf8"));

    process.kill(childPid, "SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(process.emit("SIGINT", "SIGINT")).toBe(true);

    await expect(supervised).resolves.toBe(130);
    const events = (await readFile(markerPath, "utf8")).split("\n").filter(Boolean);
    expect(events.filter((event) => event === "delivery").length).toBeGreaterThanOrEqual(1);
    expect(events).toContain("graceful");
    expect(events).not.toContain("force-quit");
  });
});
