import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { harnessHomeDirectory, prepareHarnessProfile } from "../src/harness-home.js";

async function createDistribution(profile: string): Promise<{ builtinProfilePath: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-harness-home-"));
  const builtinProfilePath = join(directory, "builtin.yml");
  await writeFile(builtinProfilePath, profile, "utf8");
  return { builtinProfilePath, directory };
}

describe("harnessHomeDirectory", () => {
  test("defaults under the home directory and resolves a relative override against the working directory", () => {
    expect(harnessHomeDirectory({}, "/workdir")).toMatch(/[/\\]\.pi-harness$/u);
    expect(harnessHomeDirectory({ PI_HARNESS_HOME: "  " }, "/workdir")).toMatch(/[/\\]\.pi-harness$/u);
    expect(harnessHomeDirectory({ PI_HARNESS_HOME: "state/harness" }, "/workdir")).toBe(join("/workdir", "state", "harness"));
  });
});

describe("prepareHarnessProfile", () => {
  test("seeds the profile and the manifest npm installs against", async () => {
    const { builtinProfilePath, directory } = await createDistribution("- id: one\n");
    const home = join(directory, "home");

    const profilePath = await prepareHarnessProfile({ builtinProfilePath, profileName: "web", directory: home });

    expect(profilePath).toBe(join(home, "profiles", "web", "cordis.yml"));
    expect(await readFile(profilePath, "utf8")).toBe("- id: one\n");
    const manifest = JSON.parse(await readFile(join(home, "package.json"), "utf8")) as { private?: boolean };
    expect(manifest.private).toBe(true);
  });

  test("keeps following the shipped profile while the copy is untouched", async () => {
    const { builtinProfilePath, directory } = await createDistribution("- id: one\n");
    const home = join(directory, "home");
    const profilePath = await prepareHarnessProfile({ builtinProfilePath, profileName: "web", directory: home });

    await writeFile(builtinProfilePath, "- id: one\n- id: two\n", "utf8");
    await prepareHarnessProfile({ builtinProfilePath, profileName: "web", directory: home });

    expect(await readFile(profilePath, "utf8")).toBe("- id: one\n- id: two\n");
  });

  test("stops following once the copy carries edits the distribution does not know about", async () => {
    const { builtinProfilePath, directory } = await createDistribution("- id: one\n");
    const home = join(directory, "home");
    const profilePath = await prepareHarnessProfile({ builtinProfilePath, profileName: "web", directory: home });
    // Stands in for the marketplace appending an installed plugin to the booted profile.
    await writeFile(profilePath, "- id: one\n- id: marketplace\n", "utf8");

    await writeFile(builtinProfilePath, "- id: one\n- id: two\n", "utf8");
    await prepareHarnessProfile({ builtinProfilePath, profileName: "web", directory: home });

    expect(await readFile(profilePath, "utf8")).toBe("- id: one\n- id: marketplace\n");
  });

  test("keeps an existing manifest so an installed dependency list survives the next boot", async () => {
    const { builtinProfilePath, directory } = await createDistribution("- id: one\n");
    const home = join(directory, "home");
    await prepareHarnessProfile({ builtinProfilePath, profileName: "web", directory: home });
    const manifestPath = join(home, "package.json");
    await writeFile(manifestPath, JSON.stringify({ name: "pi-harness-home", private: true, dependencies: { "@fixture/plugin": "1.0.0" } }), "utf8");

    await prepareHarnessProfile({ builtinProfilePath, profileName: "web", directory: home });

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies).toEqual({ "@fixture/plugin": "1.0.0" });
  });

  test("gives each profile name its own copy under one shared install directory", async () => {
    const { builtinProfilePath, directory } = await createDistribution("- id: one\n");
    const home = join(directory, "home");

    const web = await prepareHarnessProfile({ builtinProfilePath, profileName: "web", directory: home });
    const development = await prepareHarnessProfile({ builtinProfilePath, profileName: "development", directory: home });

    expect(web).not.toBe(development);
    expect(join(web, "..", "..", "..")).toBe(join(development, "..", "..", ".."));
  });
});
