import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import sessionExportPlugin, { renderSessionMarkdown } from "../src/index.js";

describe("session export", () => {
  test("renders user, assistant, and tool messages as readable Markdown", () => {
    const markdown = renderSessionMarkdown([
      { role: "user", content: "请解释这个函数" },
      { role: "assistant", content: [{ type: "text", text: "它负责解析配置。" }] },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "export const value = 1;" }] },
    ]);
    expect(markdown).toContain("# Pi Harness Session");
    expect(markdown).toContain("## User\n\n请解释这个函数");
    expect(markdown).toContain("## Assistant\n\n它负责解析配置。");
    expect(markdown).toContain("### Tool: read\n\nexport const value = 1;");
  });

  test("does not emit empty message sections", () => {
    expect(
      renderSessionMarkdown([
        { role: "assistant", content: "" },
        { role: "system", content: "context" },
      ]),
    ).toBe("# Pi Harness Session\n\n## System\n\ncontext\n");
  });

  test("exports the native session and refuses an unconfirmed overwrite", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-export-"));
    const context = new Context();
    provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    context.provide("piRuntime", { session: { messages: [{ role: "user", content: "hello" }] } } as never);
    try {
      await context.plugin(sessionExportPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_export");
      expect(tool).toBeDefined();
      await expect(tool!.execute("call-1", { path: "exports/session.md" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { path: "exports/session.md", messages: 1 },
      });
      await expect(readFile(join(cwd, "exports/session.md"), "utf8")).resolves.toContain("## User");
      await expect(tool!.execute("call-2", { path: "exports/session.md" }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    } finally {
      await context.fiber.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
