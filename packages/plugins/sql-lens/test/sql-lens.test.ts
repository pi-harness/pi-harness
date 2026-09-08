import type * as ChildProcess from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import sqlLensPlugin, { Config } from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

// Only the plugin holds a reference to the process it spawns, so recording the real children is the only way to assert that an abandoned query is gone from the operating system.
const spawnedChildren = vi.hoisted(() => [] as ChildProcess.ChildProcess[]);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawnedChildren.push(child);
      return child;
    },
  };
});

function isRunning(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFixture(config?: { timeoutMs?: number }) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-sql-lens-workspace-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-sql-lens-agent-"));
  temporaryDirectories.push(cwd, agentDir);
  const databasePath = join(cwd, "data.db");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, content TEXT, payload BLOB); INSERT INTO users(id, name) VALUES (1, 'Ada');");
  database.close();
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piHarnessLaunch", { cwd, agentDir, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(sqlLensPlugin, config);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "sql_readonly");
  if (tool === undefined) throw new Error("sql_readonly was not registered");
  return { context, cwd, databasePath, panels, tool };
}

describe("SQL Lens production boundaries", () => {
  test("exports strict config and a sequential strict-schema tool", async () => {
    expect(Config).toBeDefined();
    const fixture = await createFixture();
    try {
      expect(fixture.tool).toMatchObject({
        executionMode: "sequential",
        parameters: {
          additionalProperties: false,
          properties: {
            database: { type: "string" },
            query: { type: "string" },
          },
        },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects hostile config and rolls back registration when the panel conflicts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-sql-lens-config-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-sql-lens-agent-"));
    temporaryDirectories.push(cwd, agentDir);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    panels.register({ id: "sql-lens-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });
    try {
      await expect(context.plugin(sqlLensPlugin, { unexpected: true } as never)).rejects.toThrow(/unknown.*config|unexpected/iu);
      expect(tools.snapshot().customTools).toEqual([]);
      await expect(context.plugin(sqlLensPlugin)).rejects.toThrow(/already registered.*sql-lens-panel/iu);
      expect(tools.snapshot().customTools).toEqual([]);
    } finally {
      await context.fiber.dispose();
    }
  });
  test("allows comments, comparisons, and mutation words inside string literals", async () => {
    const fixture = await createFixture();
    const query = "-- update is data, not syntax\nSELECT id, 'delete; x = y' AS note FROM users WHERE id = 1; -- trailing comment";
    try {
      await expect(fixture.tool.execute("legal", { database: "data.db", query }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { columns: ["id", "note"], rows: [{ id: 1, note: "delete; x = y" }], truncated: false, scannedRows: 1 },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects additional SQL statements and non-result mutations", async () => {
    const fixture = await createFixture();
    try {
      await expect(fixture.tool.execute("multiple", { database: "data.db", query: "SELECT 1; SELECT 2" }, undefined, undefined, {} as never)).rejects.toThrow(
        /single.*statement|multiple.*statement/iu,
      );
      await expect(
        fixture.tool.execute(
          "cte-delete",
          { database: "data.db", query: "WITH doomed AS (SELECT id FROM users) DELETE FROM users WHERE id IN (SELECT id FROM doomed)" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/read-only|result.*query|denied/iu);
      const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
      expect(database.prepare("SELECT COUNT(*) AS total FROM users").get()).toMatchObject({ total: 1 });
      database.close();
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("strictly validates raw parameters without invoking accessors", async () => {
    const fixture = await createFixture();
    let accessed = false;
    const accessor = { database: "data.db" } as { database: string; query?: string };
    Object.defineProperty(accessor, "query", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("SQL accessor executed");
      },
    });
    try {
      await expect(fixture.tool.execute("accessor", accessor, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(fixture.tool.execute("unknown", { database: "data.db", extra: true }, undefined, undefined, {} as never)).rejects.toThrow(
        /unknown property/iu,
      );
      await expect(fixture.tool.execute("null", { database: null }, undefined, undefined, {} as never)).rejects.toThrow(/database.*string/iu);
      await expect(fixture.tool.execute("nul", { query: "SELECT 1\0" }, undefined, undefined, {} as never)).rejects.toThrow(/query.*NUL/iu);
      const inherited = Object.create({ database: "data.db" }) as Record<string, unknown>;
      await expect(fixture.tool.execute("inherited", inherited, undefined, undefined, {} as never)).rejects.toThrow(/plain object/iu);
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      await expect(fixture.tool.execute("revoked", revoked.proxy, undefined, undefined, {} as never)).rejects.toThrow(/accessible plain object/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("bounds rows and large cell values before returning them", async () => {
    const fixture = await createFixture();
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("UPDATE users SET content = ?, payload = ? WHERE id = 1").run("x".repeat(20_000), Buffer.alloc(70_000, 0xab));
    database.close();
    try {
      const large = await fixture.tool.execute(
        "large",
        { database: "data.db", query: "SELECT content, payload FROM users" },
        undefined,
        undefined,
        {} as never,
      );
      const row = (large.details as { rows: Array<{ content: string; payload: unknown }> }).rows[0];
      expect(row?.content).toBe("x".repeat(16_384) + "…");
      expect(row?.payload).toMatchObject({ type: "blob", bytes: 70_000, truncated: true });

      const many = await fixture.tool.execute(
        "many",
        {
          database: "data.db",
          query: "WITH RECURSIVE count(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM count WHERE x < 1000) SELECT x FROM count",
        },
        undefined,
        undefined,
        {} as never,
      );
      expect((many.details as { rows: unknown[] }).rows).toHaveLength(100);
      expect(many.details).toMatchObject({ truncated: true, scannedRows: 101 });

      // A result near the byte limit arrives in several pipe chunks, so this also proves the query process flushes its whole response before exiting.
      const bulk = await fixture.tool.execute(
        "bulk",
        {
          database: "data.db",
          query: "WITH RECURSIVE count(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM count WHERE x < 200) SELECT x, printf('%.9000c', 'y') AS wide FROM count",
        },
        undefined,
        undefined,
        {} as never,
      );
      const bulkRows = (bulk.details as { rows: Array<{ x: number; wide: string }> }).rows;
      expect(bulkRows).toHaveLength(100);
      expect(bulkRows.at(-1)?.wide).toHaveLength(9_000);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("honors caller and plugin lifecycle cancellation", async () => {
    const callerFixture = await createFixture();
    const controller = new AbortController();
    controller.abort(new Error("SQL caller cancelled"));
    try {
      await expect(callerFixture.tool.execute("caller", {}, controller.signal, undefined, {} as never)).rejects.toThrow("SQL caller cancelled");
    } finally {
      await callerFixture.context.fiber.dispose();
    }

    const lifecycleFixture = await createFixture();
    await lifecycleFixture.context.fiber.dispose();
    await expect(lifecycleFixture.tool.execute("disposed", {}, undefined, undefined, {} as never)).rejects.toThrow("SQL Lens plugin disposed");
  });

  test("publishes detached bounded panel state and operational limits", async () => {
    const fixture = await createFixture({ timeoutMs: 1_500 });
    try {
      const result = await fixture.tool.execute("panel", { database: "data.db", query: "SELECT id, name FROM users" }, undefined, undefined, {} as never);
      (result.details as { rows: Array<{ name: string }> }).rows[0]!.name = "mutated through tool";
      const first = await fixture.panels.snapshot();
      expect(first).toMatchObject([
        {
          id: "sql-lens-panel",
          data: {
            status: { state: "completed" },
            latest: { database: "data.db", columns: ["id", "name"], rows: [{ id: 1, name: "Ada" }], scannedRows: 1 },
            limits: { queryLength: 65_536, databaseBytes: 268_435_456, rows: 100, columns: 128, stringLength: 16_384, resultBytes: 1_048_576 },
            timeoutMs: 1_500,
          },
        },
      ]);
      const firstData = first[0]?.data as { latest: { rows: Array<{ name: string }> } };
      firstData.latest.rows[0]!.name = "mutated through panel";
      const second = await fixture.panels.snapshot();
      expect((second[0]?.data as { latest: { rows: Array<{ name: string }> } }).latest.rows[0]?.name).toBe("Ada");
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("kills the query process when the configured timeout expires so an expensive aggregate stops burning CPU", async () => {
    const fixture = await createFixture({ timeoutMs: 100 });
    const query = "WITH RECURSIVE count(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM count WHERE x < 100000000) SELECT sum(x) AS total FROM count";
    const alreadySpawned = spawnedChildren.length;
    const startedAt = Date.now();
    try {
      await expect(fixture.tool.execute("timeout", { database: "data.db", query }, undefined, undefined, {} as never)).rejects.toThrow(
        /timed out after 100ms/iu,
      );
      // The aggregate needs more than ten seconds of CPU, so the rejection may only arrive once the operating system has actually reaped the query process.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      const children = spawnedChildren.slice(alreadySpawned);
      expect(children).toHaveLength(1);
      expect(children[0]?.signalCode).toBe("SIGKILL");
      expect(isRunning(children[0]?.pid)).toBe(false);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        { data: { status: { state: "failed", error: "SQL Lens query timed out after 100ms" }, timeoutMs: 100 } },
      ]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("stops a cancelled query process instead of leaving it pinned inside SQLite", async () => {
    const fixture = await createFixture({ timeoutMs: 30_000 });
    const query = "WITH RECURSIVE count(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM count WHERE x < 100000000) SELECT sum(x) AS total FROM count";
    const alreadySpawned = spawnedChildren.length;
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("SQL caller cancelled the aggregate")), 100);
    const startedAt = Date.now();
    try {
      await expect(fixture.tool.execute("cancel", { database: "data.db", query }, controller.signal, undefined, {} as never)).rejects.toThrow(
        /cancelled the aggregate/iu,
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      const children = spawnedChildren.slice(alreadySpawned);
      expect(children).toHaveLength(1);
      expect(isRunning(children[0]?.pid)).toBe(false);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects symbolic-link SQLite sidecar files", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const outside = join(fixture.cwd, "outside-wal");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, fixture.databasePath + "-wal");
    try {
      await expect(fixture.tool.execute("sidecar", { database: "data.db", query: "SELECT id FROM users" }, undefined, undefined, {} as never)).rejects.toThrow(
        /sidecar.*symbolic link/iu,
      );
    } finally {
      await fixture.context.fiber.dispose();
    }
  });
});

test("queries the active workspace, returns model-visible rows and rejects a session switch", async () => {
  const fixture = await createFixture();
  const activeCwd = await mkdtemp(join(tmpdir(), "pi-sql-active-"));
  temporaryDirectories.push(activeCwd);
  const database = new DatabaseSync(join(activeCwd, "data.db"));
  database.exec("CREATE TABLE active(value TEXT); INSERT INTO active VALUES ('当前工作区');");
  database.close();
  const manager = SessionManager.inMemory(activeCwd);
  const session = {
    sessionManager: manager,
    get sessionId() {
      return manager.getSessionId();
    },
  };
  fixture.context.provide("piRuntime", { session } as never);
  try {
    const result = await fixture.tool.execute("active", { query: "SELECT value FROM active" }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ cwd: activeCwd, rows: [{ value: "当前工作区" }] });
    expect(JSON.stringify(result.content)).toContain("当前工作区");
    const pending = fixture.tool.execute("switch", { query: "SELECT value FROM active" }, undefined, undefined, {} as never);
    manager.newSession();
    await expect(pending).rejects.toThrow(/context changed/);
  } finally {
    await fixture.context.fiber.dispose();
  }
});

test("preserves Unicode scalar boundaries when truncating real SQLite text", async () => {
  const fixture = await createFixture();
  try {
    const text = "x".repeat(16383) + "😀".repeat(10);
    const result = await fixture.tool.execute("unicode", { query: `SELECT '${text}' AS note` }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ rows: [{ note: "x".repeat(16383) + "…" }], truncated: true });
  } finally {
    await fixture.context.fiber.dispose();
  }
});
