import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { win32 } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import workspaceSearchPlugin, { isWorkspaceSearchPathInside } from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-search-"));
  await writeFile(join(root, "one.txt"), "Hello World\nsecond line\n");
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(workspaceSearchPlugin);
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "workspace_search");
  if (tool === undefined) throw new Error("workspace_search was not registered");
  return { root, context, tools, panels, tool };
}

function signalAbortingOnCheck(index: number): AbortSignal {
  const reason = new Error("workspace search aborted");
  let checks = 0;
  return {
    reason,
    get aborted() {
      checks += 1;
      return checks >= index;
    },
  } as unknown as AbortSignal;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("workspace search", () => {
  test("rejects Windows paths outside the workspace using native path semantics", () => {
    expect(isWorkspaceSearchPathInside("C:\\repo", "C:\\outside", win32)).toBe(false);
    expect(isWorkspaceSearchPathInside("C:\\repo", "C:\\repo\\src", win32)).toBe(true);
  });

  test("finds bounded UTF-8 matches and reports panel state", async () => {
    const { tool, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    await expect(tool.execute("search", { query: "hello", caseSensitive: false }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { query: "hello", matchCount: 1, matches: [{ path: "one.txt", line: 1 }] },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { matchCount: 1, query: "hello" } }]);
  });

  test("rejects traversal and cleans up registration", async () => {
    const { context, tool, tools, panels } = await fixture();
    await expect(tool.execute("escape", { query: "x", path: "../outside" }, undefined, undefined, {} as never)).rejects.toThrow(/inside/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });

  test("rejects paths that escape through a symlinked directory inside the workspace", async () => {
    const { root, tool } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "pi-harness-search-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "needle outside\n");
      await mkdir(join(outside, "sub"));
      await writeFile(join(outside, "sub", "config.txt"), "needle nested\n");
      await symlink(outside, join(root, "linked"));
      await expect(tool.execute("file", { query: "needle", path: "linked/secret.txt" }, undefined, undefined, {} as never)).rejects.toThrow(/inside/iu);
      await expect(tool.execute("directory", { query: "needle", path: "linked/sub" }, undefined, undefined, {} as never)).rejects.toThrow(/inside/iu);
      await expect(tool.execute("root", { query: "needle" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { matchCount: 0 } });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("counts a single oversize target file once", async () => {
    const { root, tool } = await fixture();
    await writeFile(join(root, "big.log"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    await expect(tool.execute("oversize", { query: "needle", path: "big.log" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { matchCount: 0, scannedFiles: 0, skippedFiles: 1 },
    });
  });

  test("skips invalid UTF-8 files instead of searching replacement characters", async () => {
    const { root, tool } = await fixture();
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
    await expect(tool.execute("invalid", { query: "needle" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { matchCount: 0, scannedFiles: 1, skippedFiles: 1 },
    });
  });

  test("reports truncation when the file inventory reaches its scan limit", async () => {
    const { root, tool } = await fixture();
    await Promise.all(Array.from({ length: 2_001 }, (_, index) => writeFile(join(root, `file-${String(index).padStart(4, "0")}.txt`), "content\n")));
    await expect(tool.execute("limit", { query: "not-present" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { matchCount: 0, scannedFiles: 2_000, truncated: true },
    });
  }, 15_000);

  test("clips an oversize matched line before it reaches the agent content", async () => {
    const { root, tool } = await fixture();
    await writeFile(join(root, "bundle.min.js"), `needle${"a".repeat(200_000)}\n`);
    const result = (await tool.execute("clip", { query: "needle" }, undefined, undefined, {} as never)) as {
      content: { text: string }[];
      details: { matches: { text: string }[]; truncated: boolean };
    };
    expect(result.details.matches[0]?.text).toHaveLength(501);
    expect(result.details.matches[0]?.text.endsWith("…")).toBe(true);
    expect(result.details.truncated).toBe(true);
    expect(result.content[0]?.text.length).toBeLessThan(1_000);
  });

  test("stops the directory walk when the caller aborts after the scan started", async () => {
    const { root, tool } = await fixture();
    await mkdir(join(root, "empty"));
    const controller = new AbortController();
    // search() runs its pre-flight abort check synchronously, so execute() has already returned a promise parked on the workspace path resolution by the time abort() lands here. Targeting an empty directory leaves the walk with no file to scan afterwards, which makes the check inside filesUnder the only one that can observe this abort.
    const pending = tool.execute("walk", { query: "hello", path: "empty" }, controller.signal, undefined, {} as never);
    controller.abort(new Error("workspace search aborted"));
    await expect(pending).rejects.toThrow(/workspace search aborted/iu);
  });

  test("stops the file scan when the abort lands after the directory walk", async () => {
    const { tool } = await fixture();
    // throwIfAborted only reads `aborted` and `reason`, so counting those reads places the abort on a chosen check deterministically. Scanning a single file checks in this order: the pre-flight check in search(), the check in filesUnder(), then the check guarding the file in the scan loop.
    await expect(tool.execute("scan", { query: "hello", path: "one.txt" }, signalAbortingOnCheck(3), undefined, {} as never)).rejects.toThrow(
      /workspace search aborted/iu,
    );
  });

  test("rejects unknown plugin configuration before activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-search-config-"));
    const context = new Context();
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", new PiPluginUiRegistry());
    let error: unknown;
    try {
      await context.plugin(workspaceSearchPlugin, { unexpected: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/unknown config keys/iu);
    await context.fiber.dispose();
  });
});
