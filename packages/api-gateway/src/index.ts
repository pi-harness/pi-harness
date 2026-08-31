import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type Loader from "@deepseek-ai/cordis-plugin-loader";
import type { PiRuntimeService, PiModelsService, PiHarnessLaunch } from "@pi-harness/core";
import type { WebServer } from "@pi-harness/host-webserver";
import { MARKETPLACE_CAPABILITIES, searchMarketplace } from "./marketplace.js";

interface ApiServices {
  readonly runtime: PiRuntimeService;
  readonly models: PiModelsService;
  readonly launch: PiHarnessLaunch;
  readonly webServer: WebServer;
  readonly loader: Loader | undefined;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function bodyText(request: IncomingMessage): Promise<string> {
  const chunks: string[] = [];
  let length = 0;
  for await (const chunk of request) {
    const input: string | Uint8Array = chunk as string | Uint8Array;
    const value = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
    length += Buffer.byteLength(value);
    if (length > 64 * 1024) throw new Error("Request body is too large");
    chunks.push(value);
  }
  return chunks.join("");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return Object.prototype.toString.call(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item, seen)]));
}

function createStatus(services: ApiServices, events: readonly AgentSessionEvent[]) {
  const activeModel = services.runtime.session.model ?? services.models.model;
  return {
    status: services.runtime.session.isStreaming ? "running" : "ready",
    model: activeModel.provider + "/" + activeModel.id,
    messages: services.runtime.session.messages.length,
    events: events.length,
    sessionId: services.runtime.session.sessionId,
    sessionFile: services.runtime.session.sessionFile,
    cwd: services.launch.cwd,
    agentDir: services.launch.agentDir,
    plugins: services.loader ? [...services.loader.entries()].filter((entry) => !entry.disabled).map((entry) => entry.options.name) : [],
  };
}

function modelSummary(model: { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number }, active: boolean) {
  return { provider: model.provider, id: model.id, name: model.name ?? model.id, reasoning: model.reasoning ?? false, contextWindow: model.contextWindow ?? null, active };
}

function pluginSummary(entry: { options: { id: string; name: string; disabled?: boolean | null }; fiber?: { state: unknown } }) {
  const states = ["pending", "loading", "active", "failed", "disposed", "unloading"];
  const rawState = entry.fiber?.state;
  const state = typeof rawState === "number" ? states[rawState] ?? String(rawState) : typeof rawState === "string" ? rawState : rawState === undefined || rawState === null ? "unloaded" : "unknown";
  return { id: entry.options.id, name: entry.options.name, enabled: !entry.options.disabled, state };
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(jsonSafe(payload))}\n\n`);
}

function gitStatus(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["status", "--short", "--untracked-files=all"], { cwd, maxBuffer: 512 * 1024 }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

function gitDiff(cwd: string, path: string): Promise<string> {
  return new Promise((resolveOutput) => {
    execFile("git", ["diff", "--no-ext-diff", "--", path], { cwd, maxBuffer: 1024 * 1024 }, (error, stdout) => resolveOutput(error && stdout.length === 0 ? "" : stdout));
  });
}

function gitCommand(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveResult) => {
    execFile("git", [...args], { cwd, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolveResult({ stdout, stderr, code });
    });
  });
}

function workspacePaths(root: string, paths: unknown): string[] | Error {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || path.trim() === "")) return new Error("paths must be a non-empty array of strings");
  const normalized: string[] = [];
  for (const path of paths) {
    const requested = path as string;
    const absolute = resolve(root, requested);
    const relativePath = relative(root, absolute);
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith("../")) return new Error("path must stay inside the workspace");
    normalized.push(relativePath);
  }
  return [...new Set(normalized)];
}

export default {
  name: "pi-api-gateway",
  inject: ["webServer", "piRuntime", "piModels", "piHarnessLaunch"],
  apply(context: Context) {
    const services: ApiServices = {
      runtime: context.piRuntime,
      models: context.piModels,
      launch: context.piHarnessLaunch,
      webServer: context.webServer,
      loader: context.reflect.get("loader") as Loader | undefined,
    };
    let busy = false;
    const events: AgentSessionEvent[] = [];
    const eventClients = new Set<ServerResponse>();
    const handleEvent = (event: AgentSessionEvent) => {
      events.push(event);
      for (const response of eventClients) {
        if (response.writableEnded || response.destroyed) {
          eventClients.delete(response);
          continue;
        }
        writeSse(response, { type: "event", event });
      }
    };
    const unsubscribeEvents = services.runtime.sessionRuntime
      ? context.on("pi/session-event", handleEvent)
      : services.runtime.session.subscribe(handleEvent);
    const disposeStatus = services.webServer.register({
      path: "/api/status",
      handler(_request, response) {
        sendJson(response, 200, createStatus(services, events));
      },
    });
    const disposeModels = services.webServer.register({
      path: "/api/models",
      handler(_request, response) {
        const active = services.runtime.session.model ?? services.models.model;
        sendJson(response, 200, jsonSafe({ items: services.models.runtime.getModels().map((model) => modelSummary(model, model.provider === active.provider && model.id === active.id)) }));
      },
    });
    const disposeProviders = services.webServer.register({
      path: "/api/providers",
      handler(_request, response) {
        const active = services.runtime.session.model ?? services.models.model;
        const runtime = services.models.runtime as typeof services.models.runtime & { getProviders?: () => readonly { id: string; name?: string }[]; getProviderAuthStatus?: (provider: string) => unknown };
        const providers = typeof runtime.getProviders === "function" ? runtime.getProviders() : [{ id: active.provider, name: active.provider }];
        const visible = providers.filter((provider) => {
          if (provider.id === active.provider) return true;
          if (typeof runtime.getProviderAuthStatus !== "function") return false;
          const auth = runtime.getProviderAuthStatus(provider.id);
          return typeof auth === "object" && auth !== null && (auth as { configured?: unknown }).configured === true;
        });
        sendJson(response, 200, jsonSafe({ items: visible.map((provider) => ({ provider: provider.id, name: provider.name ?? provider.id, active: provider.id === active.provider, auth: typeof runtime.getProviderAuthStatus === "function" ? runtime.getProviderAuthStatus(provider.id) : undefined, activeModel: provider.id === active.provider ? modelSummary(active, true) : undefined, models: services.models.runtime.getModels(provider.id).map((model) => modelSummary(model, model.provider === active.provider && model.id === active.id)) })) }));
      },
    });
    const disposeProviderTest = services.webServer.register({
      path: "/api/providers/test",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { provider?: unknown };
          if (typeof payload.provider !== "string" || payload.provider.trim() === "") {
            sendJson(response, 400, { error: "provider is required" });
            return;
          }
          const runtime = services.models.runtime as typeof services.models.runtime & { checkAuth?: (provider: string) => Promise<unknown> };
          if (typeof runtime.checkAuth !== "function") {
            sendJson(response, 501, { error: "The active model runtime does not support provider checks" });
            return;
          }
          const auth = await runtime.checkAuth(payload.provider);
          sendJson(response, 200, jsonSafe({ provider: payload.provider, reachable: auth !== undefined, auth }));
        } catch (error) {
          sendJson(response, 502, { error: errorText(error) });
        }
      },
    });
    const disposeProviderRefresh = services.webServer.register({
      path: "/api/providers/refresh",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { provider?: unknown };
          if (typeof payload.provider !== "string" || payload.provider.trim() === "") {
            sendJson(response, 400, { error: "provider is required" });
            return;
          }
          const runtime = services.models.runtime as typeof services.models.runtime & { getAvailable?: (provider: string) => Promise<readonly unknown[]> };
          if (typeof runtime.getAvailable !== "function") {
            sendJson(response, 501, { error: "The active model runtime does not support provider refresh" });
            return;
          }
          const models = await runtime.getAvailable(payload.provider);
          sendJson(response, 200, jsonSafe({ provider: payload.provider, models }));
        } catch (error) {
          sendJson(response, 502, { error: errorText(error) });
        }
      },
    });
    const disposePlugins = services.webServer.register({
      path: "/api/plugins",
      handler(_request, response) {
        const items = services.loader ? [...services.loader.entries()].map(pluginSummary) : [];
        sendJson(response, 200, jsonSafe({ items }));
      },
    });
    const disposeMarketplace = services.webServer.register({
      path: "/api/marketplace",
      handler(request, response) {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const url = new URL(request.url ?? "/api/marketplace", "http://localhost");
        const query = url.searchParams.get("q") ?? "";
        const capability = url.searchParams.get("capability") ?? "";
        if (query.length > 120 || capability.length > 80) {
          sendJson(response, 400, { error: "Marketplace filters are too long" });
          return;
        }
        sendJson(response, 200, { items: searchMarketplace(query, capability), capabilities: MARKETPLACE_CAPABILITIES });
      },
    });
    const disposeCommands = services.webServer.register({
      path: "/api/commands",
      handler(_request, response) {
        const commands = services.runtime.session.extensionRunner.getRegisteredCommands();
        const items = commands.map((command) => ({ name: command.name, invocationName: command.invocationName, description: command.description, source: command.sourceInfo.path }));
        sendJson(response, 200, jsonSafe({ items }));
      },
    });
    const disposeModel = services.webServer.register({
      path: "/api/model",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (services.runtime.session.isStreaming) {
          sendJson(response, 409, { error: "Cannot change model while a prompt is running" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { provider?: unknown; model?: unknown };
          if (typeof payload.provider !== "string" || typeof payload.model !== "string" || payload.provider.trim() === "" || payload.model.trim() === "") {
            sendJson(response, 400, { error: "provider and model are required" });
            return;
          }
          const model = services.models.runtime.getModel(payload.provider, payload.model);
          if (model === undefined) {
            sendJson(response, 404, { error: `Model not found: ${payload.provider}/${payload.model}` });
            return;
          }
          if (typeof services.runtime.session.setModel !== "function") {
            sendJson(response, 501, { error: "The active Pi session does not support model switching" });
            return;
          }
          await services.runtime.session.setModel(model);
          sendJson(response, 200, jsonSafe({ model: modelSummary(model, true) }));
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeFiles = services.webServer.register({
      path: "/api/files",
      async handler(_request, response) {
        const output = await gitStatus(services.launch.cwd);
        const items = output.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0).map((line) => {
          const status = line.slice(0, 2).trim() || "??";
          return { path: line.slice(3), status, label: status === "??" ? "untracked" : status.includes("D") ? "deleted" : status.includes("A") ? "added" : "modified" };
        });
        sendJson(response, 200, { items });
      },
    });
    const disposeFileDiff = services.webServer.register({
      path: "/api/files/diff",
      async handler(request, response) {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const url = new URL(request.url ?? "/api/files/diff", "http://localhost");
        const requested = url.searchParams.get("path");
        if (requested === null || requested.trim() === "") {
          sendJson(response, 400, { error: "path is required" });
          return;
        }
        const root = resolve(services.launch.cwd);
        const absolute = resolve(root, requested);
        const relativePath = relative(root, absolute);
        if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(".." + "/")) {
          sendJson(response, 400, { error: "path must stay inside the workspace" });
          return;
        }
        sendJson(response, 200, { path: relativePath, diff: await gitDiff(root, relativePath) });
      },
    });
    const disposeFileCommit = services.webServer.register({
      path: "/api/files/commit",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { paths?: unknown; message?: unknown };
          const paths = workspacePaths(resolve(services.launch.cwd), payload.paths);
          if (paths instanceof Error) {
            sendJson(response, 400, { error: paths.message });
            return;
          }
          if (typeof payload.message !== "string" || payload.message.trim() === "") {
            sendJson(response, 400, { error: "message is required" });
            return;
          }
          const root = resolve(services.launch.cwd);
          const add = await gitCommand(root, ["add", "-A", "--", ...paths]);
          if (add.code !== 0) {
            sendJson(response, 409, { error: add.stderr.trim() || "Unable to stage workspace files" });
            return;
          }
          const commit = await gitCommand(root, ["commit", "-m", payload.message.trim(), "--", ...paths]);
          if (commit.code !== 0) {
            sendJson(response, 409, { error: commit.stdout.trim() || commit.stderr.trim() || "Nothing to commit" });
            return;
          }
          const head = await gitCommand(root, ["rev-parse", "--short", "HEAD"]);
          sendJson(response, 200, { committed: true, message: payload.message.trim(), commit: head.stdout.trim() });
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeFileRevert = services.webServer.register({
      path: "/api/files/revert",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { paths?: unknown; confirm?: unknown };
          if (payload.confirm !== true) {
            sendJson(response, 400, { error: "confirm must be true to discard workspace changes" });
            return;
          }
          const root = resolve(services.launch.cwd);
          const paths = workspacePaths(root, payload.paths);
          if (paths instanceof Error) {
            sendJson(response, 400, { error: paths.message });
            return;
          }
          const untracked = await gitCommand(root, ["ls-files", "--others", "--exclude-standard", "--", ...paths]);
          const restore = await gitCommand(root, ["restore", "--worktree", "--staged", "--", ...paths]);
          if (restore.code !== 0 && !restore.stderr.includes("pathspec")) {
            sendJson(response, 409, { error: restore.stderr.trim() || "Unable to restore workspace files" });
            return;
          }
          for (const path of untracked.stdout.split("\n").map((item) => item.trim()).filter(Boolean)) {
            await rm(resolve(root, path), { recursive: true, force: true });
          }
          sendJson(response, 200, { reverted: true, paths });
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeEvents = services.webServer.register({
      path: "/api/events",
      handler(_request, response) {
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        writeSse(response, { type: "snapshot", sessionId: services.runtime.session.sessionId, events });
        eventClients.add(response);
        const heartbeat = setInterval(() => {
          if (response.writableEnded || response.destroyed) {
            clearInterval(heartbeat);
            eventClients.delete(response);
            return;
          }
          response.write(": heartbeat\n\n");
        }, 15_000);
        response.on("close", () => {
          clearInterval(heartbeat);
          eventClients.delete(response);
        });
      },
    });
    const disposePrompt = services.webServer.register({
      path: "/api/prompt",
      async handler(request, response) {
        if (busy) {
          sendJson(response, 409, { error: "Another prompt is already running" });
          return;
        }
        busy = true;
        let unsubscribe: (() => void) | undefined;
        try {
          const payload = JSON.parse(await bodyText(request)) as { prompt?: unknown };
          if (typeof payload.prompt !== "string" || payload.prompt.trim().length === 0) {
            sendJson(response, 400, { error: "Prompt must be a non-empty string" });
            return;
          }
          const chunks: string[] = [];
          unsubscribe = services.runtime.session.subscribe((event) => {
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") chunks.push(event.assistantMessageEvent.delta);
          });
          await services.runtime.prompt(payload.prompt);
          const last = services.runtime.session.messages.at(-1);
          if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
            sendJson(response, 502, { error: last.errorMessage ?? "Request " + last.stopReason });
            return;
          }
          sendJson(response, 200, { reply: chunks.join(""), messages: services.runtime.session.messages.length });
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        } finally {
          unsubscribe?.();
          busy = false;
        }
      },
    });
    const disposeAbort = services.webServer.register({
      path: "/api/abort",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const wasStreaming = services.runtime.session.isStreaming;
          await services.runtime.abort();
          sendJson(response, 200, { aborted: wasStreaming });
        } catch (error) {
          sendJson(response, 500, { error: errorText(error) });
        }
      },
    });
    const disposeSession = services.webServer.register({
      path: "/api/session",
      handler(_request, response) {
        const session = services.runtime.session;
        const sessionManager = session.sessionManager;
        sendJson(response, 200, jsonSafe({
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
          messages: session.messages,
          entries: typeof sessionManager?.getEntries === "function" ? sessionManager.getEntries() : [],
          events,
        }));
      },
    });
    const disposeNewSession = services.webServer.register({
      path: "/api/session/new",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (services.runtime.session.isStreaming) {
          sendJson(response, 409, { error: "Cannot create a session while a prompt is running" });
          return;
        }
        try {
          if (services.runtime.sessionRuntime) {
            const result = await services.runtime.sessionRuntime.newSession();
            if (result.cancelled) {
              sendJson(response, 409, { error: "Session creation was cancelled by an extension" });
              return;
            }
          }
          else {
            const session = services.runtime.session;
            session.sessionManager.newSession();
            session.agent.state.messages = [];
          }
          events.length = 0;
          const session = services.runtime.session;
          for (const client of eventClients) writeSse(client, { type: "session", sessionId: session.sessionId, events: [] });
          sendJson(response, 200, jsonSafe({ sessionId: session.sessionId, sessionFile: session.sessionFile, messages: services.runtime.sessionRuntime ? session.messages : [], events: [] }));
        } catch (error) {
          sendJson(response, 500, { error: errorText(error) });
        }
      },
    });
    const disposeOpenSession = services.webServer.register({
      path: "/api/session/open",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (services.runtime.session.isStreaming) {
          sendJson(response, 409, { error: "Cannot switch sessions while a prompt is running" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { path?: unknown; sessionId?: unknown };
          const manager = services.runtime.session.sessionManager;
          if (!manager.isPersisted()) {
            sendJson(response, 409, { error: "Session switching requires JSONL session storage" });
            return;
          }
          const items = await SessionManager.list(services.launch.cwd, manager.getSessionDir());
          const target = items.find((item) => (typeof payload.path === "string" && item.path === payload.path) || (typeof payload.sessionId === "string" && item.id === payload.sessionId));
          if (target === undefined) {
            sendJson(response, 404, { error: "Session not found" });
            return;
          }
          if (services.runtime.sessionRuntime) {
            const result = await services.runtime.sessionRuntime.switchSession(target.path, { cwdOverride: target.cwd });
            if (result.cancelled) {
              sendJson(response, 409, { error: "Session switch was cancelled by an extension" });
              return;
            }
          }
          else {
            manager.setSessionFile(target.path);
            if (typeof services.runtime.session.reload === "function") await services.runtime.session.reload();
            else services.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
          }
          events.length = 0;
          for (const client of eventClients) writeSse(client, { type: "session", sessionId: services.runtime.session.sessionId, events: [] });
          sendJson(response, 200, jsonSafe({ sessionId: services.runtime.session.sessionId, sessionFile: services.runtime.session.sessionFile, messages: services.runtime.session.messages, events: [] }));
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeSessions = services.webServer.register({
      path: "/api/sessions",
      async handler(_request, response) {
        try {
          const session = services.runtime.session;
          const manager = session.sessionManager;
          const items = typeof manager.isPersisted === "function" && manager.isPersisted()
            ? await SessionManager.list(services.launch.cwd, manager.getSessionDir())
            : [];
          sendJson(response, 200, jsonSafe({ items: items.map((item) => ({ sessionId: item.id, path: item.path, name: item.name, cwd: item.cwd, created: item.created, modified: item.modified, messageCount: item.messageCount, firstMessage: item.firstMessage })) }));
        } catch (error) {
          sendJson(response, 500, { error: errorText(error) });
        }
      },
    });
    context.effect(() => () => {
      disposeStatus();
      disposeEvents();
      disposeModels();
      disposeProviders();
      disposeProviderTest();
      disposeProviderRefresh();
      disposePlugins();
      disposeMarketplace();
      disposeCommands();
      disposeModel();
      disposeFiles();
      disposeFileDiff();
      disposeFileCommit();
      disposeFileRevert();
      disposePrompt();
      disposeAbort();
      disposeSession();
      disposeNewSession();
      disposeOpenSession();
      disposeSessions();
      unsubscribeEvents();
      for (const response of eventClients) response.end();
      eventClients.clear();
    });
  },
};
