import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import undoSavepointPlugin, { type UndoSavepointPluginConfig } from "../src/plugins/undo-savepoint.js";
import { provideLaunchContext, PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];
const manifestCreatedAt = "2026-09-06T12:00:00.000Z";
const emptySha256 = createHash("sha256").update("").digest("hex");

interface FixtureOptions {
  config?: Partial<UndoSavepointPluginConfig>;
  prepare?: (root: string) => Promise<void>;
}

function manifestId(index = 0): string {
  return `20260906120000000-${index.toString(16).padStart(8, "0")}`;
}

function savepointFile(overrides: Partial<{ path: string; bytes: number; sha256: string; content: string }> = {}) {
  const content = Buffer.from("safe");
  return {
    path: "missing.txt",
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    content: content.toString("base64"),
    ...overrides,
  };
}

async function writeManifest(root: string, id: string, files: unknown[], reason = "test savepoint"): Promise<void> {
  const store = join(root, "savepoints");
  await mkdir(store, { recursive: true });
  await writeFile(join(store, `${id}.json`), JSON.stringify({ version: 1, id, reason, createdAt: manifestCreatedAt, files }), "utf8");
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-savepoint-"));
  await writeFile(join(root, "tracked.txt"), "before\n");
  await options.prepare?.(root);
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(undoSavepointPlugin, {
    trackedPaths: ["tracked.txt"],
    storeName: "savepoints",
    maxFiles: 10,
    maxFileBytes: 1024,
    ...options.config,
  });
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "undo_savepoint");
  if (tool === undefined) throw new Error("undo_savepoint was not registered");
  return { root, context, tools, panels, tool };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("undo savepoint", () => {
  test("saves, diffs, and restores a tracked file after confirmation", async () => {
    const { root, tool, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    const saved = await tool.execute("save", { action: "save", reason: "before risky edit" }, undefined, undefined, {} as never);
    const id = (saved.details as { id: string }).id;
    await writeFile(join(root, "tracked.txt"), "after\n");
    await expect(tool.execute("diff", { action: "diff", id }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { changed: ["tracked.txt"] },
    });
    await expect(tool.execute("restore-no", { action: "restore", id, confirm: false }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    await expect(tool.execute("restore", { action: "restore", id, confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { restored: ["tracked.txt"] },
    });
    await expect(readFile(join(root, "tracked.txt"), "utf8")).resolves.toBe("before\n");
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { count: 1 } }]);
  });

  test("cleans up registration on disposal", async () => {
    const { context, tools, panels } = await fixture();
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });

  test("excludes common credential files from a whole-workspace savepoint", async () => {
    const { root, tool } = await fixture({
      config: { trackedPaths: ["."] },
      async prepare(root) {
        await mkdir(join(root, "deploy"));
        await Promise.all([
          writeFile(join(root, ".env.development"), "DATABASE_URL=postgres://user:pass@localhost/db\n"),
          writeFile(join(root, ".env.test"), "SECRET=test\n"),
          writeFile(join(root, ".envrc"), "export TOKEN=abc\n"),
          writeFile(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_example\n"),
          writeFile(join(root, ".netrc"), "machine example.test login user password pass\n"),
          writeFile(join(root, "deploy", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n"),
          writeFile(join(root, "deploy", "id_rsa"), "-----BEGIN RSA PRIVATE KEY-----\n"),
          writeFile(join(root, "safe.txt"), "safe\n"),
        ]);
      },
    });

    const saved = await tool.execute("save", { action: "save" }, undefined, undefined, {} as never);
    expect(saved.details).toMatchObject({ fileCount: 2 });
    const id = (saved.details as { id: string }).id;
    const manifest = JSON.parse(await readFile(join(root, "savepoints", `${id}.json`), "utf8")) as { files: { path: string }[] };
    expect(manifest.files.map((file) => file.path)).toEqual(["safe.txt", "tracked.txt"]);
  });

  test("caps the total decoded content stored in one savepoint", async () => {
    const { tool } = await fixture({
      config: { trackedPaths: ["many"], maxFiles: 20, maxFileBytes: 2 * 1024 * 1024 },
      async prepare(root) {
        const directory = join(root, "many");
        await mkdir(directory);
        await Promise.all(Array.from({ length: 9 }, async (_, index) => writeFile(join(directory, `${index}.txt`), Buffer.alloc(2 * 1024 * 1024, 0x61))));
      },
    });

    await expect(tool.execute("save", { action: "save" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { fileCount: 4 } });
  });

  test("uses finite defaults for non-finite file count configuration", async () => {
    const { tool } = await fixture({
      config: { trackedPaths: ["many"], maxFiles: Number.NaN, maxFileBytes: 16 },
      async prepare(root) {
        const directory = join(root, "many");
        await mkdir(directory);
        await Promise.all(Array.from({ length: 401 }, async (_, index) => writeFile(join(directory, `${index.toString().padStart(3, "0")}.txt`), "x")));
      },
    });

    await expect(tool.execute("save", { action: "save" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { fileCount: 400 } });
  });

  test("uses finite defaults for non-finite per-file byte configuration", async () => {
    const { tool } = await fixture({
      config: { maxFileBytes: Number.NaN },
      async prepare(root) {
        await writeFile(join(root, "tracked.txt"), Buffer.alloc(256 * 1024 + 1, 0x61));
      },
    });

    await expect(tool.execute("save", { action: "save" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { fileCount: 0 } });
  });

  test("stops snapshot traversal at a conservative depth", async () => {
    const { tool } = await fixture({
      config: { trackedPaths: ["tree"] },
      async prepare(root) {
        let directory = join(root, "tree");
        await mkdir(directory);
        for (let depth = 0; depth < 40; depth += 1) {
          directory = join(directory, `depth-${depth}`);
          await mkdir(directory);
        }
        await writeFile(join(directory, "deep.txt"), "deep");
      },
    });

    await expect(tool.execute("save", { action: "save" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { fileCount: 0 } });
  });

  test("rejects a savepoint reason that would grow the manifest without bound", async () => {
    const { tool } = await fixture();

    await expect(tool.execute("save", { action: "save", reason: "x".repeat(4_097) }, undefined, undefined, {} as never)).rejects.toThrow(/reason.*4096/iu);
  });

  test("rejects an oversized manifest before parsing it", async () => {
    const { root, tool } = await fixture();
    const id = manifestId();
    await writeManifest(root, id, [], "x".repeat(24 * 1024 * 1024));

    await expect(tool.execute("diff", { action: "diff", id }, undefined, undefined, {} as never)).rejects.toThrow(/exceeds.*limit/iu);
  });

  test("does not follow a manifest symbolic link", async () => {
    const { root, tool } = await fixture();
    const id = manifestId();
    const target = join(root, "manifest-target.json");
    await writeFile(target, JSON.stringify({ version: 1, id, reason: "linked", createdAt: manifestCreatedAt, files: [] }), "utf8");
    await mkdir(join(root, "savepoints"), { recursive: true });
    await symlink(target, join(root, "savepoints", `${id}.json`));

    await expect(tool.execute("diff", { action: "diff", id }, undefined, undefined, {} as never)).rejects.toThrow(/symbolic link/iu);
  });

  test("rejects a manifest whose id does not match its filename", async () => {
    const { root, tool } = await fixture();
    const filenameId = manifestId();
    await writeManifest(root, filenameId, [], "test savepoint");
    const manifestPath = join(root, "savepoints", `${filenameId}.json`);
    const source = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    source.id = manifestId(1);
    await writeFile(manifestPath, JSON.stringify(source), "utf8");

    await expect(tool.execute("diff", { action: "diff", id: filenameId }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid savepoint/iu);
  });

  test("does not follow a workspace symlink while diffing a savepoint", async () => {
    const { root, tool } = await fixture();
    const saved = await tool.execute("save", { action: "save" }, undefined, undefined, {} as never);
    const id = (saved.details as { id: string }).id;
    const replacement = join(root, "replacement.txt");
    await writeFile(replacement, "replacement\n", "utf8");
    await rm(join(root, "tracked.txt"));
    await symlink(replacement, join(root, "tracked.txt"));

    await expect(tool.execute("diff", { action: "diff", id }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { missing: ["tracked.txt"], changed: [], unchanged: 0 },
    });
  });

  test("limits the number of manifests parsed for one list request", async () => {
    const { root, tool } = await fixture();
    await Promise.all(Array.from({ length: 101 }, async (_, index) => writeManifest(root, manifestId(index), [])));

    await expect(tool.execute("list", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { count: 100 } });
  });

  test.each([
    [
      "file count",
      () => Array.from({ length: 2_001 }, (_, index) => savepointFile({ path: `missing-${index}.txt`, bytes: 0, sha256: emptySha256, content: "" })),
    ],
    ["per-file byte size", () => [savepointFile({ bytes: 2 * 1024 * 1024 + 1, sha256: emptySha256, content: "" })]],
    ["base64 encoding", () => [savepointFile({ bytes: 0, sha256: emptySha256, content: "%%%%" })]],
    ["decoded content length", () => [savepointFile({ bytes: 5 })]],
    ["content hash", () => [savepointFile({ sha256: "0".repeat(64) })]],
    ["relative path", () => [savepointFile({ path: "../outside.txt" })]],
    ["sensitive path", () => [savepointFile({ path: ".npmrc" })]],
    ["sensitive nested key path", () => [savepointFile({ path: "deploy/id_ed25519" })]],
  ])("rejects a manifest with an invalid %s", async (_label, files) => {
    const { root, tool } = await fixture();
    const id = manifestId();
    await writeManifest(root, id, files());

    await expect(tool.execute("diff", { action: "diff", id }, undefined, undefined, {} as never)).rejects.toThrow(/Invalid savepoint/iu);
  });
});
