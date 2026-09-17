import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveProfileConfig } from "../src/profile.js";

async function createProfiles(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-profiles-"));
  await mkdir(join(root, "default"));
  await writeFile(join(root, "default", "cordis.yml"), "[]\n", "utf8");
  return root;
}

describe("resolveProfileConfig", () => {
  test("resolves the default built-in profile", async () => {
    const profilesDir = await createProfiles();

    await expect(resolveProfileConfig({ profilesDir })).resolves.toBe(join(profilesDir, "default", "cordis.yml"));
  });

  test("resolves an explicit config path from the invoking directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-config-"));
    await writeFile(join(cwd, "custom.yml"), "[]\n", "utf8");

    await expect(resolveProfileConfig({ configPath: "custom.yml", cwd })).resolves.toBe(resolve(cwd, "custom.yml"));
  });

  test("rejects profile names that can escape the profiles directory", async () => {
    const profilesDir = await createProfiles();

    await expect(resolveProfileConfig({ profile: "../outside", profilesDir })).rejects.toThrow(/invalid profile name/i);
  });

  test("rejects a missing profile with its resolved path", async () => {
    const profilesDir = await createProfiles();

    await expect(resolveProfileConfig({ profile: "missing", profilesDir })).rejects.toThrow(join(profilesDir, "missing", "cordis.yml"));
  });

  test("rejects a directory as the entry tree rather than leaving the loader to report an empty extension", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-config-directory-"));

    await expect(resolveProfileConfig({ configPath: cwd, cwd })).rejects.toThrow(`Pi Harness profile config is a directory, not a YAML or JSON file: ${cwd}`);
  });

  test("rejects an entry tree whose extension the loader cannot parse", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-config-extension-"));
    await writeFile(join(cwd, "cordis"), "[]\n", "utf8");

    await expect(resolveProfileConfig({ configPath: "cordis", cwd })).rejects.toThrow(
      `Pi Harness profile config must end in .yml, .yaml or .json: ${resolve(cwd, "cordis")}`,
    );
  });

  test("accepts the other extensions the loader parses", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-config-extensions-"));
    await writeFile(join(cwd, "custom.YAML"), "[]\n", "utf8");
    await writeFile(join(cwd, "custom.json"), "[]\n", "utf8");

    await expect(resolveProfileConfig({ configPath: "custom.YAML", cwd })).resolves.toBe(resolve(cwd, "custom.YAML"));
    await expect(resolveProfileConfig({ configPath: "custom.json", cwd })).resolves.toBe(resolve(cwd, "custom.json"));
  });
});
