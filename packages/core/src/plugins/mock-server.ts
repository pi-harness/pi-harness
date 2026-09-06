import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type MockRoute = { path: string; method?: string; status?: number; headers?: Record<string, string>; body?: string };
type MockServerState = { running: boolean; url: string | null; routes: number; lastRequest: string | null; lastError: string | null };

const maxRoutes = 64;
const maxBodyBytes = 128 * 1024;
const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
// Node rejects header names outside the HTTP token grammar and header values outside the latin-1 printable range plus tab, so both are checked at apply time instead of inside the request listener.
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const headerValuePattern = /^[\t\x20-\x7e\x80-\xff]*$/u;

export interface MockServerPluginConfig {
  port?: number;
  routes?: MockRoute[];
}

const routeConfig = z.object({
  path: z.string(),
  method: z.string().default("GET"),
  status: z.number().default(200),
  headers: z.dict(z.string()).default({}),
  body: z.string().default(""),
});

export const Config: z<MockServerPluginConfig> = z.object({ port: z.number().default(0), routes: z.array(routeConfig).default([]) });

function normalizeRoutes(routes: MockRoute[]): MockRoute[] {
  if (routes.length > maxRoutes) throw new Error(`Mock server cannot exceed ${maxRoutes} routes`);
  return routes.map((route) => {
    const path = route.path.trim();
    if (!path.startsWith("/") || path.length > 2048 || path.includes("#")) throw new Error("Mock route path must start with / and be at most 2048 characters");
    const method = (route.method ?? "GET").trim().toUpperCase();
    if (!allowedMethods.has(method)) throw new Error(`Mock route method is not allowed: ${method}`);
    const status = route.status ?? 200;
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("Mock route status must be an integer between 100 and 599");
    const body = route.body ?? "";
    if (Buffer.byteLength(body, "utf8") > maxBodyBytes) throw new Error(`Mock route body cannot exceed ${maxBodyBytes} bytes`);
    const headers = Object.fromEntries(
      Object.entries(route.headers ?? {}).map(([name, rawValue]) => {
        const value = String(rawValue);
        if (!headerNamePattern.test(name)) throw new Error(`Mock route header name must be an HTTP token: ${name}`);
        if (!headerValuePattern.test(value)) throw new Error(`Mock route header value contains characters that are invalid in an HTTP header: ${name}`);
        return [name, value];
      }),
    );
    return { path, method, status, headers, body };
  });
}

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

// Request-listener failures reach the panel as text, so control characters are folded out and the message is bounded before it is stored.
function requestErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 500) || "Mock route failed";
}

export default {
  name: "pi-mock-server",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: MockServerPluginConfig) {
    const routes = normalizeRoutes(config.routes ?? []);
    let server: Server | undefined;
    let state: MockServerState = { running: false, url: null, routes: routes.length, lastRequest: null, lastError: null };
    const start = async (requestedPort?: number): Promise<MockServerState> => {
      if (server !== undefined) throw new Error("Mock server is already running");
      const port = requestedPort ?? config.port ?? 0;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Mock server port must be an integer between 0 and 65535");
      const routeMap = new Map(routes.map((route) => [routeKey(route.method ?? "GET", route.path), route]));
      server = createServer((request: IncomingMessage, response: ServerResponse) => {
        // A throw inside the request listener would surface as an uncaught exception and take the whole host down, so every response failure is answered with a 500 instead.
        try {
          const method = (request.method ?? "GET").toUpperCase();
          const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
          state = { ...state, lastRequest: routeKey(method, pathname), lastError: null };
          const route = routeMap.get(routeKey(method, pathname));
          if (route === undefined) {
            response.statusCode = 404;
            response.setHeader("content-type", "text/plain; charset=utf-8");
            response.end("Not found");
            return;
          }
          response.statusCode = route.status ?? 200;
          for (const [name, value] of Object.entries(route.headers ?? {})) response.setHeader(name, value);
          if (!response.hasHeader("content-type")) response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(route.body ?? "");
        } catch (error) {
          // Header validation now runs at apply time, so this catch is the only place a runtime failure can surface; recording it on the state the panel reads is what keeps the 500 from being silent.
          state = { ...state, lastError: requestErrorMessage(error) };
          if (response.writableEnded) return;
          if (!response.headersSent) {
            response.statusCode = 500;
            for (const name of response.getHeaderNames()) response.removeHeader(name);
            response.setHeader("content-type", "text/plain; charset=utf-8");
          }
          response.end("Mock route failed");
        }
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            server?.off("listening", onListening);
            reject(error);
          };
          const onListening = (): void => {
            server?.off("error", onError);
            resolve();
          };
          server!.once("error", onError);
          server!.once("listening", onListening);
          server!.listen(port, "127.0.0.1");
        });
      } catch (error) {
        const failed = server;
        server = undefined;
        failed?.close();
        throw error;
      }
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Mock server did not expose a TCP address");
      state = { ...state, running: true, url: `http://127.0.0.1:${address.port}` };
      return state;
    };
    const stop = async (): Promise<boolean> => {
      if (server === undefined) return false;
      const current = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())));
      state = { ...state, running: false, url: null };
      return true;
    };
    let unregisterStart: () => void = () => {};
    let unregisterStop: () => void = () => {};
    let unregisterStatus: () => void = () => {};
    try {
      unregisterStart = context.piTools.register(
        defineTool({
          name: "mock_server_start",
          label: "Mock server start",
          description: "Start a local deterministic HTTP mock server from configured routes.",
          promptSnippet: "start the local mock HTTP server",
          parameters: Type.Object(
            { port: Type.Optional(Type.Number({ description: "Bind port; 0 selects a free local port" })) },
            { additionalProperties: false },
          ),
          executionMode: "sequential",
          async execute(_toolCallId, params): Promise<AgentToolResult<MockServerState>> {
            const result = await start(params.port);
            return { content: [{ type: "text", text: `Mock server listening at ${result.url}` }], details: result };
          },
        }),
      );
      unregisterStop = context.piTools.register(
        defineTool({
          name: "mock_server_stop",
          label: "Mock server stop",
          description: "Stop the local HTTP mock server.",
          promptSnippet: "stop the local mock HTTP server",
          parameters: Type.Object({}, { additionalProperties: false }),
          executionMode: "sequential",
          async execute(): Promise<AgentToolResult<{ stopped: boolean }>> {
            const stopped = await stop();
            return { content: [{ type: "text", text: stopped ? "Mock server stopped." : "Mock server was not running." }], details: { stopped } };
          },
        }),
      );
      unregisterStatus = context.piTools.register(
        defineTool({
          name: "mock_server_status",
          label: "Mock server status",
          description: "Show local HTTP mock server status and route count.",
          promptSnippet: "check the local mock server status",
          parameters: Type.Object({}, { additionalProperties: false }),
          executionMode: "sequential",
          execute(): Promise<AgentToolResult<MockServerState>> {
            return Promise.resolve({ content: [{ type: "text", text: `${state.running ? "running" : "stopped"} ${state.url ?? ""}`.trim() }], details: state });
          },
        }),
      );
    } catch (error) {
      unregisterStart();
      unregisterStop();
      unregisterStatus();
      throw error;
    }
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "mock-server-panel",
        pluginId: "@pi-harness/core/plugins/mock-server",
        title: "Mock Server",
        description: "在本机回环地址提供可控的 HTTP mock 路由。",
        icon: "⇄",
        read: () => state,
      });
    } catch (error) {
      unregisterStart();
      unregisterStop();
      unregisterStatus();
      throw error;
    }
    context.effect(() => () => {
      unregisterStart();
      unregisterStop();
      unregisterStatus();
      disposePanel();
      void stop().catch(() => undefined);
    });
  },
};
