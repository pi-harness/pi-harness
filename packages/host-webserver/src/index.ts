import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";

export interface WebRoute {
  readonly path: string;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

export interface WebServerConfig {
  readonly host?: string;
  readonly port?: number;
}

export interface WebServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  register(route: WebRoute): () => void;
  registerFallback(handler: WebRoute["handler"]): () => void;
  close(): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    webServer: WebServer;
  }
}

function normalizePath(path: string): string {
  if (!path.startsWith("/") || (path.length > 1 && path.endsWith("/"))) throw new Error("Web route path must be absolute without a trailing slash: " + path);
  return path;
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Not found" }));
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
}

export default {
  name: "pi-webserver",
  async apply(context: Context, config: WebServerConfig) {
    const host = config.host ?? "127.0.0.1";
    const port = config.port ?? 3080;
    const routes = new Map<string, WebRoute["handler"]>();
    let fallback: WebRoute["handler"] | undefined;
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://" + hostForUrl(host)).pathname;
      const handler = routes.get(path) ?? fallback;
      if (handler === undefined) {
        notFound(response);
        return;
      }
      void Promise.resolve(handler(request, response)).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Web server did not expose a TCP address");
    const service: WebServer = {
      host,
      port: address.port,
      url: "http://" + hostForUrl(host) + ":" + address.port,
      register(route) {
        const path = normalizePath(route.path);
        if (routes.has(path)) throw new Error("Web route already registered: " + path);
        routes.set(path, route.handler);
        return () => routes.delete(path);
      },
      registerFallback(handler) {
        if (fallback !== undefined) throw new Error("Web fallback is already registered");
        fallback = handler;
        return () => {
          if (fallback === handler) fallback = undefined;
        };
      },
      close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
    context.provide("webServer", service);
    context.effect(() => async () => service.close());
  },
};
