import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import webServerPlugin from "@pi-harness/host-webserver";
import apiPlugin from "../src/index.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

describe("API gateway plugin", () => {
  test("serializes concurrent prompts and validates input", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    const session = { messages: [], subscribe: () => () => {} };
    let promptStarted = false;
    let releasePrompt: (() => void) | undefined;
    const runtime = {
      session,
      prompt: () => {
        promptStarted = true;
        return new Promise<void>((resolve) => { releasePrompt = resolve; });
      },
    };
    context.provide("piRuntime", runtime as never);
    context.provide("piModels", { model: { provider: "test", id: "model" } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const first = fetch(context.webServer.url + "/api/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "first" }) });
    while (!promptStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(fetch(context.webServer.url + "/api/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "second" }) })).resolves.toMatchObject({ status: 409 });
    releasePrompt?.();
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(fetch(context.webServer.url + "/api/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "   " }) })).resolves.toMatchObject({ status: 400 });
  });

  test("returns the live session messages and trajectory events", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    type Listener = (event: { type: string; [key: string]: unknown }) => void;
    const listeners = new Set<Listener>();
    const session = {
      sessionId: "session-test",
      sessionFile: "/tmp/session-test.jsonl",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      subscribe(listener: Listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const runtime = { session, prompt: () => {
      listeners.forEach((listener) => listener({ type: "tool_execution_start", toolName: "read", toolCallId: "call-1", args: { path: "README.md" } }));
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 });
    } };
    context.provide("piRuntime", runtime as never);
    context.provide("piModels", { model: { provider: "test", id: "model" } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    await fetch(context.webServer.url + "/api/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello" }) });
    const response = await fetch(context.webServer.url + "/api/session");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: "session-test",
      messages: [{ role: "user", content: "hello", timestamp: 1 }, { role: "assistant" }],
      events: [{ type: "tool_execution_start", toolName: "read" }],
    });
  });
});
