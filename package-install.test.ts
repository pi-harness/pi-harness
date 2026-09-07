import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

// Every profile the tarball ships. A profile entry names a package by its bare specifier, so the loader can only import it if the launcher installed it, which is what makes these files part of the dependency contract rather than mere configuration.
const shippedProfiles = [
  "apps/web/profile/cordis.yml",
  ...readdirSync(join(root, "packages/cli/profiles")).map((name) => `packages/cli/profiles/${name}/cordis.yml`),
];

// The profile carries !!js tags that a plain YAML parse rejects, and an entry always names its package on a quoted name line, so the specifiers are read directly.
const profilePlugins = (profile: string): string[] => [
  ...new Set([...readFileSync(join(root, profile), "utf8").matchAll(/name: "(@pi-harness\/plugin-[a-z0-9-]+)"/gu)].map((match) => match[1] ?? "")),
];

describe("global package install contract", () => {
  test("does not run the workspace build from npm prepare", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.prepare).not.toBe("npm run build:web");
    expect(existsSync(join(root, "apps/web/server-dist/bin.js"))).toBe(true);
    expect(existsSync(join(root, "apps/web/dist/index.html"))).toBe(true);
  });

  test("keeps the Git package manifest and generated web entrypoint in npm packs", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      private?: boolean;
      files?: string[];
      scripts?: Record<string, string>;
    };
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/u);
    expect(gitignore).not.toContain("package.json");
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.scripts?.prepack).toBe("npm run build:web && node scripts/prepare-published-manifest.mjs --strip");
    // Without the restore the working tree keeps the stripped manifests after every pack, and the next build has no dependencies to build against.
    expect(packageJson.scripts?.postpack).toBe("node scripts/prepare-published-manifest.mjs --restore");
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["apps/web", "packages/api-gateway", "packages/cli", "packages/host-webserver", "packages/bundle-web-app"]),
    );
    expect(packageJson.files).not.toContain("packages");
  });
});

describe("shipped profile dependency contract", () => {
  test("reads the plugin entries out of the profiles it checks", () => {
    // A profile format change that stopped matching would make every assertion below vacuously true, so the reader is checked against the profile that carries the full set.
    expect(profilePlugins("apps/web/profile/cordis.yml").length).toBeGreaterThan(50);
  });

  test.each(shippedProfiles)("%s enables only plugins the launcher installs", (profile) => {
    const dependencies = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
    const enabled = profilePlugins(profile);

    // A plugin the profile enables but the launcher does not depend on is missing from a global install, and the harness fails to boot on the first entry it cannot import.
    expect(enabled.filter((name) => dependencies[name] === undefined)).toEqual([]);
    for (const name of enabled) {
      const workspace = join(root, "packages/plugins", name.slice("@pi-harness/plugin-".length), "package.json");
      expect(existsSync(workspace), `${name} is enabled by ${profile} but has no workspace`).toBe(true);
      expect(dependencies[name], `${name} is declared at a version the workspace does not build`).toBe(
        (JSON.parse(readFileSync(workspace, "utf8")) as { version: string }).version,
      );
    }
  });
});

describe("published manifest preparation", () => {
  const run = (cwd: string, mode: string): void => {
    execFileSync(process.execPath, [join(root, "scripts/prepare-published-manifest.mjs"), mode], { cwd });
  };

  const createTree = (manifest: unknown): { cwd: string; manifestPath: string } => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-harness-published-manifest-"));
    mkdirSync(join(cwd, "apps/web"), { recursive: true });
    const manifestPath = join(cwd, "apps/web/package.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");
    return { cwd, manifestPath };
  };

  test("drops the dependency lists a user can never install and puts them back", () => {
    const { cwd, manifestPath } = createTree({
      name: "@pi-harness/web",
      private: true,
      type: "module",
      dependencies: { "@pi-harness/client-web": "0.1.29" },
      devDependencies: { vite: "8.2.2" },
    });
    const before = readFileSync(manifestPath, "utf8");

    run(cwd, "--strip");
    const stripped = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    run(cwd, "--restore");

    expect(stripped).toEqual({ name: "@pi-harness/web", private: true, type: "module" });
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(existsSync(join(cwd, "published-manifest.backup.json"))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("recovers a working tree that a failed pack left stripped", () => {
    const { cwd, manifestPath } = createTree({ name: "@pi-harness/web", private: true, dependencies: { "@pi-harness/client-web": "0.1.29" } });
    const before = readFileSync(manifestPath, "utf8");

    // The pack died after prepack, so the backup is still on disk and the manifest is still stripped when the next pack starts.
    run(cwd, "--strip");
    run(cwd, "--strip");
    run(cwd, "--restore");

    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("restores nothing when no pack is in flight", () => {
    const { cwd, manifestPath } = createTree({ name: "@pi-harness/web", private: true });
    const before = readFileSync(manifestPath, "utf8");

    run(cwd, "--restore");

    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    rmSync(cwd, { recursive: true, force: true });
  });
});
