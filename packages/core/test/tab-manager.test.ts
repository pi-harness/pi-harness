import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import tabManagerPlugin from "../src/plugins/tab-manager.js";
import { provideLaunchContext, PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-tabs-"));
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piSession", { manager: { getSessionId: () => "session-1", getSessionFile: () => join(root, "session-1.jsonl") } } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(tabManagerPlugin);
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "session_tab_manage");
  if (tool === undefined) throw new Error("session_tab_manage was not registered");
  return { root, context, tools, panels, tool };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("tab manager", () => {
  test("pins, renames, lists, and removes a session tab", async () => {
    const { tool, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    await expect(tool.execute("pin", { action: "pin", label: "Current" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { id: "session-1", label: "Current", pinned: true },
    });
    await expect(tool.execute("rename", { action: "rename", label: "Renamed" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { activeId: "session-1", tabs: [{ label: "Renamed", pinned: true }] },
    });
    await expect(tool.execute("list", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tabs: [{ label: "Renamed" }] },
    });
    await expect(tool.execute("remove", { action: "remove" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tabs: [], activeId: null },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { tabs: [], activeId: null } }]);
  });

  test("pins another session by its requested path without touching the active session's tab", async () => {
    const { root, tool } = await fixture();
    const otherPath = join(root, "session-2.jsonl");
    await expect(
      tool.execute("pin-other", { action: "pin", sessionPath: otherPath, label: "Other" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      details: { id: "session-2", label: "Other", sessionPath: otherPath, pinned: true },
    });
    await expect(tool.execute("pin-active", { action: "pin", label: "Mine" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { id: "session-1", label: "Mine", sessionPath: join(root, "session-1.jsonl"), pinned: true },
    });
    await expect(tool.execute("list", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: {
        activeId: "session-1",
        tabs: [
          { id: "session-1", label: "Mine" },
          { id: "session-2", label: "Other" },
        ],
      },
    });
    await expect(tool.execute("activate", { action: "activate", sessionPath: otherPath }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [{ type: "text", text: "Active session tab: Other" }],
      details: { activeId: "session-2" },
    });
    await expect(tool.execute("remove", { action: "remove", sessionPath: otherPath }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { activeId: "session-1", tabs: [{ id: "session-1", label: "Mine" }] },
    });
  });

  test("rejects pinning a second session whose file name collides with an existing tab id", async () => {
    const { root, tool } = await fixture();
    await tool.execute("pin-first", { action: "pin", sessionPath: join(root, "a", "shared.jsonl") }, undefined, undefined, {} as never);
    await expect(
      tool.execute("pin-second", { action: "pin", sessionPath: join(root, "b", "shared.jsonl") }, undefined, undefined, {} as never),
    ).rejects.toThrow(/already exists/iu);
    await expect(tool.execute("list", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tabs: [{ id: "shared", sessionPath: join(root, "a", "shared.jsonl") }] },
    });
  });

  test("rejects invalid labels and disposes its registry entries", async () => {
    const { context, tool, tools, panels } = await fixture();
    await expect(tool.execute("rename", { action: "rename", label: "" }, undefined, undefined, {} as never)).rejects.toThrow(/label/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
});
