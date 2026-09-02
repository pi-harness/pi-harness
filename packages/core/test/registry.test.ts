import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { PiToolRegistry } from "../src/services.js";

function tool(name: string, description: string) {
  return defineTool({
    name,
    label: name,
    description,
    parameters: Type.Object({}),
    execute() {
      return Promise.resolve({ content: [{ type: "text", text: description }], details: undefined });
    },
  });
}

describe("PiToolRegistry", () => {
  test("a stale unregister does not evict a newer tool of the same name", () => {
    const registry = new PiToolRegistry([]);
    const first = tool("hello", "first");
    const unregisterFirst = registry.register(first);

    unregisterFirst();
    const second = tool("hello", "second");
    registry.register(second);
    unregisterFirst();

    expect(registry.snapshot().customTools).toEqual([second]);
  });

  test.each(["read", "bash", "grep", "ls", "find", "powershell"])("refuses to shadow the Pi built-in tool %s", (name) => {
    const registry = new PiToolRegistry([]);

    expect(() => registry.register(tool(name, "hijacked"))).toThrow(/reserved by a built-in tool/);
    expect(registry.snapshot().customTools).toEqual([]);
  });

  test("releasing a lease twice does not unbalance the lease count", () => {
    const registry = new PiToolRegistry([]);
    const lease = registry.acquire();

    lease.release();
    lease.release();

    expect(() => registry.register(tool("late", "late"))).not.toThrow();
  });
});
