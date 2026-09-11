import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import sessionExportPlugin, { renderSessionMarkdown } from "../src/index.js";

describe("session export", () => {
  test("preserves code indentation and boundary whitespace in string messages", () => {
    const text = "    if ready:\n        run()\n\n";
    expect(renderSessionMarkdown([{ role: "user", content: text }])).toBe(`# Pi Harness Session\n\n## User\n\n${text}\n`);
  });

  test("preserves Markdown hard breaks and indentation in separate text blocks", () => {
    const parts = ["first line  ", "second line\n\n", "    code()\n"];
    expect(renderSessionMarkdown([{ role: "assistant", content: parts.map((text) => ({ type: "text", text })) }])).toBe(
      `# Pi Harness Session\n\n## Assistant\n\n${parts.join("\n")}\n`,
    );
  });

  test("still omits messages containing only whitespace", () => {
    expect(renderSessionMarkdown([{ role: "user", content: " \n\t" }, { role: "assistant", content: [{ type: "text", text: "  \n" }] }])).toBe("# Pi Harness Session\n\n");
  });

  test("counts preserved whitespace toward the output byte limit", () => {
    expect(() => renderSessionMarkdown([{ role: "user", content: " ".repeat(1024 * 1024) + "code" }])).toThrow(/1 MiB/);
  });

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
    context.provide("piRuntime", {
      session: { sessionManager: { getCwd: () => cwd, getSessionId: () => "active" }, messages: [{ role: "user", content: "hello" }] },
    } as never);
    try {
      await context.plugin(sessionExportPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_export");
      expect(tool).toBeDefined();
      await expect(tool!.execute("call-1", { path: "exports/session.md" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { path: "exports/session.md", messages: 1 },
      });
      await expect(readFile(join(cwd, "exports/session.md"), "utf8")).resolves.toContain("## User");
      await expect(tool!.execute("call-2", { path: "exports/session.md" }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
      const results = await Promise.allSettled([
        tool!.execute("race-1", { path: "race.md" }, undefined, undefined, {} as never),
        tool!.execute("race-2", { path: "race.md" }, undefined, undefined, {} as never),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const abort = new AbortController();
      abort.abort();
      await expect(tool!.execute("cancel", { path: "cancel.md" }, abort.signal, undefined, {} as never)).rejects.toThrow();
      await expect(readFile(join(cwd, "cancel.md"))).rejects.toThrow();
      const result = await tool!.execute("snapshot", { path: "snapshot.md" }, undefined, undefined, {} as never);
      (result.details as { path: string }).path = "MUTATED";
      expect(JSON.stringify(await panels.snapshot())).not.toContain("MUTATED");
      await context.fiber.dispose();
      await expect(tool!.execute("disposed", {}, undefined, undefined, {} as never)).rejects.toThrow(/cancelled/);
    } finally {
      await context.fiber.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("rejects oversized rendered output", () => {
  expect(() => renderSessionMarkdown([{ role: "user", content: "x".repeat(1024 * 1024) }])).toThrow(/1 MiB/);
});
