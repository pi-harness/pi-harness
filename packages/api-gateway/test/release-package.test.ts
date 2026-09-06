import { readFile } from "node:fs/promises";
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
    expect(workflow).toContain("RELEASE_TAG_EXISTS: ${{ steps.release.outputs.tag_exists }}");
  });
});
