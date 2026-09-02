import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { inspectManifest, parseRequirements } from "../src/plugins/dependency-checker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("dependency checker", () => {
  test("parses Python requirements, detects conflicts, and checks a local virtualenv", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "requirements.txt"), "requests==2.31.0\nrequests>=2.32\nflask>=3.0\n# comment\n-r base.txt\n");
    await mkdir(join(root, ".venv/lib/python3.12/site-packages/requests"), { recursive: true });

    expect(parseRequirements("requests==2.31.0\nrequests>=2.32\n")).toEqual({
      names: ["requests"],
      constraints: [{ name: "requests", constraints: ["==2.31.0", ">=2.32"] }],
    });
    await expect(inspectManifest(root, "requirements.txt")).resolves.toMatchObject({
      ecosystem: "python",
      declared: 2,
      installed: 1,
      missing: ["flask"],
      invalid: [],
      conflicts: [{ name: "requests", constraints: ["==2.31.0", ">=2.32"] }],
    });
  });

  test("reports conflicting npm declarations while preserving installed checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dependency-checker-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.3.1" }, devDependencies: { react: "19.0.0", vite: "6.0.0" } }));
    await mkdir(join(root, "node_modules/react"), { recursive: true });
    await mkdir(join(root, "node_modules/vite"), { recursive: true });
    await expect(inspectManifest(root)).resolves.toMatchObject({
      ecosystem: "npm",
      declared: 2,
      installed: 2,
      missing: [],
      conflicts: [{ name: "react", constraints: ["18.3.1", "19.0.0"] }],
    });
  });
});
