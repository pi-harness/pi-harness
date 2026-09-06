import { createReadStream, existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, type PlatformPath } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import "@pi-harness/host-webserver";

export interface WebAppConfig {
  readonly staticDir?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

type ContainmentPath = Pick<PlatformPath, "isAbsolute" | "relative" | "sep">;
const platformPath: ContainmentPath = { isAbsolute, relative, sep };

// Containment is decided with path.relative instead of a "/"-prefixed string compare so backslash-separated Windows paths and other drives are handled; the pathApi parameter exists so tests can exercise path.win32 on any host.
export function isInsideStaticRoot(root: string, candidate: string, pathApi: ContainmentPath = platformPath): boolean {
  const remainder = pathApi.relative(root, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(".." + pathApi.sep) && !pathApi.isAbsolute(remainder));
}

function safePath(root: string, pathname: string): string | undefined {
  const candidate = resolve(root, "." + pathname);
  if (!isInsideStaticRoot(root, candidate)) return undefined;
  return candidate;
}

async function sendFile(path: string, response: ServerResponse): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Not a file");
  response.writeHead(200, { "content-type": contentType(path), "content-length": info.size, "cache-control": "no-cache" });
  await pipeline(createReadStream(path), response);
}

async function sendSafeFile(root: string, path: string, response: ServerResponse): Promise<void> {
  const [rootReal, pathReal] = await Promise.all([realpath(root), realpath(path)]);
  if (!isInsideStaticRoot(rootReal, pathReal)) throw new Error("Static file escapes web root");
  await sendFile(pathReal, response);
}

export default {
  name: "pi-web-app",
  inject: ["webServer"],
  apply(context: Context, config: WebAppConfig) {
    const root = resolve(config.staticDir ?? "dist");
    if (!existsSync(root)) throw new Error("Web frontend dist does not exist: " + root);
    const dispose = context.webServer.registerFallback(async (request: IncomingMessage, response: ServerResponse) => {
      const requestPath = new URL(request.url ?? "/", context.webServer.url).pathname;
      const requested = safePath(root, requestPath);
      const index = join(root, "index.html");
      if (requested !== undefined) {
        try {
          await sendSafeFile(root, requested, response);
          return;
        } catch {
          // SPA fallback below.
        }
      }
      await sendSafeFile(root, index, response);
    });
    context.effect(() => dispose);
  },
};
