import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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
    await writeFile(childPath, `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "started"); ${body}`, "utf8");
    return { markerPath, childPath };
  }

  test("relays SIGTERM to the child and reports its signal exit", async () => {
    const { markerPath, childPath } = await startChild("term", "setInterval(() => {}, 1_000);");
    const supervised = superviseDevelopmentProcess(process.execPath, [childPath, markerPath], { stdio: "ignore" });
    await expect.poll(() => existsSync(markerPath), { interval: 20, timeout: 5_000 }).toBe(true);

    process.emit("SIGTERM", "SIGTERM");

    await expect(supervised).resolves.toBe(143);
  });

  test.skipIf(process.platform === "win32")(
    "does not forward SIGINT or SIGHUP, which the shared foreground process group already delivers to the child",
    async () => {
      const { markerPath, childPath } = await startChild("int", "setTimeout(() => process.exit(21), 800);");
      const supervised = superviseDevelopmentProcess(process.execPath, [childPath, markerPath], { stdio: "ignore" });
      await expect.poll(() => existsSync(markerPath), { interval: 20, timeout: 5_000 }).toBe(true);

      expect(process.emit("SIGINT", "SIGINT")).toBe(true);
      expect(process.emit("SIGHUP", "SIGHUP")).toBe(true);

      await expect(supervised).resolves.toBe(21);
    },
  );
});
