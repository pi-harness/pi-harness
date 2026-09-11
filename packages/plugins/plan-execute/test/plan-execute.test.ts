import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import planExecutePlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

async function fixture() {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  context.provide("piSession", { manager: SessionManager.inMemory("/plan-test") });
  await context.plugin(planExecutePlugin);
  contexts.push(context);
  const find = (name: string) => {
    const tool = tools.snapshot().customTools.find((item) => item.name === name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  };
  return { context, tools, panels, create: find("plan_create"), advance: find("plan_advance") };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("plan execute", () => {
  test("retrieves an existing plan without advancing or replacing it", async () => {
    const { create, advance, tools, panels, context } = await fixture();
    const get = tools.snapshot().customTools.find((tool) => tool.name === "plan_get");
    expect(get, "plan_get must provide read-only recovery of current progress").toBeDefined();
    expect(get!.parameters).toMatchObject({ type: "object", additionalProperties: false, properties: {} });
    expect(get!.executionMode).toBe("sequential");
    await expect(get!.execute("empty", {}, undefined, undefined, {} as never)).rejects.toThrow(/No plan/);
    await create.execute("create", { title: "Recover", steps: ["Test", "Ship"], dependencies: [{ step: 2, dependsOn: [1] }] }, undefined, undefined, {} as never);
    const advanced = await advance.execute("done", { step: 1, status: "done" }, undefined, undefined, {} as never);
    const before = await panels.snapshot();
    const result = await get!.execute("get", {}, undefined, undefined, {} as never);
    expect(result).toEqual(advanced);
    (result.details as { steps: Array<{ status: string }> }).steps[0]!.status = "mutated";
    expect(await panels.snapshot()).toEqual(before);
    const abort = new AbortController();
    const pending = get!.execute("cancel", {}, abort.signal, undefined, {} as never);
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(await panels.snapshot()).toEqual(before);
    await context.fiber.dispose();
    await expect(get!.execute("disposed", {}, undefined, undefined, {} as never)).rejects.toThrow(/disposed/);
    expect(tools.snapshot().customTools).toHaveLength(0);
  });

  test("returns the complete plan to the model on creation and advancement", async () => {
    const { create, advance } = await fixture();
    const created = await create.execute("create", {
      title: "发布😀", steps: ["验证", "上线"], dependencies: [{ step: 2, dependsOn: [1] }],
    }, undefined, undefined, {} as never);
    expect(created.content).toEqual([{ type: "text", text: JSON.stringify(created.details) }]);
    const advanced = await advance.execute("done", { step: 1, status: "done" }, undefined, undefined, {} as never);
    expect(advanced.content).toEqual([{ type: "text", text: JSON.stringify(advanced.details) }]);
    expect(advanced.details).toMatchObject({ title: "发布😀", steps: [
      { id: 1, title: "验证", status: "done" },
      { id: 2, title: "上线", status: "pending", dependsOn: [1] },
    ] });
  });

  test("creates and advances a bounded plan with strict sequential tools", async () => {
    const { create, advance, panels } = await fixture();
    for (const tool of [create, advance]) {
      expect(tool.executionMode).toBe("sequential");
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
    await expect(create.execute("create", { title: "Release", steps: ["Test", "Ship"] }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: {
        title: "Release",
        steps: [
          { id: 1, status: "pending" },
          { id: 2, status: "pending" },
        ],
      },
    });
    const inProgress = await advance.execute("advance", { step: 1, status: "in_progress" }, undefined, undefined, {} as never);
    expect((inProgress.details as { steps: Array<{ id: number; status: string }> }).steps[0]).toMatchObject({ id: 1, status: "in_progress" });
    const done = await advance.execute("advance", { step: 1, status: "done" }, undefined, undefined, {} as never);
    expect((done.details as { steps: Array<{ id: number; status: string }> }).steps[0]).toMatchObject({ id: 1, status: "done" });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { title: "Release", completed: 1, total: 2 } }]);
  });

  test("rejects invalid plans and cleans up both tools and panel", async () => {
    const { context, create, tools, panels } = await fixture();
    await expect(create.execute("create", { title: "", steps: ["x"] }, undefined, undefined, {} as never)).rejects.toThrow(/title/iu);
    await expect(create.execute("create", { title: "x", steps: [] }, undefined, undefined, {} as never)).rejects.toThrow(/1-50/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });

  test("rejects unknown plugin configuration before activation", async () => {
    const context = new Context();
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", new PiPluginUiRegistry());
    context.provide("piSession", { manager: SessionManager.inMemory("/plan-test") });
    let error: unknown;
    try {
      await context.plugin(planExecutePlugin, { unexpected: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/config keys: unexpected/iu);
    await context.fiber.dispose();
  });

  test("does not expose mutable plan state through tool results or panel snapshots", async () => {
    const { create, advance, panels } = await fixture();
    const result = await create.execute("create", { title: "Protected", steps: ["One"] }, undefined, undefined, {} as never);
    (result.details as { title: string }).title = "mutated";
    await expect(advance.execute("advance", { step: 1, status: "done" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { title: "Protected", steps: [{ title: "One", status: "done" }] },
    });
    const panel = (await panels.snapshot())[0];
    (panel?.data as { title: string }).title = "panel-mutated";
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { title: "Protected" } }]);
  });
  test("rejects invalid step numbers, statuses, cancellation, and disposed tools without changing the plan", async () => {
    const { create, advance, context, panels } = await fixture();
    await create.execute("create", { title: "Plan", steps: ["One"] }, undefined, undefined, {} as never);
    for (const step of [Number.NaN, 1.5, 0, 2])
      await expect(advance.execute("bad", { step, status: "done" }, undefined, undefined, {} as never)).rejects.toThrow(/step/iu);
    await expect(advance.execute("bad", { step: 1, status: "invalid" }, undefined, undefined, {} as never)).rejects.toThrow(/status/iu);
    const controller = new AbortController();
    controller.abort();
    await expect(create.execute("cancel", { title: "Changed", steps: ["New"] }, controller.signal, undefined, {} as never)).rejects.toThrow();
    await expect(advance.execute("cancel", { step: 1, status: "done" }, controller.signal, undefined, {} as never)).rejects.toThrow();
    expect((await panels.snapshot())[0]!.data).toMatchObject({ title: "Plan", steps: [{ status: "pending" }] });
    await context.fiber.dispose();
    await expect(create.execute("disposed", { title: "New", steps: ["New"] }, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
    await expect(advance.execute("disposed", { step: 1, status: "done" }, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
  });

  test("enforces acyclic dependencies and prevents reopening prerequisites of active dependents", async () => {
    const { create, advance, panels } = await fixture();
    const params = {
      title: "Release",
      steps: ["Test", "Build", "Ship"],
      dependencies: [
        { step: 2, dependsOn: [1] },
        { step: 3, dependsOn: [2] },
      ],
    };
    await create.execute("create", params, undefined, undefined, {} as never);
    await expect(advance.execute("blocked", { step: 2, status: "in_progress" }, undefined, undefined, {} as never)).rejects.toThrow(/depend/iu);
    await advance.execute("done", { step: 1, status: "done" }, undefined, undefined, {} as never);
    await advance.execute("active", { step: 2, status: "in_progress" }, undefined, undefined, {} as never);
    await expect(advance.execute("reopen", { step: 1, status: "pending" }, undefined, undefined, {} as never)).rejects.toThrow(/depend/iu);
    await advance.execute("skip", { step: 2, status: "skipped" }, undefined, undefined, {} as never);
    await advance.execute("ship", { step: 3, status: "done" }, undefined, undefined, {} as never);
    for (const dependencies of [[{ step: 1, dependsOn: [3] }, ...params.dependencies], [{ step: 1, dependsOn: [1] }], [{ step: 4, dependsOn: [1] }]])
      await expect(create.execute("invalid", { ...params, dependencies }, undefined, undefined, {} as never)).rejects.toThrow(/depend/iu);
    expect((await panels.snapshot())[0]!.data).toMatchObject({ title: "Release", completed: 2, total: 3 });
  });
});
