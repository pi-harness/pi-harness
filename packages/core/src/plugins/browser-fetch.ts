import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxResponseBytes = 512 * 1024;
const maxRedirects = 3;
const requestTimeoutMs = 20_000;

type BrowserFetchResult = { url: string; finalUrl: string; status: number; contentType: string; bytes: number; truncated: boolean; text: string };

function privateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function privateIp(address: string): boolean {
  if (isIP(address) === 4) return privateIpv4(address);
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:127.")
  );
}

async function validateTarget(rawUrl: string, allowPrivate: boolean): Promise<URL> {
  if (rawUrl.length === 0 || rawUrl.length > 4096) throw new Error("Browser URL must be between 1 and 4096 characters");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Browser URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Browser fetch only supports http and https URLs");
  if (url.username !== "" || url.password !== "") throw new Error("Browser URL must not contain credentials");
  if (!allowPrivate) {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.some(({ address }) => privateIp(address))) throw new Error("Browser fetch blocked a private or local network target");
  }
  return url;
}

async function readBody(response: Response): Promise<{ bytes: number; truncated: boolean; text: string }> {
  if (response.body === null) return { bytes: 0, truncated: false, text: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (bytes + chunk.byteLength > maxResponseBytes) {
        const remaining = maxResponseBytes - bytes;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        bytes = maxResponseBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes, truncated, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") };
}

async function fetchPage(rawUrl: string, allowPrivate: boolean): Promise<BrowserFetchResult> {
  let current = await validateTarget(rawUrl, allowPrivate);
  const original = current.toString();
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.1", "user-agent": "pi-harness-browser-fetch/0.1" },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Browser fetch timed out after 20 seconds", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) throw new Error(`Browser redirect ${response.status} has no Location header`);
      if (redirect === maxRedirects) throw new Error(`Browser fetch exceeded the ${maxRedirects}-redirect limit`);
      current = await validateTarget(new URL(location, current).toString(), allowPrivate);
      continue;
    }
    const body = await readBody(response);
    return {
      url: original,
      finalUrl: current.toString(),
      status: response.status,
      contentType: (response.headers.get("content-type") ?? "text/plain").split(";", 1)[0]!.trim(),
      ...body,
    };
  }
  throw new Error("Browser fetch did not produce a response");
}

export interface BrowserFetchPluginConfig {
  allowPrivate?: boolean;
}

export const Config: z<BrowserFetchPluginConfig> = z.object({ allowPrivate: z.boolean().default(false) });

export default {
  name: "pi-browser-fetch",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: BrowserFetchPluginConfig) {
    let latest: BrowserFetchResult | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "browser_fetch",
        label: "Browser fetch",
        description: "Fetch a public HTTP or HTTPS page as bounded text without executing page scripts.",
        promptSnippet: "fetch a public web page for inspection",
        parameters: Type.Object({ url: Type.String({ description: "HTTP or HTTPS URL" }) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<BrowserFetchResult>> {
          latest = await fetchPage(params.url, config.allowPrivate === true);
          return { content: [{ type: "text", text: latest.text }], details: latest };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "browser-fetch-panel",
      pluginId: "@pi-harness/core/plugins/browser-fetch",
      title: "Browser Fetch",
      description: "受限抓取公开网页文本，不执行页面脚本。",
      icon: "◎",
      read: () => ({ latest: latest ?? null, allowPrivate: config.allowPrivate === true, maxResponseBytes }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
