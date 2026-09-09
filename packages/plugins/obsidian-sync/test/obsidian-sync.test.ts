import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile, stat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import obsidianSyncPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

import type * as FsPromises from "node:fs/promises";

// Pause after a real staging fsync so a session change can be observed before atomic publication.
const writeHooks = vi.hoisted(() => ({ afterSync: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    if (typeof args[0] === "string" && args[0].endsWith(".tmp")) {
      const sync = handle.sync.bind(handle);
      Object.defineProperty(handle, "sync", {
        value: async () => {
          await sync();
          await writeHooks.afterSync?.();
        },
      });
    }
    return handle;
  };
  return { ...actual, open };
});

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

test.each([true, false])("binds queued notes and reports to the current native session, relative vault=%s", async (relativeVault) => {
  const { root, vault, context, panels, tool } = await fixture(relativeVault);
  const active = join(root, "active");
  let id = "first";
  let session = { sessionId: id, sessionManager: { getCwd: () => root } };
  context.provide("piRuntime", {
    get session() {
      return session;
    },
  } as never);
  const params = { relativePath: "note.md", content: "first", confirm: true };
  await tool.execute("first", params, undefined, undefined, {} as never);
  session = {
    get sessionId() {
      return id;
    },
    sessionManager: { getCwd: () => active },
  };
  await expect(panels.snapshot()).resolves.toMatchObject([{ data: { last: null } }]);
  await tool.execute("active", { ...params, content: "active" }, undefined, undefined, {} as never);
  expect(await readFile(join(relativeVault ? join(active, "vault") : vault, "note.md"), "utf8")).toBe("active");
  if (relativeVault) expect(await readFile(join(vault, "note.md"), "utf8")).toBe("first");
  const pending = tool.execute("pending", { ...params, relativePath: "stale.md" }, undefined, undefined, {} as never);
  id = "second";
  await expect(pending).rejects.toThrow(/workspace changed/iu);
  await expect(readFile(join(relativeVault ? join(active, "vault") : vault, "stale.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(panels.snapshot()).resolves.toMatchObject([{ data: { last: null } }]);
  await expect(
    tool.execute(
      "getter",
      {
        get relativePath() {
          id = "third";
          return "getter.md";
        },
        content: "x",
        confirm: true,
      },
      undefined,
      undefined,
      {} as never,
    ),
  ).rejects.toThrow(/workspace changed/iu);
});

test.each([false, true])("does not publish a staged note after native session replacement, existing=%s", async (existing) => {
  const { root, vault, context, tool, panels } = await fixture();
  await mkdir(vault);
  if (existing) await writeFile(join(vault, "note.md"), "original");
  let id = "first";
  context.provide("piRuntime", {
    session: {
      get sessionId() {
        return id;
      },
      sessionManager: { getCwd: () => root },
    },
  } as never);
  let reached!: () => void, release!: () => void;
  const staged = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeHooks.afterSync = async () => {
    reached();
    await held;
  };
  try {
    const result = tool.execute("staged", { relativePath: "note.md", content: "new", confirm: true }, undefined, undefined, {} as never).then(
      () => "unexpected success",
      (error: unknown) => String(error),
    );
    await staged;
    id = "replacement";
    release();
    expect(await result).toMatch(/workspace changed/iu);
    if (existing) expect(await readFile(join(vault, "note.md"), "utf8")).toBe("original");
    else await expect(readFile(join(vault, "note.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(vault)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { last: null } }]);
  } finally {
    writeHooks.afterSync = undefined;
    release();
  }
});
