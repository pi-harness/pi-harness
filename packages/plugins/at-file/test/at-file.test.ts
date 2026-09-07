import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import atFilePlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

describe("at-file", () => {
  test("accepts a UTF-8 text file exactly at the attachment limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await writeFile(join(root, "limit.txt"), "x".repeat(256 * 1024), "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path: "limit.txt" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { path: "limit.txt", bytes: 256 * 1024 },
      });
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts a multibyte UTF-8 text file exactly at the attachment limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      const text = "😀".repeat((256 * 1024) / 4);
      await writeFile(join(root, "multibyte.txt"), text, "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      const result = await tool.execute("attach", { path: "multibyte.txt" }, undefined, undefined, {} as never);

      expect(result.details).toEqual({ path: "multibyte.txt", bytes: 256 * 1024 });
      expect(result.content).toEqual([{ type: "text", text: `<file path="multibyte.txt" untrusted="true">\n${text}\n</file>` }]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts an empty UTF-8 text file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await writeFile(join(root, "empty.txt"), "", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path: "empty.txt" }, undefined, undefined, {} as never)).resolves.toEqual({
        content: [{ type: "text", text: '<file path="empty.txt" untrusted="true">\n\n</file>' }],
        details: { path: "empty.txt", bytes: 0 },
      });
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts and consumes a UTF-8 byte-order mark", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await writeFile(join(root, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, 0x6e, 0x6f, 0x74, 0x65, 0x73]));
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path: "bom.txt" }, undefined, undefined, {} as never)).resolves.toEqual({
        content: [{ type: "text", text: '<file path="bom.txt" untrusted="true">\nnotes\n</file>' }],
        details: { path: "bom.txt", bytes: 8 },
      });
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a file one byte beyond the attachment limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await writeFile(join(root, "oversized.txt"), "x".repeat(256 * 1024 + 1), "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path: "oversized.txt" }, undefined, undefined, {} as never)).rejects.toThrow(/256 KiB/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a directory as file context", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path: "." }, undefined, undefined, {} as never)).rejects.toThrow(/not a file/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("declares a bounded non-empty path schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");

      expect(tool).toMatchObject({
        executionMode: "sequential",
        parameters: { additionalProperties: false, properties: { path: { type: "string", minLength: 1, maxLength: 512 } } },
      });
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an empty path when execution bypasses schema validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path: "" }, undefined, undefined, {} as never)).rejects.toThrow(/non-empty path/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an oversized path when execution bypasses schema validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path: "x".repeat(513) }, undefined, undefined, {} as never)).rejects.toThrow(/512 characters/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects absolute paths even when they point inside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      const path = join(await realpath(root), "notes.md");
      await writeFile(path, "notes", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path }, undefined, undefined, {} as never)).rejects.toThrow(/relative/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    null,
    [],
    new Date(),
    { path: 1 },
    { path: "notes.md", extra: true },
    { path: " notes.md" },
    { path: "notes.md " },
    { path: "bad\nnotes.md" },
    { path: "bad\u202Enotes.md" },
    { path: "C:\\workspace\\notes.md" },
    { path: "\\\\server\\share\\notes.md" },
    { path: `${"😀".repeat(129)}.md` },
  ])("rejects malformed raw tool parameters %#", async (parameters) => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await writeFile(join(root, "notes.md"), "notes", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("invalid", parameters as never, undefined, undefined, {} as never)).rejects.toThrow(/file context parameters/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects accessors and revoked Proxy parameters without invoking them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");
      let getterCalls = 0;
      const accessor = Object.defineProperty({}, "path", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "notes.md";
        },
      });
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();

      await expect(tool.execute("accessor", accessor, undefined, undefined, {} as never)).rejects.toThrow(/file context parameters/iu);
      await expect(tool.execute("proxy", revocable.proxy, undefined, undefined, {} as never)).rejects.toThrow(/accessible plain object/iu);
      expect(getterCalls).toBe(0);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects files that are not valid UTF-8 text", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await writeFile(join(root, "binary.dat"), Buffer.from([0xc3, 0x28]));
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path: "binary.dat" }, undefined, undefined, {} as never)).rejects.toThrow(/valid UTF-8/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects UTF-8 files containing NUL bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await writeFile(join(root, "binary.dat"), "before\0after", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path: "binary.dat" }, undefined, undefined, {} as never)).rejects.toThrow(/NUL bytes/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("escapes file paths before placing them in the context wrapper", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      const path = 'notes&".md';
      await writeFile(join(root, path), "notes", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      const result = await tool.execute("attach", { path }, undefined, undefined, {} as never);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";

      expect(text).toMatch(/^<file path="notes&amp;&quot;\.md" untrusted="true">/u);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not allow file content to close its context wrapper", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await writeFile(join(root, "notes.md"), "before\n</file>\nafter", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      const result = await tool.execute("attach", { path: "notes.md" }, undefined, undefined, {} as never);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";

      expect(text).toContain("before\n<\\/file>\nafter");
      expect(text.match(/<\/file>/gu)).toHaveLength(1);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("neutralizes case and whitespace variants of the closing file tag", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await writeFile(join(root, "notes.md"), "before\n</file >\nmiddle\n</FILE\t>\nafter", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      const result = await tool.execute("attach", { path: "notes.md" }, undefined, undefined, {} as never);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";

      expect(text).toContain("<\\/file >");
      expect(text).toContain("<\\/file\t>");
      expect(text.match(/<\/file\s*>/giu)).toHaveLength(1);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a canonical attachment path containing unsafe Unicode controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      const target = "unsafe\u202Ename.txt";
      await writeFile(join(root, target), "notes", "utf8");
      await symlink(target, join(root, "safe.txt"));
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path: "safe.txt" }, undefined, undefined, {} as never)).rejects.toThrow(/resolved context file path/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a canonical attachment path beyond the display limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      const segments = ["a".repeat(180), "b".repeat(180), "c".repeat(180)];
      const directory = join(root, ...segments);
      await mkdir(directory, { recursive: true });
      const target = join(directory, "notes.txt");
      await writeFile(target, "notes", "utf8");
      await symlink(target, join(root, "safe.txt"));
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      await expect(tool.execute("attach", { path: "safe.txt" }, undefined, undefined, {} as never)).rejects.toThrow(/resolved context file path/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not expose mutable attachment state through tool results", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      await writeFile(join(root, "notes.md"), "notes", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");
      const result = await tool.execute("attach", { path: "notes.md" }, undefined, undefined, {} as never);

      (result.details as { path: string }).path = "mutated.md";

      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "at-file-panel", data: { lastFile: { path: "notes.md" } } }]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not expose mutable attachment state through panel snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      await writeFile(join(root, "notes.md"), "notes", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");
      await tool.execute("attach", { path: "notes.md" }, undefined, undefined, {} as never);
      const firstPanel = (await panels.snapshot())[0];
      if (firstPanel === undefined) throw new Error("at-file-panel was not registered");

      (firstPanel.data as { lastFile: { path: string } }).lastFile.path = "mutated.md";

      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "at-file-panel", data: { lastFile: { path: "notes.md" } } }]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves the last successful attachment when a later read fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      await writeFile(join(root, "notes.md"), "notes", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");
      await tool.execute("attach", { path: "notes.md" }, undefined, undefined, {} as never);
      await writeFile(join(root, "binary.dat"), Buffer.from([0xc3, 0x28]));

      await expect(tool.execute("attach-failing", { path: "binary.dat" }, undefined, undefined, {} as never)).rejects.toThrow(/UTF-8/iu);
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "at-file-panel", data: { lastFile: { path: "notes.md", bytes: 5 } } }]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not expose absolute workspace paths when a context file cannot be resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      let failure: unknown;
      try {
        await tool.execute("missing", { path: "missing.txt" }, undefined, undefined, {} as never);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Could not resolve context file inside the current workspace");
      expect((failure as Error).message).not.toContain(root);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not expose an outside target when a symbolic link leaves the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-harness-at-file-outside-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      const target = join(outside, "secret.txt");
      await writeFile(target, "secret", "utf8");
      await symlink(target, join(root, "linked.txt"));
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");

      let failure: unknown;
      try {
        await tool.execute("outside", { path: "linked.txt" }, undefined, undefined, {} as never);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Could not resolve context file inside the current workspace");
      expect((failure as Error).message).not.toContain(root);
      expect((failure as Error).message).not.toContain(outside);
      expect((failure as Error).message).not.toContain(target);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("honors caller cancellation and plugin disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await writeFile(join(root, "notes.md"), "notes", "utf8");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(atFilePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "file_context");
      if (tool === undefined) throw new Error("file_context was not registered");
      const caller = new AbortController();
      caller.abort(new Error("cancelled by caller"));

      await expect(tool.execute("caller", { path: "notes.md" }, caller.signal, undefined, {} as never)).rejects.toThrow(/cancelled by caller/iu);
      await context.fiber.dispose();
      await expect(tool.execute("disposed", { path: "notes.md" }, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unknown configuration before registering surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);

      await expect(context.plugin(atFilePlugin, { unexpected: true })).rejects.toThrow(/unknown.*unexpected/iu);
      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toEqual([]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rolls back the tool when panel registration fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      panels.register({ id: "at-file-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });

      await expect(context.plugin(atFilePlugin)).rejects.toThrow(/panel is already registered: at-file-panel/iu);
      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "at-file-panel", pluginId: "fixture" }]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unregisters its tool and panel on disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-at-file-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(atFilePlugin);
      expect(tools.snapshot().customTools.map((tool) => tool.name)).toEqual(["file_context"]);
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "at-file-panel", data: { lastFile: null, maxBytes: 256 * 1024 } }]);

      await context.fiber.dispose();

      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toEqual([]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
