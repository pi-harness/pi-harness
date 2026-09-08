import { chmod, mkdir, mkdtemp, readFile, stat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import obsidianSyncPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];
const roots: string[] = [];

async function fixture(relativeVault = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-obsidian-"));
  roots.push(root);
  const vault = join(root, "vault");
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(obsidianSyncPlugin, { vaultPath: relativeVault ? "vault" : vault });
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "obsidian_sync");
  if (tool === undefined) throw new Error("obsidian_sync was not registered");
  return { root, vault, context, tools, panels, tool };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Obsidian sync", () => {
  test("writes a confirmed Markdown note inside the configured vault", async () => {
    const { vault, tool, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    await expect(
      tool.execute("sync", { relativePath: "notes/today.md", content: "# Today", confirm: true }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      details: { relativePath: "notes/today.md", bytes: 7 },
    });
    await expect(readFile(join(vault, "notes/today.md"), "utf8")).resolves.toBe("# Today");
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { configured: true, last: { relativePath: "notes/today.md" } } }]);
  });

  test("replaces an existing note on a second call", async () => {
    const { vault, tool } = await fixture();
    await tool.execute("first", { relativePath: "notes/today.md", content: "# Original", confirm: true }, undefined, undefined, {} as never);
    await expect(
      tool.execute("second", { relativePath: "notes/today.md", content: "# Replaced", confirm: true }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ details: { relativePath: "notes/today.md" } });
    await expect(readFile(join(vault, "notes/today.md"), "utf8")).resolves.toBe("# Replaced");
  });

  test("keeps the permissions of a note it replaces and creates a new note owner-only", async () => {
    const { vault, tool } = await fixture();
    const path = join(vault, "notes/today.md");
    await tool.execute("first", { relativePath: "notes/today.md", content: "# Original", confirm: true }, undefined, undefined, {} as never);
    await expect(stat(path).then((info) => info.mode & 0o777)).resolves.toBe(0o600);
    await chmod(path, 0o644);

    await tool.execute("second", { relativePath: "notes/today.md", content: "# Replaced", confirm: true }, undefined, undefined, {} as never);

    await expect(readFile(path, "utf8")).resolves.toBe("# Replaced");
    await expect(stat(path).then((info) => info.mode & 0o777)).resolves.toBe(0o644);
  });

  test("rejects unconfirmed or escaping paths and cleans up", async () => {
    const { context, tools, panels, tool } = await fixture();
    await expect(tool.execute("no", { relativePath: "x.md", content: "x", confirm: false }, undefined, undefined, {} as never)).rejects.toThrow(
      /confirm=true/iu,
    );
    await expect(tool.execute("escape", { relativePath: "../x.md", content: "x", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
      /inside/iu,
    );
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
  test("rejects a linked parent before creating directories outside the vault", async () => {
    const { root, vault, tool } = await fixture();
    const outside = join(root, "outside");
    await mkdir(vault);
    await mkdir(outside);
    await symlink(outside, join(vault, "link"));
    await expect(
      tool.execute("escape", { relativePath: "link/created/note.md", content: "x", confirm: true }, undefined, undefined, {} as never),
    ).rejects.toThrow(/inside/iu);
    await expect(stat(join(outside, "created"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects absolute paths even when they point into the vault", async () => {
    const { vault, tool } = await fixture();
    await expect(
      tool.execute("absolute", { relativePath: join(vault, "note.md"), content: "x", confirm: true }, undefined, undefined, {} as never),
    ).rejects.toThrow(/relative/iu);
  });

  test("rejects cancelled and disposed writes and preserves the last report", async () => {
    const { vault, context, tool, panels } = await fixture();
    const params = { relativePath: "note.md", content: "original", confirm: true };
    const result = await tool.execute("first", params, undefined, undefined, {} as never);
    (result.details as { bytes: number }).bytes = 999;
    const snapshot = (await panels.snapshot())[0]!.data as { last: { bytes: number } };
    expect(snapshot.last.bytes).toBe(8);
    snapshot.last.bytes = 999;
    expect((await panels.snapshot())[0]!.data).toMatchObject({ last: { bytes: 8 } });
    const cancelled = new AbortController();
    cancelled.abort(new Error("caller cancelled"));
    await expect(tool.execute("cancel", { ...params, content: "changed" }, cancelled.signal, undefined, {} as never)).rejects.toThrow("caller cancelled");
    const pending = tool.execute("dispose", { ...params, content: "changed" }, undefined, undefined, {} as never);
    const rejected = expect(pending).rejects.toThrow(/disposed/iu);
    await context.fiber.dispose();
    await rejected;
    await expect(tool.execute("retained", params, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
    expect(await readFile(join(vault, "note.md"), "utf8")).toBe("original");
  });
  test("resolves a relative vault against the workspace and rejects a cancelled queued replacement", async () => {
    const { vault, tool } = await fixture(true);
    const params = { relativePath: "note.md", content: "first", confirm: true };
    const first = tool.execute("first", params, undefined, undefined, {} as never);
    const controller = new AbortController();
    const second = tool.execute("second", { ...params, content: "cancelled" }, controller.signal, undefined, {} as never);
    controller.abort(new Error("queued cancelled"));
    const rejection = expect(second).rejects.toThrow("queued cancelled");
    await first;
    await rejection;
    expect(await readFile(join(vault, "note.md"), "utf8")).toBe("first");
  });

  test("enforces the UTF-8 byte bound and rejects a symlink note without changing its target", async () => {
    const { vault, tool } = await fixture();
    const exact = "é".repeat(256 * 1024);
    await expect(tool.execute("exact", { relativePath: "note.md", content: exact, confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { bytes: 512 * 1024 },
    });
    await expect(tool.execute("oversize", { relativePath: "note.md", content: exact + "x", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
      /bytes/iu,
    );
    await symlink(join(vault, "note.md"), join(vault, "linked.md"));
    await expect(tool.execute("linked", { relativePath: "linked.md", content: "overwrite", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
      /regular file/iu,
    );
    expect(await readFile(join(vault, "note.md"), "utf8")).toBe(exact);
  });
});
