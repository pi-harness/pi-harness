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
    const plugin = await createPlugin(
      profile.directory,
      "provider",
      `export default function provider(ctx, config) { ctx.provide("fixtureValue", config.value); }`,
    );
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
    const owner = await createPlugin(
      profile.directory,
      "owner",
      `import { appendFileSync, writeFileSync } from "node:fs"; export default function owner(ctx, config) { writeFileSync(config.markerPath, "started"); ctx.provide("fixtureOwnerReady", true); ctx.effect(() => () => appendFileSync(config.markerPath, ":disposed")); }`,
    );
    const failure = await createPlugin(
      profile.directory,
      "failure",
      `export default { inject: ["fixtureOwnerReady"], apply() { throw new Error("fixture activation failed"); } };`,
    );
    await writeFile(profile.profilePath, JSON.stringify([{ name: owner, config: { markerPath } }, { name: failure }]), "utf8");

    await expect(bootHarness({ configPath: profile.profilePath })).rejects.toThrow(/fixture activation failed/);
    await expect(readFile(markerPath, "utf8")).resolves.toBe("started:disposed");
  });

  test("does not rewrite a profile when a nested group rolls back", async () => {
    const profile = await createProfile([]);
    const active = await createPlugin(profile.directory, "active", `export default function active(ctx) { ctx.provide("fixtureNestedReady", true); }`);
    const failure = await createPlugin(
      profile.directory,
      "nested-failure",
      `export default { inject: ["fixtureNestedReady"], apply() { throw new Error("nested activation failed"); } };`,
    );
    const source = JSON.stringify([
      {
        id: "fixture-group",
        name: "cordis:group",
        group: true,
        config: [
          { id: "active", name: active },
          { id: "nested-failure", name: failure },
        ],
      },
    ]);
    await writeFile(profile.profilePath, source, "utf8");

    await expect(bootHarness({ configPath: profile.profilePath })).rejects.toThrow(/nested activation failed/);

    await expect(readFile(profile.profilePath, "utf8")).resolves.toBe(source);
  });

  test("rejects a duplicate entry id reused across sibling groups", async () => {
    const profile = await createProfile([]);
    const first = await createPlugin(
      profile.directory,
      "first",
      `export default function first(ctx, config) { ctx.provide("fixtureDuplicate", config?.tag ?? "no-config"); }`,
    );
    const second = await createPlugin(profile.directory, "second", `export default function second(ctx) { ctx.provide("fixtureDuplicateSecond", true); }`);
    await writeFile(
      profile.profilePath,
      JSON.stringify([
        { id: "one", name: "cordis:group", group: true, config: [{ id: "shared", name: first, config: { tag: "kept" } }] },
        { id: "two", name: "cordis:group", group: true, config: [{ id: "shared", name: second }] },
      ]),
      "utf8",
    );

    await expect(bootHarness({ configPath: profile.profilePath })).rejects.toThrow(/Duplicate loader entry id "shared"/);
  });

  test("forwards Cordis full-reload requests to the host", async () => {
    const profile = await createProfile([]);
    let reloads = 0;
    const harness = await bootHarness({
      configPath: profile.profilePath,
      onFullReload() {
        reloads += 1;
      },
    });
    booted.push(harness);

    harness.context.loader.exit();

    expect(reloads).toBe(1);
  });
});
