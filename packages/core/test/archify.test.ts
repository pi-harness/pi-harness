import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildArchitectureReport } from "../src/plugins/archify.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("archify", () => {
  test("maps top-level workspace components and package dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "src", "api", "server.ts"), "export {}", "utf8");
    await writeFile(join(root, "tests", "server.test.ts"), "export {}", "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { zod: "^4.0.0" }, devDependencies: { vitest: "^4.0.0" } }), "utf8");

    const report = await buildArchitectureReport(root);

    expect(report.components).toEqual([
      { id: "component_src", label: "src", path: "src", files: 1, directories: 1 },
      { id: "component_tests", label: "tests", path: "tests", files: 1, directories: 0 },
    ]);
    expect(report.dependencies).toEqual(["vitest", "zod"]);
    expect(report.mermaid).toContain("project --> component_src");
    expect(report.mermaid).toContain('dependency_zod["zod"]');
  });
});
