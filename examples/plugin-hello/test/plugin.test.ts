import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiToolRegistry } from "@pi-harness/core";
import helloPlugin from "../src/index.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

describe("hello plugin", () => {
  test("registers and unregisters a Pi tool with the Cordis lifecycle", async () => {
    const context = new Context();
    const tools = new PiToolRegistry();
    contexts.push(context);
    context.provide("piTools", tools);

    const fiber = context.plugin(helloPlugin);
    await fiber;

    expect(tools.snapshot().customTools).toEqual([
      expect.objectContaining({
        name: "hello",
        label: "Hello",
        description: "Greet a person by name.",
      }),
    ]);
    expect(context.get("piHelloTool")).toBeDefined();

    await fiber.dispose();

    expect(tools.snapshot().customTools).toEqual([]);
    expect(context.get("piHelloTool")).toBeUndefined();
  });
});
