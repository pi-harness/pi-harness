import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(import.meta.dirname, "../../../", path), "utf8")) as Record<string, unknown>;
}

test("core is independently installable instead of being bundled into the harness", async () => {
  const root = await readJson("package.json");
  const core = await readJson("packages/core/package.json");
  const dependencies = root.dependencies as Record<string, unknown>;
  const bundled = root.bundledDependencies as unknown[];

  expect(core.private).not.toBe(true);
  expect(dependencies["@pi-harness/core"]).toMatch(/^\^\d+\.\d+\.\d+$/u);
  expect(bundled).not.toContain("@pi-harness/core");
  expect(root.files).not.toContain("packages");
  expect(root.files).not.toContain("packages/core");
});
