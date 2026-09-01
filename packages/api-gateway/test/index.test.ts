import { mkdtemp, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import webServerPlugin from "@pi-harness/host-webserver";
import apiPlugin from "../src/index.js";

const contexts: Context[] = [];
const execFile = promisify(execFileCallback);

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
        return new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      },
    };
    context.provide("piRuntime", runtime as never);
    context.provide("piModels", { model: { provider: "test", id: "model" } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const first = fetch(context.webServer.url + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "first" }),
    });
    while (!promptStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(
      fetch(context.webServer.url + "/api/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "second" }),
      }),
    ).resolves.toMatchObject({ status: 409 });
    releasePrompt?.();
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(
      fetch(context.webServer.url + "/api/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "   " }),
      }),
    ).resolves.toMatchObject({ status: 400 });
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
    const runtime = {
      session,
      prompt: () => {
        listeners.forEach((listener) => listener({ type: "tool_execution_start", toolName: "read", toolCallId: "call-1", args: { path: "README.md" } }));
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 });
      },
    };
    context.provide("piRuntime", runtime as never);
    context.provide("piModels", { model: { provider: "test", id: "model" } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    await fetch(context.webServer.url + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
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
      get sessionId() {
        return sessionId;
      },
      sessionFile: undefined,
      messages: [{ role: "user", content: "old" }],
      isStreaming: false,
      sessionManager: {
        newSession() {
          sessionId = "new-session";
          resetCount += 1;
        },
        getEntries: () => [],
      },
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
    await writeFile(
      path,
      `${JSON.stringify({ type: "session", version: 3, id: "target-session", timestamp: new Date().toISOString(), cwd: "/tmp" })}\n${JSON.stringify({ type: "message", id: "message-1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "saved" }], provider: "test", model: "model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } })}\n`,
      "utf8",
    );
    let openedPath = "";
    const session = {
      sessionId: "active-session",
      sessionFile: "/tmp/active.jsonl",
      messages: [],
      isStreaming: false,
      sessionManager: {
        setSessionFile(nextPath: string) {
          openedPath = nextPath;
        },
        getEntries: () => [],
        isPersisted: () => true,
        getSessionDir: () => directory,
        buildSessionContext: () => ({ messages: [] }),
      },
      agent: { state: { messages: [] } },
      subscribe: () => () => {},
    };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve() } as never);
    context.provide("piModels", { model: { provider: "test", id: "model" } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const response = await fetch(context.webServer.url + "/api/session/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
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
      get model() {
        return selected === "one" ? first : second;
      },
      setModel(model: { id: string }) {
        selected = model.id;
        return Promise.resolve();
      },
      subscribe: () => () => {},
    };
    const modelRuntime = {
      getModels: () => [first, second],
      getModel: (_provider: string, id: string) => (id === "two" ? second : id === "one" ? first : undefined),
    };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve(), abort: () => Promise.resolve(), dispose: () => Promise.resolve() } as never);
    context.provide("piModels", { model: first, runtime: modelRuntime } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    await expect(fetch(context.webServer.url + "/api/models")).resolves.toMatchObject({ status: 200 });
    const list = await fetch(context.webServer.url + "/api/models");
    await expect(list.json()).resolves.toMatchObject({
      items: [
        { id: "one", active: true },
        { id: "two", active: false },
      ],
    });
    const providers = await fetch(context.webServer.url + "/api/providers");
    await expect(providers.json()).resolves.toMatchObject({ items: [{ provider: "test", activeModel: { id: "one", active: true } }] });
    const response = await fetch(context.webServer.url + "/api/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "test", model: "two" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ model: { id: "two", active: true } });
    expect(selected).toBe("two");
  });

  test("only exposes the active and configured providers", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    const active = { provider: "active", id: "one", name: "Active", reasoning: false, contextWindow: 8_000 };
    const configured = { provider: "configured", id: "one", name: "Configured", reasoning: false, contextWindow: 8_000 };
    const hidden = { provider: "hidden", id: "one", name: "Hidden", reasoning: false, contextWindow: 8_000 };
    const session = {
      sessionId: "provider-filter-session",
      sessionFile: undefined,
      messages: [],
      isStreaming: false,
      model: active,
      subscribe: () => () => {},
    };
    const modelRuntime = {
      getProviders: () => [
        { id: "active", name: "Active" },
        { id: "configured", name: "Configured" },
        { id: "hidden", name: "Hidden" },
      ],
      getModels: (provider?: string) => (provider === "configured" ? [configured] : provider === "hidden" ? [hidden] : [active]),
      getProviderAuthStatus: (provider: string) => (provider === "configured" ? { configured: true, source: "environment" } : { configured: false }),
      getModel: () => active,
    };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve() } as never);
    context.provide("piModels", { model: active, runtime: modelRuntime } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const response = await fetch(context.webServer.url + "/api/providers");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ items: [{ provider: "active" }, { provider: "configured" }] });
  });

  test("explains when EveryAPI CLI auth is not injected into the process", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    const previousCliPath = process.env.EVERYAPI_CLI_PATH;
    const previousRelayKey = process.env.EVERYAPI_RELAY_KEY;
    process.env.EVERYAPI_CLI_PATH = "/usr/bin/false";
    delete process.env.EVERYAPI_RELAY_KEY;
    try {
      const session = {
        model: { provider: "everyapi", id: "deepseek-v4-flash" },
        messages: [],
        isStreaming: false,
        subscribe: () => () => {},
      };
      const modelRuntime = {
        getProviders: () => [{ id: "everyapi", name: "EveryAPI" }],
        getModels: () => [{ provider: "everyapi", id: "deepseek-v4-flash", name: "deepseek-v4-flash" }],
        checkAuth: () => Promise.resolve(undefined),
        getProviderAuthStatus: () => ({ configured: false }),
        getModel: () => session.model,
      };
      context.provide("piRuntime", { session, prompt: () => Promise.resolve() } as never);
      context.provide("piModels", { model: session.model, runtime: modelRuntime } as never);
      context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
      await context.plugin(apiPlugin);

      const response = await fetch(context.webServer.url + "/api/providers/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "everyapi" }),
      });
      await expect(response.json()).resolves.toEqual({
        provider: "everyapi",
        reachable: false,
        auth: { configured: false, source: "everyapi-cli", label: "未检测到 EveryAPI CLI 登录" },
      });
    } finally {
      if (previousCliPath === undefined) delete process.env.EVERYAPI_CLI_PATH;
      else process.env.EVERYAPI_CLI_PATH = previousCliPath;
      if (previousRelayKey === undefined) delete process.env.EVERYAPI_RELAY_KEY;
      else process.env.EVERYAPI_RELAY_KEY = previousRelayKey;
    }
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
      extensionRunner: {
        getRegisteredCommands: () => [{ name: "review", invocationName: "review", description: "Review changes", sourceInfo: { path: "/tmp/review.ts" } }],
      },
      subscribe: () => () => {},
    };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve() } as never);
    context.provide("piModels", { model: { provider: "test", id: "model" } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const response = await fetch(context.webServer.url + "/api/commands");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [{ name: "review", invocationName: "review", description: "Review changes", source: "/tmp/review.ts" }],
    });
  });

  test("aborts a running prompt through the web API", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    let aborted = false;
    const session = { sessionId: "abort-session", sessionFile: undefined, messages: [], isStreaming: true, subscribe: () => () => {} };
    context.provide("piRuntime", {
      session,
      prompt: () => Promise.resolve(),
      abort: () => {
        aborted = true;
        session.isStreaming = false;
        return Promise.resolve();
      },
      dispose: () => Promise.resolve(),
    } as never);
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
    const payload = (await response.json()) as { items?: unknown };
    expect(Array.isArray(payload.items)).toBe(true);

    const diff = await fetch(context.webServer.url + "/api/files/diff?path=README.md");
    expect(diff.status).toBe(200);
    const diffPayload = (await diff.json()) as { path?: unknown; diff?: unknown };
    expect(diffPayload.path).toBe("README.md");
    expect(typeof diffPayload.diff).toBe("string");
    const invalid = await fetch(context.webServer.url + "/api/files/diff?path=../secrets.txt");
    expect(invalid.status).toBe(400);
  });

  test("lists the reviewed plugin marketplace and supports bounded filters", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    const session = { sessionId: "marketplace-session", sessionFile: undefined, messages: [], isStreaming: false, subscribe: () => () => {} };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve(), abort: () => Promise.resolve(), dispose: () => Promise.resolve() } as never);
    context.provide("piModels", { model: { provider: "test", id: "model" }, runtime: { getModels: () => [], getModel: () => undefined } } as never);
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const response = await fetch(context.webServer.url + "/api/marketplace?q=timer&capability=scheduling&page=0&pageSize=1");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      items?: readonly { packageName?: unknown; status?: unknown }[];
      capabilities?: readonly unknown[];
      total?: number;
      page?: number;
      pageSize?: number;
      hasNext?: boolean;
    };
    expect(payload.items).toHaveLength(1);
    expect(payload.items?.[0]).toMatchObject({ packageName: "@deepseek-ai/cordis-plugin-timer", status: "verified" });
    expect(payload).toMatchObject({ total: 1, page: 0, pageSize: 1, hasNext: false });
    expect(payload.capabilities).toContain("scheduling");
    const tooLong = await fetch(context.webServer.url + "/api/marketplace?q=" + "x".repeat(121));
    expect(tooLong.status).toBe(400);
    const invalidPage = await fetch(context.webServer.url + "/api/marketplace?page=-1");
    expect(invalidPage.status).toBe(400);
  });

  test("commits selected workspace files only after an explicit message", async () => {
    const context = new Context();
    contexts.push(context);
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-api-commit-"));
    await execFile("git", ["init", "-q"], { cwd: directory });
    await execFile("git", ["config", "user.email", "pi-harness@test.invalid"], { cwd: directory });
    await execFile("git", ["config", "user.name", "Pi Harness Test"], { cwd: directory });
    await writeFile(join(directory, "README.md"), "before\n", "utf8");
    await execFile("git", ["add", "README.md"], { cwd: directory });
    await execFile("git", ["commit", "-qm", "initial"], { cwd: directory });
    await writeFile(join(directory, "README.md"), "after\n", "utf8");
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    const session = { sessionId: "commit-session", sessionFile: undefined, messages: [], isStreaming: false, subscribe: () => () => {} };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve(), abort: () => Promise.resolve(), dispose: () => Promise.resolve() } as never);
    context.provide("piModels", { model: { provider: "test", id: "model" }, runtime: { getModels: () => [], getModel: () => undefined } } as never);
    context.provide("piHarnessLaunch", { cwd: directory, agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const missingMessage = await fetch(context.webServer.url + "/api/files/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["README.md"] }),
    });
    expect(missingMessage.status).toBe(400);
    const response = await fetch(context.webServer.url + "/api/files/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["README.md"], message: "Update README" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ committed: true, message: "Update README" });
    await expect(execFile("git", ["status", "--porcelain"], { cwd: directory })).resolves.toMatchObject({ stdout: "" });
  });

  test("rejects destructive workspace revert without explicit confirmation", async () => {
    const context = new Context();
    contexts.push(context);
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-api-revert-"));
    await execFile("git", ["init", "-q"], { cwd: directory });
    await writeFile(join(directory, "scratch.txt"), "discard me\n", "utf8");
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    const session = { sessionId: "revert-session", sessionFile: undefined, messages: [], isStreaming: false, subscribe: () => () => {} };
    context.provide("piRuntime", { session, prompt: () => Promise.resolve(), abort: () => Promise.resolve(), dispose: () => Promise.resolve() } as never);
    context.provide("piModels", { model: { provider: "test", id: "model" }, runtime: { getModels: () => [], getModel: () => undefined } } as never);
    context.provide("piHarnessLaunch", { cwd: directory, agentDir: "/tmp/agent", args: [], requestExit() {} });
    await context.plugin(apiPlugin);

    const response = await fetch(context.webServer.url + "/api/files/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["scratch.txt"] }),
    });
    expect(response.status).toBe(400);
  });
});
