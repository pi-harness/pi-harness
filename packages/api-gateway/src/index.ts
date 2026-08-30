import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type Loader from "@deepseek-ai/cordis-plugin-loader";
import type { PiRuntimeService, PiModelsService, PiHarnessLaunch } from "@pi-harness/core";
import type { WebServer } from "@pi-harness/host-webserver";

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
  return {
    status: "ready",
    model: services.models.model.provider + "/" + services.models.model.id,
    messages: services.runtime.session.messages.length,
    events: events.length,
    sessionId: services.runtime.session.sessionId,
    sessionFile: services.runtime.session.sessionFile,
    cwd: services.launch.cwd,
    agentDir: services.launch.agentDir,
    plugins: services.loader ? [...services.loader.entries()].filter((entry) => !entry.disabled).map((entry) => entry.options.name) : [],
  };
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
    const unsubscribeEvents = services.runtime.session.subscribe((event) => {
      events.push(event);
    });
    const disposeStatus = services.webServer.register({
      path: "/api/status",
      handler(_request, response) {
        sendJson(response, 200, createStatus(services, events));
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
    context.effect(() => () => {
      disposeStatus();
      disposePrompt();
      disposeSession();
      unsubscribeEvents();
    });
  },
};
