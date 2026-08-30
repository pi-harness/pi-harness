import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { bootHarness, type BootedHarness } from "../src/boot.js";

const booted: BootedHarness[] = [];

afterEach(async () => {
  await Promise.all(booted.splice(0).map(async (harness) => harness.dispose()));
});

async function createProfile(entries: unknown[]): Promise<{ directory: string; profilePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-harness-boot-"));
  const profilePath = join(directory, "cordis.yml");
  await writeFile(profilePath, JSON.stringify(entries), "utf8");
  return { directory, profilePath };
}

async function createPlugin(directory: string, name: string, source: string): Promise<string> {
  const path = join(directory, `${name}.mjs`);
  await writeFile(path, source, "utf8");
  return pathToFileURL(path).href;
}

describe("bootHarness", () => {
  test("loads a profile and activates its plugin", async () => {
    const profile = await createProfile([]);
    const plugin = await createPlugin(profile.directory, "provider", `export default function provider(ctx, config) { ctx.provide("fixtureValue", config.value); }`);
    await writeFile(profile.profilePath, JSON.stringify([{ name: plugin, config: { value: "active" } }]), "utf8");

    const harness = await bootHarness({ configPath: profile.profilePath });
    booted.push(harness);

    expect(harness.context.get("fixtureValue")).toBe("active");
  });

  test("fails loudly when a plugin module cannot be resolved", async () => {
    const profile = await createProfile([{ name: "./missing-plugin.mjs" }]);

    await expect(bootHarness({ configPath: profile.profilePath })).rejects.toThrow(/missing-plugin\.mjs/);
  });

  test("reports plugins left pending by unresolved injections", async () => {
    const profile = await createProfile([]);
    const plugin = await createPlugin(profile.directory, "consumer", `export default { inject: ["serviceThatDoesNotExist"], apply() {} };`);
    await writeFile(profile.profilePath, JSON.stringify([{ name: plugin }]), "utf8");

    await expect(bootHarness({ configPath: profile.profilePath })).rejects.toThrow(/serviceThatDoesNotExist/);
  });

  test("disposes already-active plugins when a later activation fails", async () => {
    const profile = await createProfile([]);
    const markerPath = join(profile.directory, "lifecycle.txt");
    const owner = await createPlugin(profile.directory, "owner", `import { appendFileSync, writeFileSync } from "node:fs"; export default function owner(ctx, config) { writeFileSync(config.markerPath, "started"); ctx.provide("fixtureOwnerReady", true); ctx.effect(() => () => appendFileSync(config.markerPath, ":disposed")); }`);
    const failure = await createPlugin(profile.directory, "failure", `export default { inject: ["fixtureOwnerReady"], apply() { throw new Error("fixture activation failed"); } };`);
    await writeFile(profile.profilePath, JSON.stringify([{ name: owner, config: { markerPath } }, { name: failure }]), "utf8");

    await expect(bootHarness({ configPath: profile.profilePath })).rejects.toThrow(/fixture activation failed/);
    await expect(readFile(markerPath, "utf8")).resolves.toBe("started:disposed");
  });
});
