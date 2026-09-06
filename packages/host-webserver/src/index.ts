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

export const DEFAULT_WEB_SERVER_PORT = 3141;

declare module "@deepseek-ai/cordis" {
  interface Context {
    webServer: WebServer;
  }
}

function normalizePath(path: string): string {
  if (!path.startsWith("/") || (path.length > 1 && path.endsWith("/"))) throw new Error("Web route path must be absolute without a trailing slash: " + path);
  return path;
}

function sendError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: message }));
}

function notFound(response: ServerResponse): void {
  sendError(response, 404, "Not found");
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "[::]"]);

interface Authority {
  readonly hostname: string;
  readonly port: number;
}

// Parses an http authority (Host header value, or an Origin with its "http://" prefix removed) into its lowercase hostname (IPv6 stays bracketed, as WHATWG URL reports it) and effective port. Returns undefined for anything that is not a bare authority.
function parseHttpAuthority(value: string): Authority | undefined {
  let url: URL;
  try {
    url = new URL("http://" + value);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.hostname === "") return undefined;
  if (value.endsWith("/") || value.includes("?") || value.includes("#")) return undefined;
  return { hostname: url.hostname, port: url.port === "" ? 80 : Number(url.port) };
}

// Browsers send the Origin header on every cross-origin request and on all non-GET/HEAD requests, so requiring it to match the (already validated) Host header blocks cross-site requests from pages the user visits. Requests without an Origin header (same-origin navigations, EventSource, curl, Node fetch) pass. The Host check defeats DNS rebinding: a page on attacker.example that resolves to 127.0.0.1 arrives with Host: attacker.example, which is neither loopback nor the configured bind host.
function rejectForeignRequest(request: IncomingMessage, response: ServerResponse, configuredHost: string, boundPort: number): boolean {
  const hostHeader = request.headers.host;
  const authority = hostHeader === undefined ? undefined : parseHttpAuthority(hostHeader);
  if (authority === undefined) {
    sendError(response, 400, "Invalid Host header");
    return true;
  }
  const hostnameAllowed =
    WILDCARD_HOSTS.has(configuredHost) || LOOPBACK_HOSTNAMES.has(authority.hostname) || authority.hostname === hostForUrl(configuredHost).toLowerCase();
  if (!hostnameAllowed || authority.port !== boundPort) {
    sendError(response, 400, "Host header does not match the web server address");
    return true;
  }
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  const originAuthority = origin.startsWith("http://") ? parseHttpAuthority(origin.slice("http://".length)) : undefined;
  if (originAuthority === undefined || originAuthority.hostname !== authority.hostname || originAuthority.port !== authority.port) {
    sendError(response, 403, "Cross-origin requests are not allowed");
    return true;
  }
  return false;
}

export default {
  name: "pi-webserver",
  async apply(context: Context, config: WebServerConfig) {
    const host = config.host ?? "127.0.0.1";
    const port = config.port ?? DEFAULT_WEB_SERVER_PORT;
    const routes = new Map<string, WebRoute["handler"]>();
    let fallback: WebRoute["handler"] | undefined;
    // Assigned once listen() completes; tests bind port 0 so the configured port is not the one clients address.
    let boundPort = 0;
    const server = createServer((request, response) => {
      if (rejectForeignRequest(request, response, host, boundPort)) return;
      const path = new URL(request.url ?? "/", "http://" + hostForUrl(host)).pathname;
      const handler = routes.get(path) ?? fallback;
      if (handler === undefined) {
        notFound(response);
        return;
      }
      // Invoke inside an async function so a synchronous throw is routed into the same 500 path as an async rejection instead of escaping the request listener as an uncaught exception.
      void (async () => handler(request, response))().catch((error: unknown) => {
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
    boundPort = address.port;
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
      close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
    context.provide("webServer", service);
    context.effect(() => async () => service.close());
  },
};
