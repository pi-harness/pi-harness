import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import taskboardPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-taskboard-"));
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(taskboardPlugin, { fileName: "tasks.sqlite", keyPrefix: "TST" });
  contexts.push(context);
  const find = (name: string) => {
    const tool = tools.snapshot().customTools.find((item) => item.name === name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  };
  return {
    context,
    tools,
    panels,
    create: find("taskboard_create"),
    list: find("taskboard_list"),
    update: find("taskboard_update"),
    accept: find("taskboard_accept"),
  };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("taskboard", () => {
  test("creates, updates, lists, and accepts a review task", async () => {
    const { create, list, update, accept, panels } = await fixture();
    for (const tool of [create, list, update, accept]) {
      expect(tool.executionMode).toBe("sequential");
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
    const created = await create.execute(
      "create",
      { title: "Ship feature", description: "Review and release", priority: "high" },
      undefined,
      undefined,
      {} as never,
    );
    expect(created.details).toMatchObject({ key: "TST-1", status: "backlog", priority: "high" });
    await expect(update.execute("update", { key: "TST-1", status: "in_review" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { key: "TST-1", status: "in_review" },
    });
    await expect(accept.execute("accept", { key: "TST-1", confirm: false }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    await expect(accept.execute("accept", { key: "TST-1", confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { key: "TST-1", status: "done" },
    });
    await expect(list.execute("list", { status: "done" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { total: 1 } });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { total: 1, counts: { done: 1 } } }]);
  });

  test("cleans up all registrations on disposal", async () => {
    const { context, tools, panels } = await fixture();
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
});
