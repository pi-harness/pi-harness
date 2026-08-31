import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("opens an event stream with the current trajectory snapshot", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    type Listener = (event: { type: string; [key: string]: unknown }) => void;
    const listeners = new Set<Listener>();
    const session = {
      sessionId: "stream-session",
      sessionFile: undefined,
      messages: [],
      subscribe(listener: Listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve() } as never);
    context.provide("piModels", { model: { provider: "test", id: "model" } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const response = await fetch(context.webServer.url + "/api/events");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    const text = new TextDecoder().decode(first?.value);
    expect(text).toContain('"type":"snapshot"');
    expect(text).toContain('"sessionId":"stream-session"');
    const next = reader?.read();
    listeners.forEach((listener) => listener({ type: "tool_execution_start", toolName: "read" }));
    const second = await next;
    expect(new TextDecoder().decode(second?.value)).toContain('"type":"event"');
    await reader?.cancel();
  });

  test("creates a new session through the live AgentSession", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    let sessionId = "old-session";
    let resetCount = 0;
    const session = {
      get sessionId() { return sessionId; },
      sessionFile: undefined,
      messages: [{ role: "user", content: "old" }],
      isStreaming: false,
      sessionManager: { newSession() { sessionId = "new-session"; resetCount += 1; }, getEntries: () => [] },
      agent: { state: { messages: [{ role: "user", content: "old" }] } },
      subscribe: () => () => {},
    };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve() } as never);
    context.provide("piModels", { model: { provider: "test", id: "model" } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const sessions = await fetch(context.webServer.url + "/api/sessions");
    expect(sessions.status).toBe(200);
    await expect(sessions.json()).resolves.toEqual({ items: [] });
    const response = await fetch(context.webServer.url + "/api/session/new", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sessionId: "new-session", messages: [] });
    expect(resetCount).toBe(1);
  });

  test("opens a persisted session from the session list", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-api-sessions-"));
    const path = join(directory, "2026-08-30T00-00-00-000Z_target.jsonl");
    await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: "target-session", timestamp: new Date().toISOString(), cwd: "/tmp" })}\n${JSON.stringify({ type: "message", id: "message-1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "saved" }], provider: "test", model: "model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } })}\n`, "utf8");
    let openedPath = "";
    const session = {
      sessionId: "active-session",
      sessionFile: "/tmp/active.jsonl",
      messages: [],
      isStreaming: false,
      sessionManager: { setSessionFile(nextPath: string) { openedPath = nextPath; }, getEntries: () => [], isPersisted: () => true, getSessionDir: () => directory, buildSessionContext: () => ({ messages: [] }) },
      agent: { state: { messages: [] } },
      subscribe: () => () => {},
    };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve() } as never);
    context.provide("piModels", { model: { provider: "test", id: "model" } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const response = await fetch(context.webServer.url + "/api/session/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
    expect(response.status).toBe(200);
    expect(openedPath).toBe(path);
  });

  test("lists and selects models through the live Pi session", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    const first = { provider: "test", id: "one", name: "Test One", reasoning: false, contextWindow: 8_000 };
    const second = { provider: "test", id: "two", name: "Test Two", reasoning: true, contextWindow: 16_000 };
    let selected = "one";
    const session = {
      sessionId: "model-session",
      sessionFile: undefined,
      messages: [],
      isStreaming: false,
      get model() { return selected === "one" ? first : second; },
      setModel(model: { id: string }) { selected = model.id; return Promise.resolve(); },
      subscribe: () => () => {},
    };
    const modelRuntime = { getModels: () => [first, second], getModel: (_provider: string, id: string) => id === "two" ? second : id === "one" ? first : undefined };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve(), abort: () => Promise.resolve(), dispose: () => Promise.resolve() } as never);
    context.provide("piModels", { model: first, runtime: modelRuntime } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    await expect(fetch(context.webServer.url + "/api/models")).resolves.toMatchObject({ status: 200 });
    const list = await fetch(context.webServer.url + "/api/models");
    await expect(list.json()).resolves.toMatchObject({ items: [{ id: "one", active: true }, { id: "two", active: false }] });
    const providers = await fetch(context.webServer.url + "/api/providers");
    await expect(providers.json()).resolves.toMatchObject({ items: [{ provider: "test", activeModel: { id: "one", active: true } }] });
    const response = await fetch(context.webServer.url + "/api/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "test", model: "two" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ model: { id: "two", active: true } });
    expect(selected).toBe("two");
  });

  test("lists commands from the live extension registry", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    const session = {
      sessionId: "command-session",
      sessionFile: undefined,
      messages: [],
      isStreaming: false,
      extensionRunner: { getRegisteredCommands: () => [{ name: "review", invocationName: "review", description: "Review changes", sourceInfo: { path: "/tmp/review.ts" } }] },
      subscribe: () => () => {},
    };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve() } as never);
    context.provide("piModels", { model: { provider: "test", id: "model" } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const response = await fetch(context.webServer.url + "/api/commands");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [{ name: "review", invocationName: "review", description: "Review changes", source: "/tmp/review.ts" }] });
  });

  test("aborts a running prompt through the web API", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    let aborted = false;
    const session = { sessionId: "abort-session", sessionFile: undefined, messages: [], isStreaming: true, subscribe: () => () => {} };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve(), abort: () => { aborted = true; session.isStreaming = false; return Promise.resolve(); }, dispose: () => Promise.resolve() } as never);
    context.provide("piModels", { model: { provider: "test", id: "model" }, runtime: { getModels: () => [], getModel: () => undefined } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const response = await fetch(context.webServer.url + "/api/abort", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ aborted: true });
    expect(aborted).toBe(true);
  });

  test("reports workspace file status without exposing a fake action", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    const session = { sessionId: "files-session", sessionFile: undefined, messages: [], isStreaming: false, subscribe: () => () => {} };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve(), abort: () => Promise.resolve(), dispose: () => Promise.resolve() } as never);
    context.provide("piModels", { model: { provider: "test", id: "model" }, runtime: { getModels: () => [], getModel: () => undefined } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const response = await fetch(context.webServer.url + "/api/files");
    expect(response.status).toBe(200);
    const payload = await response.json() as { items?: unknown };
    expect(Array.isArray(payload.items)).toBe(true);

    const diff = await fetch(context.webServer.url + "/api/files/diff?path=README.md");
    expect(diff.status).toBe(200);
    const diffPayload = await diff.json() as { path?: unknown; diff?: unknown };
    expect(diffPayload.path).toBe("README.md");
    expect(typeof diffPayload.diff).toBe("string");
    const invalid = await fetch(context.webServer.url + "/api/files/diff?path=../secrets.txt");
    expect(invalid.status).toBe(400);
  });
});
