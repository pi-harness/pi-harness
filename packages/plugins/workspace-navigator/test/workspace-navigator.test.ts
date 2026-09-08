import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { describe, expect, test } from "vitest";
import plugin, { listWorkspaceNodes } from "../src/index.js";

describe("workspace navigator", () => {
  test("uses the native current workspace and clears cached results on a new session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-navigator-session-"));
    const active = join(root, "active");
    await mkdir(active);
    await writeFile(join(active, "current.txt"), "current");
    const context = new Context(),
      tools = new PiToolRegistry(),
      panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    const session = { sessionId: "first", sessionManager: { getCwd: () => active } };
    context.provide("piRuntime", { session } as never);
    try {
      await context.plugin(plugin, {});
      const tree = tools.snapshot().customTools.find((tool) => tool.name === "workspace_tree")!;
      await expect(tree.execute("unknown", { legacy: true }, undefined, undefined, {} as never)).rejects.toThrow(/parameter/iu);
      const result = await tree.execute("tree", {}, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ nodes: [{ path: "current.txt" }] });
      const content = result.content[0];
      if (content?.type !== "text") throw new Error("Expected text");
      expect(JSON.parse(content.text)).toMatchObject({ truncated: false, nodes: [{ path: "current.txt" }] });
      session.sessionId = "second";
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { latest: null, git: null } }]);
      const caller = new AbortController();
      caller.abort();
      await expect(tree.execute("cancelled", {}, caller.signal, undefined, {} as never)).rejects.toThrow(/abort|cancel/iu);
      await expect(tree.execute("invalid", { maxNodes: NaN }, undefined, undefined, {} as never)).rejects.toThrow(/maxNodes/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds discovery even when every entry is a skipped symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-navigator-discovery-"));
    try {
      for (let batch = 0; batch < 42; batch += 1)
        await Promise.all(Array.from({ length: 100 }, (_, index) => symlink("missing", join(root, `link-${batch}-${index}`))));
      const result = await listWorkspaceNodes(root);
      expect(result).toMatchObject({ nodes: [], truncated: true, scannedEntries: 4096 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["tool", "panel"])("rolls back partial activation when a %s registration conflicts", async (conflict) => {
    const context = new Context(),
      tools = new PiToolRegistry(),
      panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: process.cwd(), agentDir: process.cwd(), args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    if (conflict === "tool")
      tools.register(
        defineTool({
          name: "workspace_status",
          label: "Existing",
          description: "Existing",
          parameters: Type.Object({}),
          execute() {
            return Promise.resolve({ content: [], details: {} });
          },
        }),
      );
    else panels.register({ id: "workspace-navigator-panel", pluginId: "existing", title: "Existing", read: () => ({}) });
    try {
      await expect(context.plugin(plugin, {})).rejects.toThrow(/already|duplicate|registered/iu);
      expect(tools.snapshot().customTools.map((tool) => tool.name)).toEqual(conflict === "tool" ? ["workspace_status"] : []);
    } finally {
      await context.fiber.dispose();
    }
  });

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
        truncated: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the nodes collected so far when a directory cannot be read", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() === 0) return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-navigator-"));
    await mkdir(join(root, "locked"));
    await writeFile(join(root, "zzz.txt"), "later\n", "utf8");
    await chmod(join(root, "locked"), 0o000);
    try {
      await expect(listWorkspaceNodes(root, { maxDepth: 3, maxNodes: 10 })).resolves.toMatchObject({
        nodes: [
          { kind: "directory", path: "locked", depth: 1 },
          { kind: "file", path: "zzz.txt", depth: 1 },
        ],
        truncated: true,
      });
    } finally {
      await chmod(join(root, "locked"), 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the nodes collected so far when an entry cannot be inspected", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() === 0) return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-navigator-"));
    await mkdir(join(root, "sealed"));
    await writeFile(join(root, "sealed", "child.txt"), "hidden\n", "utf8");
    await writeFile(join(root, "zzz.txt"), "later\n", "utf8");
    await chmod(join(root, "sealed"), 0o400);
    try {
      await expect(listWorkspaceNodes(root, { maxDepth: 3, maxNodes: 10 })).resolves.toMatchObject({
        nodes: [
          { kind: "directory", path: "sealed", depth: 1 },
          { kind: "file", path: "zzz.txt", depth: 1 },
        ],
        truncated: true,
      });
    } finally {
      await chmod(join(root, "sealed"), 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not mark an empty directory beyond the depth limit as truncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-navigator-"));
    await mkdir(join(root, "one"));
    try {
      await expect(listWorkspaceNodes(root, { maxDepth: 1 })).resolves.toMatchObject({ truncated: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
