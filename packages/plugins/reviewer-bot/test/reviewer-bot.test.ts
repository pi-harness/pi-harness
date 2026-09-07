import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import reviewerBotPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const execFileAsync = promisify(execFile);
const contexts: Context[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-reviewer-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd: root });
  await writeFile(join(root, "file.txt"), "base\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(reviewerBotPlugin, { maxDiffBytes: 64 * 1024, timeoutMs: 5_000 });
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "review_changes");
  if (tool === undefined) throw new Error("review_changes was not registered");
  return { root, context, tools, panels, tool };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("reviewer bot", () => {
  test("reviews a clean diff and reports changed files", async () => {
    const { root, tool, panels } = await fixture();
    await writeFile(join(root, "file.txt"), "changed\n");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    await expect(tool.execute("review", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { status: "pass", changedFiles: 1 } });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { latest: { status: "pass" } } }]);
  });

  test("attributes a deleted file's removed lines to that file", async () => {
    const { root, tool } = await fixture();
    await writeFile(join(root, "other.txt"), "x\ny\nz\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "add other"], { cwd: root });
    await writeFile(join(root, "file.txt"), "changed\n");
    await execFileAsync("git", ["rm", "-q", "other.txt"], { cwd: root });
    await expect(tool.execute("review", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: {
        files: [
          { path: "file.txt", added: 1, removed: 1 },
          { path: "other.txt", added: 0, removed: 3 },
        ],
        changedFiles: 2,
        addedLines: 1,
        removedLines: 4,
      },
    });
  });

  test("attributes removed lines when the deleted file comes first in the diff", async () => {
    const { root, tool } = await fixture();
    await writeFile(join(root, "a-first.txt"), "x\ny\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "add first"], { cwd: root });
    await writeFile(join(root, "file.txt"), "changed\n");
    await execFileAsync("git", ["rm", "-q", "a-first.txt"], { cwd: root });
    await expect(tool.execute("review", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: {
        files: [
          { path: "a-first.txt", added: 0, removed: 2 },
          { path: "file.txt", added: 1, removed: 1 },
        ],
        removedLines: 3,
      },
    });
  });

  test("attributes lines and findings to non-ASCII and spaced paths", async () => {
    const { root, tool } = await fixture();
    await writeFile(join(root, "file.txt"), "changed\n");
    await writeFile(join(root, "文件.txt"), 'alpha\napi_key: "AKIA1234567890ABC"\nTODO: finish\n');
    await writeFile(join(root, "my file.txt"), "spaced\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await expect(tool.execute("review", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: {
        files: [
          { path: "file.txt", added: 1, removed: 1 },
          { path: "my file.txt", added: 1, removed: 0 },
          { path: "文件.txt", added: 3, removed: 0 },
        ],
        findings: [
          { kind: "secret", path: "文件.txt" },
          { kind: "todo", path: "文件.txt" },
        ],
        changedFiles: 3,
        addedLines: 5,
        removedLines: 1,
      },
    });
  });

  test("attributes lines and findings to paths git C-quotes", async () => {
    const { root, tool } = await fixture();
    // core.quotepath=false only stops non-ASCII from being escaped; a quote, a backslash, a tab or any other control byte still makes git wrap the whole `b/<path>` in a C-quoted string in the diff header and in --name-only. U+0001 additionally has no single-letter escape, so it arrives as a three-digit octal one.
    await writeFile(join(root, 'we"ird.txt'), 'alpha\napi_key: "AKIA1234567890ABC"\n');
    await writeFile(join(root, "back\\slash.txt"), "one\ntwo\n");
    await writeFile(join(root, "tab\there \u0001ctl.txt"), "TODO: finish\n");
    await writeFile(join(root, "file.txt"), "changed\n");
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await expect(tool.execute("review", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: {
        files: [
          { path: "back\\slash.txt", added: 2, removed: 0 },
          { path: "file.txt", added: 1, removed: 1 },
          { path: "tab\there \u0001ctl.txt", added: 1, removed: 0 },
          { path: 'we"ird.txt', added: 2, removed: 0 },
        ],
        findings: [
          { kind: "todo", path: "tab\there \u0001ctl.txt" },
          { kind: "secret", path: 'we"ird.txt' },
        ],
        changedFiles: 4,
        addedLines: 6,
        removedLines: 1,
      },
    });
  });

  test("does not mistake a removed line that starts with `-- a/` for a file header", async () => {
    const { root, tool } = await fixture();
    await writeFile(join(root, "notes.md"), "keep\n-- a/phantom.txt\nTODO: real finding\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "add notes"], { cwd: root });
    await writeFile(join(root, "notes.md"), "keep\n");
    const result = await tool.execute("review", {}, undefined, undefined, {} as never);
    const details = result.details as { files: Array<{ path: string; added: number; removed: number }>; findings: Array<{ kind: string; path?: string }> };
    expect(details.files).toEqual([{ path: "notes.md", added: 0, removed: 2 }]);
    expect(details.files.map((file) => file.path)).not.toContain("phantom.txt");
    expect(details).toMatchObject({ removedLines: 2, addedLines: 0 });
  });

  test("cleans up registrations on disposal", async () => {
    const { context, tools, panels } = await fixture();
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
});
