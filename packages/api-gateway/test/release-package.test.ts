import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const bundledWorkspacePaths = ["api-gateway", "cli", "host-webserver", "bundle-web-app"] as const;
const bundledRuntimePackageNames = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"] as const;
const bundledWorkspacePackageNames = ["@pi-harness/api-gateway", "@pi-harness/cli", "@pi-harness/host-webserver", "@pi-harness/web-app"] as const;
const bundledPackageNames = [...bundledRuntimePackageNames, ...bundledWorkspacePackageNames];

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8")) as Record<string, unknown>;

describe("release package", () => {
  it("publishes the launcher and keeps core independently installable", async () => {
    const rootManifest = await readJson("package.json");
    const dependencies = rootManifest.dependencies as Record<string, string>;

    expect(rootManifest.bundledDependencies).toEqual(bundledPackageNames);
    expect(bundledWorkspacePackageNames.every((name) => dependencies[name] === rootManifest.version)).toBe(true);
    expect(bundledRuntimePackageNames.every((name) => /^\d+\.\d+\.\d+$/u.test(dependencies[name] ?? ""))).toBe(true);

    for (const path of bundledWorkspacePaths) {
      const manifest = await readJson(`packages/${path}/package.json`);
      expect(manifest.private, `${manifest.name as string} must not be published separately`).toBe(true);
      expect(manifest.dependencies, `${manifest.name as string} dependencies must be owned by the public root package`).toBeUndefined();
    }

    const clientManifest = await readJson("packages/client-web/package.json");
    expect(clientManifest.private).toBe(true);

    const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("npm publish --workspace @pi-harness/core --access public");
    expect(workflow).toContain("npm publish --access public");
    expect(workflow).toContain("Verify package availability");
    expect(workflow).not.toContain("RELEASE_TAG_EXISTS");
  });

  it("cleans every compiled workspace output", async () => {
    // `tsc` never removes stale emit, so an output directory that no clean script touches keeps publishing files whose sources are gone.
    const rootManifest = await readJson("package.json");
    const rootClean = (rootManifest.scripts as Record<string, string>).clean ?? "";
    const outputs: string[] = [];

    for (const root of ["packages", "apps", "examples"]) {
      for (const entry of await readdir(resolve(repositoryRoot, root), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const workspace = `${root}/${entry.name}`;
        const buildConfigPath = resolve(repositoryRoot, workspace, "tsconfig.build.json");
        const hasBuildConfig = await stat(buildConfigPath).then(
          () => true,
          () => false,
        );
        if (!hasBuildConfig) continue;
        const buildConfig = JSON.parse(await readFile(buildConfigPath, "utf8")) as { compilerOptions?: { outDir?: string } };
        const outDir = buildConfig.compilerOptions?.outDir;
        expect(outDir, `${workspace}/tsconfig.build.json declares no outDir`).toBeDefined();
        const workspaceManifest = await readJson(`${workspace}/package.json`);
        const workspaceClean = (workspaceManifest.scripts as Record<string, string> | undefined)?.clean;
        outputs.push(`${workspace}/${outDir ?? ""}`);
        expect(workspaceClean !== undefined || rootClean.includes(`${workspace}/${outDir ?? ""}`), `${workspace}/${outDir ?? ""} survives npm run clean`).toBe(
          true,
        );
      }
    }

    expect(outputs.length).toBeGreaterThan(0);
  });
});
