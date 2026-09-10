import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { expect, test, vi } from "vitest";
import plugin from "../src/index.js";

const boundary = vi.hoisted(() => ({ afterSync: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      if (args[1] === "wx") {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          boundary.afterSync?.();
        };
      }
      return handle;
    },
  };
});

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-export-boundary-"));
  const context = new Context();
  provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  const manager = SessionManager.inMemory(cwd);
  manager.appendMessage({ role: "user", content: "Owned baseline", timestamp: Date.now() });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  context.provide("piRuntime", {
    session: {
      sessionManager: manager,
      get messages() {
        return manager.buildSessionContext().messages;
      },
    },
  } as never);
  await context.plugin(plugin);
  const tool = tools.snapshot().customTools.find((item) => item.name === "session_export")!;
  return {
    cwd,
    manager,
    panels,
    call: (path: string, confirm = false, signal?: AbortSignal) => tool.execute("boundary", { path, confirm }, signal, undefined, {} as never),
    async close() {
      boundary.afterSync = undefined;
      await context.fiber.dispose();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test.each([false, true])("cancellation after durable staging preserves destination and permits recovery, overwrite=%s", async (overwrite) => {
  const h = await harness();
  try {
    const target = join(h.cwd, "session.md");
    if (overwrite) await writeFile(target, "Owned original bytes");
    const abort = new AbortController();
    let staged = false;
    boundary.afterSync = () => {
      staged = true;
      abort.abort(new Error("Controlled staging cancellation"));
    };
    await expect(h.call("session.md", overwrite, abort.signal)).rejects.toThrow(/cancellation/);
    expect(staged).toBe(true);
    if (overwrite) expect(await readFile(target, "utf8")).toBe("Owned original bytes");
    else await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(h.cwd)).toEqual(overwrite ? ["session.md"] : []);
    expect((await h.panels.snapshot())[0]!.data).toMatchObject({ latest: null });
    boundary.afterSync = undefined;
    await expect(h.call("session.md", overwrite)).resolves.toMatchObject({ details: { path: "session.md" } });
    expect(await readFile(target, "utf8")).toContain("Owned baseline");
    expect(await readdir(h.cwd)).toEqual(["session.md"]);
  } finally {
    await h.close();
  }
});

test("oversized native session leaves both old output and uncreated directories intact, then recovers", async () => {
  const h = await harness();
  try {
    await h.call("session.md");
    const bytes = await readFile(join(h.cwd, "session.md"));
    const receipt = (await h.panels.snapshot())[0]!.data;
    const baseline = h.manager.getLeafId()!;
    h.manager.appendMessage({ role: "user", content: "界".repeat(400000), timestamp: Date.now() });
    await expect(h.call("session.md", true)).rejects.toThrow(/1 MiB/);
    await expect(h.call("not-created/output.md")).rejects.toThrow(/1 MiB/);
    expect(await readFile(join(h.cwd, "session.md"))).toEqual(bytes);
    expect(await readdir(h.cwd)).toEqual(["session.md"]);
    expect((await h.panels.snapshot())[0]!.data).toEqual(receipt);
    h.manager.branch(baseline);
    await expect(h.call("recovered.md")).resolves.toMatchObject({ details: { path: "recovered.md" } });
    expect(await readFile(join(h.cwd, "recovered.md"))).toEqual(bytes);
  } finally {
    await h.close();
  }
});
