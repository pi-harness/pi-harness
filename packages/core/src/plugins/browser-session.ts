import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;
type BrowserTab = { targetId: string; title: string; url: string; type: string; webSocketDebuggerUrl?: string };
type BrowserSessionResult = {
  targetId: string;
  url: string;
  title: string;
  status?: string;
  truncated?: boolean;
  text?: string;
  clicked?: boolean;
  screenshot?: { data: string; mimeType: string };
};

const requestTimeoutMs = 15_000;
const maxTextBytes = 128 * 1024;
const maxSelectorLength = 512;

function endpointUrl(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Browser session endpoint is invalid");
  }
  const host = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (endpoint.protocol !== "http:" || (host !== "localhost" && host !== "127.0.0.1" && host !== "::1"))
    throw new Error("Browser session endpoint must be a local http://localhost, 127.0.0.1, or ::1 address");
  endpoint.pathname = endpoint.pathname.replace(/\/$/, "");
  return endpoint;
}

async function tabs(endpoint: URL): Promise<BrowserTab[]> {
  const response = await fetch(new URL("/json/list", endpoint));
  if (!response.ok) throw new Error(`Chrome DevTools returned HTTP ${response.status}`);
  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) throw new Error("Chrome DevTools returned an invalid tab list");
  return payload
    .filter((tab): tab is BrowserTab => typeof tab === "object" && tab !== null && typeof (tab as JsonObject).id === "string")
    .map((tab) => {
      const item = tab as JsonObject;
      return {
        targetId: String(item.id),
        title: typeof item.title === "string" ? item.title : "",
        url: typeof item.url === "string" ? item.url : "",
        type: typeof item.type === "string" ? item.type : "",
        ...(typeof item.webSocketDebuggerUrl === "string" ? { webSocketDebuggerUrl: item.webSocketDebuggerUrl } : {}),
      };
    });
}

async function target(endpoint: URL, targetId: string): Promise<BrowserTab> {
  const tab = (await tabs(endpoint)).find((item) => item.targetId === targetId);
  if (tab === undefined) throw new Error(`Browser tab was not found: ${targetId}`);
  if (tab.webSocketDebuggerUrl === undefined) throw new Error(`Browser tab is not debuggable: ${targetId}`);
  return tab;
}

async function cdp(tab: BrowserTab, method: string, params?: JsonObject): Promise<JsonObject> {
  if (tab.webSocketDebuggerUrl === undefined) throw new Error(`Browser tab is not debuggable: ${tab.targetId}`);
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    const id = 1;
    const timer = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error(`Chrome DevTools request timed out: ${method}`));
    }, requestTimeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const onOpen = (): void => {
      socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
    };
    const onMessage = (event: MessageEvent): void => {
      let message: unknown;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null || (message as JsonObject).id !== id) return;
      cleanup();
      socket.close();
      const payload = message as JsonObject;
      if (typeof payload.error === "object" && payload.error !== null)
        reject(new Error(String((payload.error as JsonObject).message ?? "Chrome DevTools request failed")));
      else if (typeof payload.result === "object" && payload.result !== null) resolve(payload.result as JsonObject);
      else reject(new Error("Chrome DevTools returned an invalid response"));
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Could not connect to the Chrome DevTools tab"));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Chrome DevTools tab connection closed before responding"));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function resultValue(result: JsonObject): unknown {
  const exception = result.exceptionDetails;
  if (exception !== undefined)
    throw new Error(
      typeof exception === "object" && exception !== null ? String((exception as JsonObject).text ?? "Page evaluation failed") : "Page evaluation failed",
    );
  const value = result.result;
  if (typeof value !== "object" || value === null) throw new Error("Page evaluation returned no value");
  return (value as JsonObject).value;
}

async function ready(endpoint: URL, tab: BrowserTab): Promise<void> {
  const deadline = Date.now() + requestTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await cdp(tab, "Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (resultValue(result) === "complete" || resultValue(result) === "interactive") return;
    } catch {
      // The navigation may replace the target briefly; poll until it is ready or the deadline expires.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Browser navigation did not become ready within 15 seconds");
}

async function evaluate(tab: BrowserTab, expression: string): Promise<unknown> {
  const result = await cdp(tab, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return resultValue(result);
}

export interface BrowserSessionPluginConfig {
  endpoint?: string;
}

export const Config: z<BrowserSessionPluginConfig> = z.object({ endpoint: z.string().default("http://127.0.0.1:9222") });

export default {
  name: "pi-browser-session",
  inject: ["piPluginUi", "piTools"],
  Config,
  async apply(context: Context, config: BrowserSessionPluginConfig) {
    const endpoint = endpointUrl(config.endpoint ?? "http://127.0.0.1:9222");
    let latest: BrowserSessionResult | undefined;
    const listTabs = async (): Promise<BrowserTab[]> => tabs(endpoint);
    const getTab = async (targetId: string): Promise<BrowserTab> => target(endpoint, targetId);
    const unregisterTabs = context.piTools.register(
      defineTool({
        name: "browser_tabs",
        label: "Browser tabs",
        description: "List pages in an already-running local Chrome DevTools session.",
        promptSnippet: "list tabs in the connected local browser",
        parameters: Type.Object({}),
        async execute(_toolCallId): Promise<AgentToolResult<{ tabs: BrowserTab[] }>> {
          const items = (await listTabs()).filter((tab) => tab.type === "page");
          return {
            content: [{ type: "text", text: items.map((tab) => `${tab.targetId} ${tab.title} ${tab.url}`).join("\n") || "No browser pages are open." }],
            details: { tabs: items },
          };
        },
      }),
    );
    const unregisterNavigate = context.piTools.register(
      defineTool({
        name: "browser_navigate",
        label: "Browser navigate",
        description: "Navigate a connected browser tab to an HTTP or HTTPS URL.",
        promptSnippet: "navigate the connected browser tab",
        parameters: Type.Object({ targetId: Type.String(), url: Type.String() }),
        async execute(_toolCallId, params): Promise<AgentToolResult<BrowserSessionResult>> {
          const url = new URL(params.url);
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Browser navigation only supports http and https URLs");
          const tab = await getTab(params.targetId);
          await cdp(tab, "Page.enable");
          await cdp(tab, "Page.navigate", { url: url.toString() });
          await ready(endpoint, { ...tab, url: url.toString() });
          latest = { targetId: tab.targetId, url: url.toString(), title: tab.title };
          return { content: [{ type: "text", text: `Navigated to ${url.toString()}` }], details: { ...latest, status: "navigated" } };
        },
      }),
    );
    const unregisterRead = context.piTools.register(
      defineTool({
        name: "browser_read",
        label: "Browser read",
        description: "Read bounded visible text from a connected browser tab.",
        promptSnippet: "read visible text from the connected browser tab",
        parameters: Type.Object({ targetId: Type.String() }),
        async execute(_toolCallId, params): Promise<AgentToolResult<BrowserSessionResult>> {
          const tab = await getTab(params.targetId);
          const value = await evaluate(tab, "document.body?.innerText ?? ''");
          const text = String(value ?? "");
          const bytes = Buffer.byteLength(text, "utf8");
          const bounded = Buffer.from(text, "utf8").subarray(0, maxTextBytes).toString("utf8");
          latest = { targetId: tab.targetId, url: tab.url, title: tab.title, text: bounded };
          return { content: [{ type: "text", text: bounded }], details: { ...latest, truncated: bytes > maxTextBytes } };
        },
      }),
    );
    const unregisterClick = context.piTools.register(
      defineTool({
        name: "browser_click",
        label: "Browser click",
        description: "Click one visible HTML element in a connected browser tab by CSS selector.",
        promptSnippet: "click a page element in the connected browser",
        parameters: Type.Object({ targetId: Type.String(), selector: Type.String() }),
        async execute(_toolCallId, params): Promise<AgentToolResult<BrowserSessionResult>> {
          if (params.selector.length === 0 || params.selector.length > maxSelectorLength)
            throw new Error("Browser selector must be between 1 and 512 characters");
          const tab = await getTab(params.targetId);
          const selector = JSON.stringify(params.selector);
          const value = await evaluate(
            tab,
            `(() => { const element = document.querySelector(${selector}); if (!(element instanceof HTMLElement)) throw new Error('Element was not found'); element.click(); return true; })()`,
          );
          if (value !== true) throw new Error("Browser click did not complete");
          latest = { targetId: tab.targetId, url: tab.url, title: tab.title, clicked: true };
          return { content: [{ type: "text", text: `Clicked ${params.selector}` }], details: latest };
        },
      }),
    );
    const unregisterScreenshot = context.piTools.register(
      defineTool({
        name: "browser_screenshot",
        label: "Browser screenshot",
        description: "Capture the visible viewport of a connected browser tab as PNG.",
        promptSnippet: "capture a screenshot of the connected browser tab",
        parameters: Type.Object({ targetId: Type.String() }),
        async execute(_toolCallId, params): Promise<AgentToolResult<BrowserSessionResult>> {
          const tab = await getTab(params.targetId);
          const result = await cdp(tab, "Page.captureScreenshot", { format: "png" });
          const data = typeof result.data === "string" ? result.data : "";
          if (data === "") throw new Error("Chrome DevTools returned an empty screenshot");
          latest = { targetId: tab.targetId, url: tab.url, title: tab.title, screenshot: { data, mimeType: "image/png" } };
          return { content: [{ type: "image", data, mimeType: "image/png" }], details: latest };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "browser-session-panel",
      pluginId: "@pi-harness/core/plugins/browser-session",
      title: "Browser Session",
      description: "通过 Chrome DevTools Protocol 连接已启动的本地浏览器。",
      icon: "◉",
      read: async () => {
        try {
          return {
            endpoint: endpoint.toString(),
            tabs: (await listTabs()).filter((tab) => tab.type === "page").map((tab) => ({ targetId: tab.targetId, title: tab.title, url: tab.url })),
            latest: latest ?? null,
            connected: true,
            error: null,
          };
        } catch (error) {
          return {
            endpoint: endpoint.toString(),
            tabs: [],
            latest: latest ?? null,
            connected: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
    context.effect(() => () => {
      unregisterTabs();
      unregisterNavigate();
      unregisterRead();
      unregisterClick();
      unregisterScreenshot();
      disposePanel();
    });
  },
};
