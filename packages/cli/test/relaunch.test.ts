import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PI_HARNESS_RESTART_EXIT_CODE, shouldRelaunchForDevelopmentProfile, superviseDevelopmentProcess } from "../src/relaunch.js";

describe("development profile relaunch", () => {
  test("requests Node internals only for an executable built-in development profile", () => {
    expect(shouldRelaunchForDevelopmentProfile(["--profile", "development"], [])).toBe(true);
    expect(shouldRelaunchForDevelopmentProfile(["--profile=development", "hello"], [])).toBe(false);
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
});
