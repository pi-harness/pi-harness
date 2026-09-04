import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");

const writeJson = async (root: string, path: string, value: unknown): Promise<void> => {
  const target = resolve(root, path);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, undefined, 2)}\n`);
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("release version preparation", () => {
  it("synchronizes manifests, lock data, and internal marketplace entries without changing external versions", async () => {
    const fixture = await mkdtemp(resolve(tmpdir(), "pi-harness-release-version-"));
    fixtures.push(fixture);
    await Promise.all([mkdir(resolve(fixture, "apps")), mkdir(resolve(fixture, "examples"))]);
    await writeJson(fixture, "package.json", { name: "@pi-harness/pi-harness", version: "0.1.2", dependencies: { "@pi-harness/core": "0.1.2" } });
    await writeJson(fixture, "packages/core/package.json", { name: "@pi-harness/core", version: "0.1.2" });
    await writeJson(fixture, "packages/api-gateway/package.json", { name: "@pi-harness/api-gateway", version: "0.1.2" });
    await writeJson(fixture, "package-lock.json", {
      name: "@pi-harness/pi-harness",
      version: "0.1.2",
      lockfileVersion: 3,
      packages: {
        "": { name: "@pi-harness/pi-harness", version: "0.1.2", dependencies: { "@pi-harness/core": "0.1.2" } },
        "packages/core": { name: "@pi-harness/core", version: "0.1.2" },
        "packages/api-gateway": { name: "@pi-harness/api-gateway", version: "0.1.2" },
      },
    });
    await writeJson(fixture, "packages/api-gateway/src/marketplace-entries/official/internal.json", {
      packageName: "@pi-harness/core/plugins/example",
      version: "0.1.2",
    });
    await writeJson(fixture, "packages/api-gateway/src/marketplace-entries/official/external.json", { packageName: "external-plugin", version: "4.5.6" });

    await execFileAsync(process.execPath, [resolve(repositoryRoot, "scripts/set-release-version.mjs"), "0.1.3"], { cwd: fixture });

    const rootManifest = JSON.parse(await readFile(resolve(fixture, "package.json"), "utf8")) as Record<string, unknown>;
    const packageLock = JSON.parse(await readFile(resolve(fixture, "package-lock.json"), "utf8")) as Record<string, unknown>;
    const internalEntry = JSON.parse(await readFile(resolve(fixture, "packages/api-gateway/src/marketplace-entries/official/internal.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const externalEntry = JSON.parse(await readFile(resolve(fixture, "packages/api-gateway/src/marketplace-entries/official/external.json"), "utf8")) as Record<
      string,
      unknown
    >;

    expect(rootManifest).toMatchObject({ version: "0.1.3", dependencies: { "@pi-harness/core": "0.1.3" } });
    expect(packageLock).toMatchObject({
      version: "0.1.3",
      packages: {
        "": { version: "0.1.3", dependencies: { "@pi-harness/core": "0.1.3" } },
        "packages/core": { version: "0.1.3" },
        "packages/api-gateway": { version: "0.1.3" },
      },
    });
    expect(internalEntry.version).toBe("0.1.3");
    expect(externalEntry.version).toBe("4.5.6");
  });
});
