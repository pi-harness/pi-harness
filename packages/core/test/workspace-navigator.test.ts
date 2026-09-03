import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { listWorkspaceNodes } from "../src/plugins/workspace-navigator.js";

describe("workspace navigator", () => {
  test("lists a bounded tree while skipping dependency and build directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-navigator-"));
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "README.md"), "# app\n", "utf8");
    await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "src", "nested", "deep.ts"), "export const deep = true;\n", "utf8");
    await writeFile(join(root, "node_modules", "dep", "index.js"), "export const hidden = true;\n", "utf8");
    try {
      await expect(listWorkspaceNodes(root, { maxDepth: 2, maxNodes: 10 })).resolves.toMatchObject({
        nodes: [
          { kind: "file", path: "README.md", depth: 1 },
          { kind: "directory", path: "src", depth: 1 },
          { kind: "file", path: "src/index.ts", depth: 2 },
          { kind: "directory", path: "src/nested", depth: 2 },
        ],
        directoryCount: 2,
        fileCount: 2,
        truncated: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
