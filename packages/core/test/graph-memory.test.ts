import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import graphMemoryPlugin from "../src/plugins/graph-memory.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

const temporaryDirectories: string[] = [];

async function waitForPath(path: string, description: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    if ((await lstat(path).catch(() => undefined)) !== undefined) return;
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFixture(config?: { fileName?: string; maxNodes?: number; maxRelations?: number }) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-graph-memory-workspace-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-graph-memory-agent-"));
  temporaryDirectories.push(cwd, agentDir);
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piHarnessLaunch", { cwd, agentDir, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(graphMemoryPlugin, config);
  return { context, cwd, agentDir, tools, panels };
}

describe("graph memory production boundaries", () => {
  test("falls back to finite default limits for non-finite configuration", async () => {
    const fixture = await createFixture({ maxNodes: Number.NaN, maxRelations: Number.POSITIVE_INFINITY });
    try {
      for (const tool of fixture.tools.snapshot().customTools) {
        expect(tool.executionMode).toBe("sequential");
        expect(tool.parameters).toMatchObject({ additionalProperties: false });
      }
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        { id: "graph-memory-panel", data: { limits: { nodes: 2_000, relations: 5_000, fileBytes: 4_194_304, searchResults: 50 } } },
      ]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("retries loading after a malformed graph file is repaired", async () => {
    const fixture = await createFixture();
    const graphPath = join(fixture.agentDir, "graph-memory.json");
    const search = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_search");
    if (search === undefined) throw new Error("graph_memory_search was not registered");
    await writeFile(graphPath, JSON.stringify({ version: 1, nodes: [{ id: "broken" }], relations: [] }), "utf8");
    try {
      await expect(search.execute("broken", { query: "fixed" }, undefined, undefined, {} as never)).rejects.toThrow(/invalid nodes/iu);
      const now = new Date().toISOString();
      await writeFile(
        graphPath,
        JSON.stringify({
          version: 1,
          nodes: [{ id: "node-1", kind: "event", label: "Fixed graph", summary: "The graph is valid again", createdAt: now, updatedAt: now }],
          relations: [],
        }),
        "utf8",
      );

      await expect(search.execute("fixed", { query: "fixed" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { total: 1, nodes: [{ id: "node-1" }] },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects accessor record parameters without invoking them", async () => {
    const fixture = await createFixture();
    const record = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_record");
    if (record === undefined) throw new Error("graph_memory_record was not registered");
    let accessed = false;
    const rawParams = { kind: "task", summary: "safe summary" } as { kind: "task"; label?: string; summary: string };
    Object.defineProperty(rawParams, "label", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("record accessor executed");
      },
    });
    try {
      await expect(record.execute("accessor", rawParams, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("strictly validates raw link, search, and forget parameters", async () => {
    const fixture = await createFixture();
    const tools = fixture.tools.snapshot().customTools;
    const link = tools.find((tool) => tool.name === "graph_memory_link");
    const search = tools.find((tool) => tool.name === "graph_memory_search");
    const forget = tools.find((tool) => tool.name === "graph_memory_forget");
    if (link === undefined || search === undefined || forget === undefined) throw new Error("Graph memory tools were not registered");
    let accessed = false;
    const linkParams = { to: "node-2", relation: "RELATED_TO" } as { from?: string; to: string; relation: "RELATED_TO" };
    Object.defineProperty(linkParams, "from", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("link accessor executed");
      },
    });
    try {
      await expect(link.execute("link", linkParams, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(search.execute("search", { query: "valid", limit: "2" }, undefined, undefined, {} as never)).rejects.toThrow(/limit.*number/iu);
      await expect(forget.execute("forget", { id: "node-1", confirm: "true" }, undefined, undefined, {} as never)).rejects.toThrow(/confirm.*boolean/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects NUL characters in persisted graph text", async () => {
    const fixture = await createFixture();
    const record = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_record");
    if (record === undefined) throw new Error("graph_memory_record was not registered");
    try {
      await expect(record.execute("nul", { kind: "task", label: "unsafe\0label", summary: "safe summary" }, undefined, undefined, {} as never)).rejects.toThrow(
        /label.*NUL/iu,
      );
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects non-portable graph file names before registration", async () => {
    const separatorError = await createFixture({ fileName: "nested\\graph.json" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(separatorError).toBeInstanceOf(Error);
    expect((separatorError as Error).message).toMatch(/single.*filename/iu);
    const nulError = await createFixture({ fileName: "unsafe\0.json" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(nulError).toBeInstanceOf(Error);
    expect((nulError as Error).message).toMatch(/fileName.*NUL/iu);
  });

  test("detaches tool and panel graph values from internal state", async () => {
    const fixture = await createFixture();
    const record = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_record");
    const search = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_search");
    if (record === undefined || search === undefined) throw new Error("Graph memory tools were not registered");
    try {
      const recorded = await record.execute(
        "record",
        { kind: "task", label: "Immutable node", summary: "Original graph summary" },
        undefined,
        undefined,
        {} as never,
      );
      (recorded.details as { label: string }).label = "Mutated through record details";

      const found = await search.execute("search", { query: "immutable" }, undefined, undefined, {} as never);

      expect(found.details).toMatchObject({ total: 1, nodes: [{ label: "Immutable node" }] });
      const foundNode = (found.details as { nodes: Array<{ label: string; summary: string }> }).nodes[0];
      if (foundNode === undefined) throw new Error("Expected one graph search result");
      foundNode.label = "Mutated through search details";
      foundNode.summary = "Mutated summary";
      const firstPanel = await fixture.panels.snapshot();
      const firstData = firstPanel[0]?.data as { recent: Array<{ label: string; summary: string }>; lastSearch: { nodes: Array<{ label: string }> } };
      expect(firstData.recent[0]).toMatchObject({ label: "Immutable node", summary: "Original graph summary" });
      expect(firstData.lastSearch.nodes[0]?.label).toBe("Immutable node");
      firstData.recent[0]!.label = "Mutated through panel";

      const secondPanel = await fixture.panels.snapshot();

      expect((secondPanel[0]?.data as { recent: Array<{ label: string }> }).recent[0]?.label).toBe("Immutable node");
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects a symbolic-link graph lock instead of polling its target", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), "pi-harness-graph-memory-lock-outside-"));
    temporaryDirectories.push(outside);
    await symlink(outside, join(fixture.agentDir, "graph-memory.json.lock"));
    const record = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_record");
    if (record === undefined) throw new Error("graph_memory_record was not registered");
    try {
      await expect(
        record.execute("locked", { kind: "event", label: "Lock test", summary: "Must not follow a lock symlink" }, undefined, undefined, {} as never),
      ).rejects.toThrow(/lock.*symbolic link/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  }, 12_000);

  test("reclaims a stale graph lock owned by a dead process after restart", async () => {
    const fixture = await createFixture();
    const lockPath = join(fixture.agentDir, "graph-memory.json.lock");
    const ownerPath = join(lockPath, "abandoned.owner");
    await mkdir(lockPath);
    await writeFile(ownerPath, JSON.stringify({ pid: 999_999_999, token: "abandoned" }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(ownerPath, old, old);
    await utimes(lockPath, old, old);
    const record = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_record");
    if (record === undefined) throw new Error("graph_memory_record was not registered");
    try {
      await expect(
        record.execute(
          "restart",
          { kind: "event", label: "Restart recovery", summary: "Recovers an abandoned lock from a dead process" },
          AbortSignal.timeout(1_000),
          undefined,
          {} as never,
        ),
      ).resolves.toMatchObject({ details: { label: "Restart recovery" } });
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not reclaim a stale graph lock owned by a live process", async () => {
    const fixture = await createFixture();
    const lockPath = join(fixture.agentDir, "graph-memory.json.lock");
    const ownerPath = join(lockPath, "live.owner");
    const owner = JSON.stringify({ pid: process.pid, token: "live" });
    await mkdir(lockPath);
    await writeFile(ownerPath, owner, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(ownerPath, old, old);
    await utimes(lockPath, old, old);
    const record = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_record");
    if (record === undefined) throw new Error("graph_memory_record was not registered");
    try {
      await expect(
        record.execute(
          "live-lock",
          { kind: "event", label: "Live lock", summary: "Must not steal a lock from a running process" },
          AbortSignal.timeout(200),
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/timeout/iu);
      await expect(readFile(ownerPath, "utf8")).resolves.toBe(owner);
    } finally {
      await rm(lockPath, { recursive: true, force: true });
      await fixture.context.fiber.dispose();
    }
  });

  test("does not recursively delete foreign lock contents during release", async () => {
    const fixture = await createFixture();
    const now = new Date().toISOString();
    const nodes = Array.from({ length: 700 }, (_, index) => ({
      id: `node-${index}`,
      kind: "event",
      label: `Existing node ${index}`,
      summary: `summary-${index}-` + "x".repeat(4_000),
      createdAt: now,
      updatedAt: now,
    }));
    await writeFile(join(fixture.agentDir, "graph-memory.json"), JSON.stringify({ version: 1, nodes, relations: [] }), "utf8");
    const record = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_record");
    if (record === undefined) throw new Error("graph_memory_record was not registered");
    const lockPath = join(fixture.agentDir, "graph-memory.json.lock");
    const foreignPath = join(lockPath, "foreign");
    try {
      const pending = record.execute(
        "foreign-lock",
        { kind: "event", label: "New node", summary: "Trigger a large graph rewrite" },
        undefined,
        undefined,
        {} as never,
      );
      await waitForPath(lockPath, "graph lock acquisition");
      await writeFile(foreignPath, "must survive", "utf8");
      const outcome = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/release.*lock|lock.*ownership/iu);
      await expect(readFile(foreignPath, "utf8")).resolves.toBe("must survive");
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels a mutation promptly while it is waiting for the file lock", async () => {
    const fixture = await createFixture();
    const record = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_record");
    if (record === undefined) throw new Error("graph_memory_record was not registered");
    const lockPath = join(fixture.agentDir, "graph-memory.json.lock");
    const rejectedPath = join(fixture.cwd, "mutation-rejected");
    await writeFile(join(fixture.agentDir, "placeholder"), "fixture", "utf8");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "existing.owner"), "fixture", "utf8");
    const controller = new AbortController();
    const pending = record.execute(
      "cancelled",
      { kind: "event", label: "Cancelled mutation", summary: "This write must never acquire the occupied lock" },
      controller.signal,
      undefined,
      {} as never,
    );
    let rejection: unknown;
    void pending.catch(async (error: unknown) => {
      rejection = error;
      await writeFile(rejectedPath, "rejected", "utf8");
    });
    try {
      controller.abort(new Error("graph mutation caller cancelled"));

      await waitForPath(rejectedPath, "graph mutation cancellation", 500);
      expect(rejection).toMatchObject({ message: "graph mutation caller cancelled" });
    } finally {
      await rm(lockPath, { recursive: true, force: true });
      await pending.catch(() => undefined);
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels a lock wait when the graph-memory plugin is disposed", async () => {
    const fixture = await createFixture();
    const record = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_record");
    if (record === undefined) throw new Error("graph_memory_record was not registered");
    const lockPath = join(fixture.agentDir, "graph-memory.json.lock");
    const rejectedPath = join(fixture.cwd, "dispose-rejected");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "existing.owner"), "fixture", "utf8");
    const pending = record.execute(
      "disposed",
      { kind: "event", label: "Disposed mutation", summary: "The lifecycle owns this wait" },
      undefined,
      undefined,
      {} as never,
    );
    let rejection: unknown;
    void pending.catch(async (error: unknown) => {
      rejection = error;
      await writeFile(rejectedPath, "rejected", "utf8");
    });
    let disposed = false;
    try {
      await fixture.context.fiber.dispose();
      disposed = true;

      await waitForPath(rejectedPath, "plugin lifecycle cancellation", 500);
      expect(rejection).toMatchObject({ message: "Graph memory plugin disposed" });
    } finally {
      await rm(lockPath, { recursive: true, force: true });
      await pending.catch(() => undefined);
      if (!disposed) await fixture.context.fiber.dispose();
    }
  });

  test("rejects an aborted queued mutation without waiting for the active writer", async () => {
    const fixture = await createFixture();
    const record = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_record");
    if (record === undefined) throw new Error("graph_memory_record was not registered");
    const lockPath = join(fixture.agentDir, "graph-memory.json.lock");
    const rejectedPath = join(fixture.cwd, "queued-rejected");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "existing.owner"), "fixture", "utf8");
    const first = record.execute(
      "active",
      { kind: "event", label: "Active writer", summary: "Waits on the occupied file lock" },
      undefined,
      undefined,
      {} as never,
    );
    void first.catch(() => undefined);
    const controller = new AbortController();
    const second = record.execute(
      "queued",
      { kind: "event", label: "Queued writer", summary: "Must be cancelled before the active writer completes" },
      controller.signal,
      undefined,
      {} as never,
    );
    let rejection: unknown;
    void second.catch(async (error: unknown) => {
      rejection = error;
      await writeFile(rejectedPath, "rejected", "utf8");
    });
    try {
      controller.abort(new Error("queued graph mutation cancelled"));

      await waitForPath(rejectedPath, "queued graph mutation cancellation", 500);
      expect(rejection).toMatchObject({ message: "queued graph mutation cancelled" });
    } finally {
      await rm(lockPath, { recursive: true, force: true });
      await Promise.all([first.catch(() => undefined), second.catch(() => undefined)]);
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects mutations that would make the graph file exceed its read limit", async () => {
    const fixture = await createFixture();
    const graphPath = join(fixture.agentDir, "graph-memory.json");
    const now = new Date().toISOString();
    const nodes: Array<Record<string, unknown>> = Array.from({ length: 240 }, (_, index) => ({
      id: `node-${index}`,
      kind: "event",
      label: `Existing node ${index}`,
      summary: "x".repeat(16 * 1024),
      createdAt: now,
      updatedAt: now,
    }));
    while (true) {
      const index = nodes.length;
      const candidate = {
        id: `node-${index}`,
        kind: "event",
        label: `Existing node ${index}`,
        summary: "x".repeat(16 * 1024),
        createdAt: now,
        updatedAt: now,
      };
      const nextPayload = JSON.stringify({ version: 1, nodes: [...nodes, candidate], relations: [] });
      if (Buffer.byteLength(nextPayload) > 4 * 1024 * 1024) break;
      nodes.push(candidate);
    }
    const original = JSON.stringify({ version: 1, nodes, relations: [] });
    await writeFile(graphPath, original, "utf8");
    const record = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_record");
    if (record === undefined) throw new Error("graph_memory_record was not registered");
    try {
      await expect(
        record.execute("oversized-write", { kind: "event", label: "One node too many", summary: "y".repeat(16 * 1024) }, undefined, undefined, {} as never),
      ).rejects.toThrow(/exceeds.*4194304-byte/iu);
      await expect(readFile(graphPath, "utf8")).resolves.toBe(original);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects unknown persisted node fields instead of carrying them forward", async () => {
    const fixture = await createFixture();
    const now = new Date().toISOString();
    await writeFile(
      join(fixture.agentDir, "graph-memory.json"),
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: "node-1",
            kind: "event",
            label: "Valid-looking node",
            summary: "The extra field must not be persisted",
            createdAt: now,
            updatedAt: now,
            secret: "unexpected",
          },
        ],
        relations: [],
      }),
      "utf8",
    );
    const search = fixture.tools.snapshot().customTools.find((tool) => tool.name === "graph_memory_search");
    if (search === undefined) throw new Error("graph_memory_search was not registered");
    try {
      await expect(search.execute("unknown-field", { query: "valid" }, undefined, undefined, {} as never)).rejects.toThrow(/invalid nodes/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("clears stale search results after a successful graph mutation", async () => {
    const fixture = await createFixture();
    const tools = fixture.tools.snapshot().customTools;
    const record = tools.find((tool) => tool.name === "graph_memory_record");
    const search = tools.find((tool) => tool.name === "graph_memory_search");
    const forget = tools.find((tool) => tool.name === "graph_memory_forget");
    if (record === undefined || search === undefined || forget === undefined) throw new Error("Graph memory tools were not registered");
    try {
      const created = await record.execute(
        "record",
        { kind: "task", label: "Disposable node", summary: "This node will be removed" },
        undefined,
        undefined,
        {} as never,
      );
      const id = (created.details as { id: string }).id;
      await search.execute("search", { query: "disposable" }, undefined, undefined, {} as never);
      await forget.execute("forget", { id, confirm: true }, undefined, undefined, {} as never);

      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ id: "graph-memory-panel", data: { nodes: 0, lastSearch: null } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });
});
