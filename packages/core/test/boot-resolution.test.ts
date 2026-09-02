import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { bootHarness, type BootedHarness } from "../src/boot.js";

const booted: BootedHarness[] = [];

afterEach(async () => {
  await Promise.all(booted.splice(0).map(async (harness) => harness.dispose()));
});

describe("profile module resolution", () => {
  test("resolves a bare specifier from the directory containing the profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-resolve-"));
    const packageDir = join(directory, "node_modules", "@acme", "pi-probe");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@acme/pi-probe", version: "1.0.0", type: "module", exports: { ".": "./index.mjs" } }), "utf8");
    await writeFile(join(packageDir, "index.mjs"), `export default { apply(ctx) { ctx.provide("acmeProbe", "resolved"); } };`, "utf8");
    const profilePath = join(directory, "cordis.yml");
    await writeFile(profilePath, JSON.stringify([{ id: "probe", name: "@acme/pi-probe" }]), "utf8");

    const harness = await bootHarness({ configPath: profilePath });
    booted.push(harness);

    expect(harness.context.get("acmeProbe")).toBe("resolved");
  });

  test("still reports an unresolvable bare specifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-resolve-missing-"));
    const profilePath = join(directory, "cordis.yml");
    await writeFile(profilePath, JSON.stringify([{ id: "probe", name: "@acme/definitely-not-installed" }]), "utf8");

    await expect(bootHarness({ configPath: profilePath })).rejects.toThrow(/@acme\/definitely-not-installed/);
  });
});
