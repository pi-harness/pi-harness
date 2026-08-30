import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { PiRuntimeService, PiModelsService, PiHarnessLaunch } from "@pi-harness/core";
import type { WebServer } from "@pi-harness/host-webserver";

interface ApiServices {
  readonly runtime: PiRuntimeService;
  readonly models: PiModelsService;
  readonly launch: PiHarnessLaunch;
  readonly webServer: WebServer;
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

function createStatus(services: ApiServices) {
  return {
    status: "ready",
    model: services.models.model.provider + "/" + services.models.model.id,
    messages: services.runtime.session.messages.length,
    cwd: services.launch.cwd,
    agentDir: services.launch.agentDir,
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
    };
    let busy = false;
    const disposeStatus = services.webServer.register({
      path: "/api/status",
      handler(_request, response) {
        sendJson(response, 200, createStatus(services));
      },
    });
    const disposePrompt = services.webServer.register({
      path: "/api/prompt",
      async handler(request, response) {
        if (busy) {
          sendJson(response, 409, { error: "Another prompt is already running" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { prompt?: unknown };
          if (typeof payload.prompt !== "string" || payload.prompt.trim().length === 0) {
            sendJson(response, 400, { error: "Prompt must be a non-empty string" });
            return;
          }
          busy = true;
          const chunks: string[] = [];
          const unsubscribe = services.runtime.session.subscribe((event) => {
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") chunks.push(event.assistantMessageEvent.delta);
          });
          try {
            await services.runtime.prompt(payload.prompt);
          } finally {
            unsubscribe();
            busy = false;
          }
          const last = services.runtime.session.messages.at(-1);
          if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
            sendJson(response, 502, { error: last.errorMessage ?? "Request " + last.stopReason });
            return;
          }
          sendJson(response, 200, { reply: chunks.join(""), messages: services.runtime.session.messages.length });
        } catch (error) {
          busy = false;
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeSession = services.webServer.register({
      path: "/api/session",
      handler(_request, response) {
        sendJson(response, 200, { messages: services.runtime.session.messages });
      },
    });
    context.effect(() => () => {
      disposeStatus();
      disposePrompt();
      disposeSession();
    });
  },
};
