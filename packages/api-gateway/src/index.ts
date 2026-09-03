import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import { SessionManager, type AgentSessionEvent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type Loader from "@deepseek-ai/cordis-plugin-loader";
import type { PiPluginUiRegistry, PiRuntimeService, PiModelsService, PiHarnessLaunch } from "@pi-harness/core";
import type { WebServer } from "@pi-harness/host-webserver";
import {
  MARKETPLACE_CAPABILITIES,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_PLUGINS,
  paginateMarketplace,
  searchMarketplace,
  needsMarketplacePackageInstall,
  type MarketplacePlugin,
} from "./marketplace.js";
import { parseGitWorktrees, type WorkspaceSummary } from "./workspaces.js";

interface ApiServices {
  readonly runtime: PiRuntimeService;
  readonly models: PiModelsService;
  readonly launch: PiHarnessLaunch;
  readonly webServer: WebServer;
  readonly loader: Loader | undefined;
  readonly pluginUi: PiPluginUiRegistry | undefined;
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
  const cwd = activeCwd(services);
  return {
    status: services.runtime.session.isStreaming ? "running" : "ready",
    model: activeModel.provider + "/" + activeModel.id,
    messages: services.runtime.session.messages.length,
    events: events.length,
    sessionId: services.runtime.session.sessionId,
    sessionFile: services.runtime.session.sessionFile,
    cwd,
    agentDir: services.launch.agentDir,
    plugins: services.loader ? [...services.loader.entries()].filter((entry) => !entry.disabled).map((entry) => entry.options.name) : [],
  };
}

function activeCwd(services: ApiServices): string {
  const runtimeCwd = services.runtime.sessionRuntime?.cwd;
  return typeof runtimeCwd === "string" && runtimeCwd.length > 0 ? runtimeCwd : services.launch.cwd;
}

function piConfig(services: ApiServices) {
  const settings = services.runtime.session.settingsManager;
  const global = settings.getGlobalSettings();
  const compaction = settings.getCompactionSettings();
  return {
    path: join(services.launch.agentDir, "settings.json"),
    scope: "global" as const,
    source: JSON.stringify(global, null, 2) + "\n",
    settings: {
      defaultProvider: global.defaultProvider,
      defaultModel: global.defaultModel,
      defaultThinkingLevel: global.defaultThinkingLevel,
      transport: settings.getTransport(),
      steeringMode: settings.getSteeringMode(),
      followUpMode: settings.getFollowUpMode(),
      hideThinkingBlock: settings.getHideThinkingBlock(),
      compaction,
      retry: settings.getRetrySettings(),
      terminal: {
        showImages: settings.getShowImages(),
        imageAutoResize: settings.getImageAutoResize(),
        autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
      },
      advanced: {
        quietStartup: settings.getQuietStartup(),
        projectTrust: settings.getDefaultProjectTrust(),
        showCacheMissNotices: settings.getShowCacheMissNotices(),
        enableAnalytics: settings.getEnableAnalytics(),
        enableInstallTelemetry: settings.getEnableInstallTelemetry(),
        shellPath: settings.getShellPath(),
        doubleEscapeAction: settings.getDoubleEscapeAction(),
        treeFilterMode: settings.getTreeFilterMode(),
        mermaid: settings.getMermaidRenderingMode(),
      },
    },
  };
}

interface SessionMetadata {
  readonly archived?: boolean;
  readonly pinned?: boolean;
}

type SessionMetadataMap = Record<string, SessionMetadata>;

function sessionMetadataFile(manager: SessionManager): string {
  return resolve(manager.getSessionDir(), ".pi-harness-session-meta.json");
}

async function readSessionMetadata(manager: SessionManager): Promise<SessionMetadataMap> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sessionMetadataFile(manager), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as SessionMetadataMap;
  } catch {
    return {};
  }
}

async function writeSessionMetadata(manager: SessionManager, metadata: SessionMetadataMap): Promise<void> {
  await mkdir(manager.getSessionDir(), { recursive: true });
  await writeFile(sessionMetadataFile(manager), JSON.stringify(metadata, null, 2) + "\n", "utf8");
}

function sessionPathInDirectory(path: string, manager: SessionManager): boolean {
  const root = resolve(manager.getSessionDir());
  const target = resolve(path);
  const relativePath = relative(root, target);
  return relativePath !== "" && !isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(".." + "/") && target.endsWith(".jsonl");
}

const webSessionUi = {
  select: (_title: string, options: string[]) => Promise.resolve(options[0]),
  confirm: () => Promise.resolve(true),
  input: () => Promise.resolve(undefined),
  notify: () => {},
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setWorkingVisible: () => {},
  setWorkingIndicator: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
} as unknown as ExtensionUIContext;

async function runWebSessionChange<T>(services: ApiServices, action: () => Promise<T & { cancelled: boolean }>): Promise<T & { cancelled: boolean }> {
  const runner = services.runtime.session.extensionRunner;
  runner.setUIContext(webSessionUi, "rpc");
  try {
    const result = await action();
    if (result.cancelled) runner.setUIContext(undefined, "print");
    return result;
  } catch (error) {
    runner.setUIContext(undefined, "print");
    throw error;
  }
}

function modelSummary(model: { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number }, active: boolean) {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    reasoning: model.reasoning ?? false,
    contextWindow: model.contextWindow ?? null,
    active,
  };
}

function visibleProviderIds(
  runtime: Pick<PiModelsService["runtime"], "getModels"> &
    Partial<Pick<PiModelsService["runtime"], "getProviders" | "getProviderAuthStatus" | "getRegisteredProviderConfig">>,
  activeProvider: string,
): Set<string> {
  const providers = typeof runtime.getProviders === "function" ? runtime.getProviders() : [{ id: activeProvider, name: activeProvider }];
  return new Set(
    providers
      .filter((provider) => {
        if (provider.id === activeProvider) return true;
        if (typeof runtime.getProviderAuthStatus !== "function") return false;
        const auth = runtime.getProviderAuthStatus(provider.id);
        if (typeof auth !== "object" || auth === null || (auth as { configured?: unknown }).configured !== true) return false;
        if (typeof runtime.getRegisteredProviderConfig === "function") return runtime.getRegisteredProviderConfig(provider.id) !== undefined;
        return true;
      })
      .map((provider) => provider.id),
  );
}

type LoaderEntrySummary = { options: { id: string; name: string; disabled?: boolean | null }; fiber?: { state: unknown } };

function marketplacePluginForEntry(entry: LoaderEntrySummary): MarketplacePlugin | undefined {
  return MARKETPLACE_PLUGINS.find((plugin) => plugin.packageName === entry.options.name);
}

function pluginSummary(entry: LoaderEntrySummary) {
  const states = ["pending", "loading", "active", "failed", "disposed", "unloading"];
  const marketplacePlugin = marketplacePluginForEntry(entry);
  const rawState = entry.fiber?.state;
  const state =
    typeof rawState === "number"
      ? (states[rawState] ?? String(rawState))
      : typeof rawState === "string"
        ? rawState
        : rawState === undefined || rawState === null
          ? "unloaded"
          : "unknown";
  return {
    id: entry.options.id,
    name: entry.options.name,
    enabled: !entry.options.disabled,
    state,
    removable: entry.options.id.startsWith("marketplace-") || marketplacePlugin !== undefined,
    category: marketplacePlugin?.category,
  };
}

function pluginLoaded(services: ApiServices, packageName: string): boolean {
  return services.loader !== undefined && [...services.loader.entries()].some((entry) => entry.options.name === packageName && !entry.disabled);
}

function registerPluginPanels(context: Context, services: ApiServices): () => void {
  if (services.pluginUi === undefined) return () => {};
  const disposers = [
    services.pluginUi.register({
      id: "console-logger-panel",
      pluginId: "@deepseek-ai/cordis-plugin-logger-console",
      title: "运行时日志",
      description: "查看最近的生命周期和运行时诊断输出。",
      icon: "▤",
      visible: () => pluginLoaded(services, "@deepseek-ai/cordis-plugin-logger-console"),
      read: () => ({
        total: context.logger.buffer.length,
        items: context.logger.buffer.slice(-40).map((message) => ({
          time: new Date(message.ts).toISOString(),
          level: message.type,
          source: message.name,
          args: message.args,
        })),
      }),
    }),
    services.pluginUi.register({
      id: "plugin-group-panel",
      pluginId: "@deepseek-ai/cordis-plugin-group",
      title: "插件树",
      description: "查看当前运行时加载的插件树和生命周期状态。",
      icon: "⌘",
      visible: () => pluginLoaded(services, "@deepseek-ai/cordis-plugin-group"),
      read: () => ({
        entries:
          services.loader === undefined
            ? []
            : [...services.loader.entries()].map((entry) => ({
                id: entry.id,
                name: entry.options.name.replace(/^@deepseek-ai\/cordis-plugin-/i, "plugin-").replace(/^cordis:/i, "runtime:"),
                state: pluginSummary(entry).state,
                enabled: !entry.disabled,
              })),
      }),
    }),
    services.pluginUi.register({
      id: "timer-service-panel",
      pluginId: "@deepseek-ai/cordis-plugin-timer",
      title: "定时器服务",
      description: "确认定时器服务已注册，并查看可用的生命周期绑定 API。",
      icon: "◷",
      visible: () => pluginLoaded(services, "@deepseek-ai/cordis-plugin-timer"),
      read: () => ({
        registered: context.reflect.get("timer") !== undefined,
        capabilities: ["timeout", "interval", "throttle", "debounce"],
      }),
    }),
  ];
  return () => disposers.reverse().forEach((dispose) => dispose());
}

function runProcess(executable: string, args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    execFile(executable, [...args], { cwd, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        rejectProcess(new Error(`${executable} ${args.join(" ")} failed: ${stderr || error.message}`, { cause: error }));
        return;
      }
      resolveProcess({ stdout, stderr });
    });
  });
}

async function appendMarketplaceProfile(configPath: string, plugin: MarketplacePlugin): Promise<string> {
  const source = await readFile(configPath, "utf8");
  if (source.includes(`name: ${JSON.stringify(plugin.packageName)}`)) return source;
  const entryId = `marketplace-${plugin.id}`;
  const config = JSON.stringify(plugin.profile.config);
  const group = plugin.profile.group === true ? "\n  group: true" : "";
  const entry = `\n- id: ${entryId}\n  name: ${JSON.stringify(plugin.packageName)}${group}\n  config: ${config}\n`;
  await writeFile(configPath, source.replace(/\s*$/, "") + entry, "utf8");
  return source;
}

async function updateMarketplaceProfile(configPath: string, entryId: string, update: { disabled?: boolean; remove?: boolean }): Promise<string> {
  const source = await readFile(configPath, "utf8");
  const escapedId = entryId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^- id: ${escapedId}\\n(?:(?!^- id: ).*(?:\\n|$))*`, "m");
  const match = source.match(pattern);
  if (match === null) throw new Error(`Installed plugin profile entry was not found: ${entryId}`);
  if (update.remove === true) {
    await writeFile(configPath, source.replace(match[0], ""), "utf8");
    return source;
  }
  let block = match[0].replace(/^ {2}disabled: .*\n/m, "");
  if (update.disabled === true) block = block.replace(/^( {2}name: .*\n)/m, "$1  disabled: true\n");
  await writeFile(configPath, source.replace(match[0], block), "utf8");
  return source;
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
    execFile("git", ["diff", "--no-ext-diff", "--", path], { cwd, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolveOutput(error && stdout.length === 0 ? "" : stdout),
    );
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

interface EveryApiCliAuthStatus {
  configured: false;
  source: "everyapi-cli";
  label: string;
}

function probeEveryApiCliAuth(): Promise<EveryApiCliAuthStatus> {
  const executable = process.env.EVERYAPI_CLI_PATH?.trim() || "everyapi";
  return new Promise((resolveStatus) => {
    execFile(executable, ["auth", "status"], { timeout: 3_000, maxBuffer: 128 * 1024 }, (error) => {
      resolveStatus({
        configured: false,
        source: "everyapi-cli",
        label: error ? "未检测到 EveryAPI CLI 登录" : "EveryAPI CLI 已登录，但 relay key 未注入当前进程",
      });
    });
  });
}

async function listWorkspaces(cwd: string): Promise<readonly WorkspaceSummary[]> {
  const result = await gitCommand(cwd, ["worktree", "list", "--porcelain"]);
  const parsed = result.code === 0 ? parseGitWorktrees(result.stdout, cwd) : [];
  if (parsed.some((item) => item.current)) return parsed;
  return [{ path: resolve(cwd), branch: "current", current: true, name: resolve(cwd).split("/").pop() ?? resolve(cwd) }, ...parsed];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function pickDirectory(): Promise<string> {
  return new Promise((resolvePath, reject) => {
    execFile(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "选择 Pi 工作区")'],
      { timeout: 120_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || "目录选择已取消"));
          return;
        }
        const path = stdout.trim();
        if (!path) reject(new Error("目录选择已取消"));
        else resolvePath(path);
      },
    );
  });
}

function workspacePaths(root: string, paths: unknown): string[] | Error {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || path.trim() === ""))
    return new Error("paths must be a non-empty array of strings");
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
      runtime: context.reflect.get("piRuntime") as PiRuntimeService,
      models: context.reflect.get("piModels") as PiModelsService,
      launch: context.reflect.get("piHarnessLaunch") as PiHarnessLaunch,
      webServer: context.webServer,
      loader: context.reflect.get("loader") as Loader | undefined,
      pluginUi: context.reflect.get("piPluginUi") as PiPluginUiRegistry | undefined,
    };
    const disposePluginPanels = registerPluginPanels(context, services);
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
      ? context.on("pi/session-event" as never, handleEvent as never)
      : services.runtime.session.subscribe(handleEvent);
    const disposeStatus = services.webServer.register({
      path: "/api/status",
      handler(_request, response) {
        sendJson(response, 200, createStatus(services, events));
      },
    });
    const disposeConfig = services.webServer.register({
      path: "/api/config",
      async handler(request, response) {
        if (request.method === "GET") {
          sendJson(response, 200, piConfig(services));
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as Record<string, unknown>;
          const settings = services.runtime.session.settingsManager;
          if (typeof payload.defaultProvider === "string" && payload.defaultProvider.trim()) settings.setDefaultProvider(payload.defaultProvider.trim());
          if (typeof payload.defaultModel === "string" && payload.defaultModel.trim()) settings.setDefaultModel(payload.defaultModel.trim());
          if (
            payload.defaultThinkingLevel === "off" ||
            payload.defaultThinkingLevel === "minimal" ||
            payload.defaultThinkingLevel === "low" ||
            payload.defaultThinkingLevel === "medium" ||
            payload.defaultThinkingLevel === "high" ||
            payload.defaultThinkingLevel === "xhigh" ||
            payload.defaultThinkingLevel === "max"
          )
            settings.setDefaultThinkingLevel(payload.defaultThinkingLevel);
          if (payload.transport === "sse" || payload.transport === "websocket" || payload.transport === "auto") settings.setTransport(payload.transport);
          if (payload.steeringMode === "all" || payload.steeringMode === "one-at-a-time") settings.setSteeringMode(payload.steeringMode);
          if (payload.followUpMode === "all" || payload.followUpMode === "one-at-a-time") settings.setFollowUpMode(payload.followUpMode);
          if (typeof payload.hideThinkingBlock === "boolean") settings.setHideThinkingBlock(payload.hideThinkingBlock);
          if (typeof payload.retry === "object" && payload.retry !== null) {
            const retry = payload.retry as Record<string, unknown>;
            if (typeof retry.enabled === "boolean") settings.setRetryEnabled(retry.enabled);
          }
          if (typeof payload.terminal === "object" && payload.terminal !== null) {
            const terminal = payload.terminal as Record<string, unknown>;
            if (typeof terminal.showImages === "boolean") settings.setShowImages(terminal.showImages);
            if (typeof terminal.imageAutoResize === "boolean") settings.setImageAutoResize(terminal.imageAutoResize);
            if (typeof terminal.autocompleteMaxVisible === "number" && Number.isInteger(terminal.autocompleteMaxVisible))
              settings.setAutocompleteMaxVisible(Math.min(20, Math.max(3, terminal.autocompleteMaxVisible)));
          }
          if (typeof payload.advanced === "object" && payload.advanced !== null) {
            const advanced = payload.advanced as Record<string, unknown>;
            if (typeof advanced.quietStartup === "boolean") settings.setQuietStartup(advanced.quietStartup);
            if (advanced.projectTrust === "ask" || advanced.projectTrust === "always" || advanced.projectTrust === "never")
              settings.setDefaultProjectTrust(advanced.projectTrust);
            if (typeof advanced.showCacheMissNotices === "boolean") settings.setShowCacheMissNotices(advanced.showCacheMissNotices);
            if (typeof advanced.enableInstallTelemetry === "boolean") settings.setEnableInstallTelemetry(advanced.enableInstallTelemetry);
            if (typeof advanced.shellPath === "string") settings.setShellPath(advanced.shellPath.trim() || undefined);
            if (advanced.doubleEscapeAction === "fork" || advanced.doubleEscapeAction === "tree" || advanced.doubleEscapeAction === "none")
              settings.setDoubleEscapeAction(advanced.doubleEscapeAction);
            if (
              advanced.treeFilterMode === "default" ||
              advanced.treeFilterMode === "no-tools" ||
              advanced.treeFilterMode === "user-only" ||
              advanced.treeFilterMode === "labeled-only" ||
              advanced.treeFilterMode === "all"
            )
              settings.setTreeFilterMode(advanced.treeFilterMode);
            if (advanced.mermaid === "off" || advanced.mermaid === "final" || advanced.mermaid === "streaming")
              settings.setMermaidRenderingMode(advanced.mermaid);
          }
          if (
            typeof payload.compaction === "object" &&
            payload.compaction !== null &&
            typeof (payload.compaction as Record<string, unknown>).enabled === "boolean"
          )
            settings.setCompactionEnabled((payload.compaction as Record<string, boolean>).enabled === true);
          await settings.flush();
          sendJson(response, 200, piConfig(services));
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeConfigReload = services.webServer.register({
      path: "/api/config/reload",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          await services.runtime.session.settingsManager.reload();
          sendJson(response, 200, piConfig(services));
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeConfigSource = services.webServer.register({
      path: "/api/config/source",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { source?: unknown };
          if (typeof payload.source !== "string" || payload.source.length > 128 * 1024) {
            sendJson(response, 400, { error: "source must be a JSON document smaller than 128 KiB" });
            return;
          }
          const parsed: unknown = JSON.parse(payload.source);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            sendJson(response, 400, { error: "settings source must contain a JSON object" });
            return;
          }
          const path = join(services.launch.agentDir, "settings.json");
          await writeFile(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
          await services.runtime.session.settingsManager.reload();
          sendJson(response, 200, piConfig(services));
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeModels = services.webServer.register({
      path: "/api/models",
      handler(_request, response) {
        const active = services.runtime.session.model ?? services.models.model;
        const visible = visibleProviderIds(services.models.runtime, active.provider);
        sendJson(
          response,
          200,
          jsonSafe({
            items: services.models.runtime
              .getModels()
              .filter((model) => visible.has(model.provider))
              .map((model) => modelSummary(model, model.provider === active.provider && model.id === active.id)),
          }),
        );
      },
    });
    const disposeProviders = services.webServer.register({
      path: "/api/providers",
      handler(_request, response) {
        const active = services.runtime.session.model ?? services.models.model;
        const runtime = services.models.runtime as typeof services.models.runtime & {
          getProviders?: () => readonly { id: string; name?: string }[];
          getProviderAuthStatus?: (provider: string) => unknown;
        };
        const providers = typeof runtime.getProviders === "function" ? runtime.getProviders() : [{ id: active.provider, name: active.provider }];
        const visibleIds = visibleProviderIds(runtime, active.provider);
        const visible = providers.filter((provider) => visibleIds.has(provider.id));
        sendJson(
          response,
          200,
          jsonSafe({
            items: visible.map((provider) => ({
              provider: provider.id,
              name: provider.name ?? provider.id,
              active: provider.id === active.provider,
              auth: typeof runtime.getProviderAuthStatus === "function" ? runtime.getProviderAuthStatus(provider.id) : undefined,
              activeModel: provider.id === active.provider ? modelSummary(active, true) : undefined,
              models: services.models.runtime
                .getModels(provider.id)
                .map((model) => modelSummary(model, model.provider === active.provider && model.id === active.id)),
            })),
          }),
        );
      },
    });
    const disposeProviderAdd = services.webServer.register({
      path: "/api/providers/add",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as {
            provider?: unknown;
            name?: unknown;
            baseUrl?: unknown;
            api?: unknown;
            apiKey?: unknown;
            model?: unknown;
          };
          const provider = typeof payload.provider === "string" ? payload.provider.trim() : "";
          const name = typeof payload.name === "string" && payload.name.trim() !== "" ? payload.name.trim() : provider;
          const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl.trim() : "";
          const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
          const model = typeof payload.model === "string" ? payload.model.trim() : "";
          const api = payload.api === "openai-responses" ? "openai-responses" : "openai-completions";
          if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(provider)) {
            sendJson(response, 400, { error: "provider must be 2-64 characters using letters, numbers, ., _, or -" });
            return;
          }
          if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
            sendJson(response, 400, { error: "baseUrl must be an http(s) URL" });
            return;
          }
          if (!apiKey || !model) {
            sendJson(response, 400, { error: "apiKey and model are required" });
            return;
          }
          const runtime = services.models.runtime;
          if (runtime.getProvider(provider) !== undefined) {
            sendJson(response, 409, { error: `Provider already exists: ${provider}` });
            return;
          }
          runtime.registerProvider(provider, {
            name,
            baseUrl,
            api,
            models: [
              {
                id: model,
                name: model,
                api,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          });
          await runtime.setRuntimeApiKey(provider, apiKey);
          sendJson(response, 201, {
            provider: {
              provider,
              name,
              active: false,
              auth: runtime.getProviderAuthStatus(provider),
              models: runtime.getModels(provider).map((item) => modelSummary(item, false)),
            },
          });
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
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
          if (payload.provider === "everyapi" && auth === undefined && !process.env.EVERYAPI_RELAY_KEY?.trim()) {
            const cliAuth = await probeEveryApiCliAuth();
            sendJson(response, 200, { provider: payload.provider, reachable: false, auth: cliAuth });
            return;
          }
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
    const disposePluginUi = services.webServer.register({
      path: "/api/plugin-ui",
      async handler(request, response) {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const items = services.pluginUi === undefined ? [] : await services.pluginUi.snapshot();
          sendJson(response, 200, jsonSafe({ items }));
        } catch (error) {
          sendJson(response, 500, { error: errorText(error) });
        }
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
        const category = url.searchParams.get("category") ?? "";
        const page = Number(url.searchParams.get("page") ?? "0");
        const pageSize = Number(url.searchParams.get("pageSize") ?? "24");
        if (
          query.length > 120 ||
          capability.length > 80 ||
          category.length > 80 ||
          !Number.isInteger(page) ||
          page < 0 ||
          !Number.isInteger(pageSize) ||
          pageSize < 1 ||
          pageSize > 100
        ) {
          sendJson(response, 400, { error: "Invalid marketplace query" });
          return;
        }
        sendJson(response, 200, {
          ...paginateMarketplace(searchMarketplace(query, capability, category), page, pageSize),
          capabilities: MARKETPLACE_CAPABILITIES,
          categories: MARKETPLACE_CATEGORIES,
        });
      },
    });
    let marketplaceInstallInFlight = false;
    const disposeMarketplaceInstall = services.webServer.register({
      path: "/api/marketplace/install",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (marketplaceInstallInFlight) {
          sendJson(response, 409, { error: "Another plugin installation is already running" });
          return;
        }
        const loader = services.loader;
        const configPath = services.launch.configPath;
        if (loader === undefined || configPath === undefined) {
          sendJson(response, 501, { error: "Plugin installation is unavailable for this runtime" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { id?: unknown };
          if (typeof payload.id !== "string" || payload.id.trim() === "") {
            sendJson(response, 400, { error: "id is required" });
            return;
          }
          const plugin = MARKETPLACE_PLUGINS.find((item) => item.id === payload.id);
          if (plugin === undefined) {
            sendJson(response, 404, { error: "Marketplace plugin was not found" });
            return;
          }
          const existing = [...loader.entries()].find((entry) => entry.options.name === plugin.packageName);
          if (existing !== undefined) {
            sendJson(response, 409, { error: "Plugin is already installed", plugin });
            return;
          }
          marketplaceInstallInFlight = true;
          const packageJsonPath = join(services.launch.cwd, "package.json");
          const packageLockPath = join(services.launch.cwd, "package-lock.json");
          const packageJsonBefore = await readFile(packageJsonPath, "utf8").catch(() => undefined);
          const packageLockBefore = await readFile(packageLockPath, "utf8").catch(() => undefined);
          let profileBefore: string | undefined;
          let entryId: string | undefined;
          try {
            if (needsMarketplacePackageInstall(plugin)) {
              await runProcess("npm", ["install", "--save-exact", "--package-lock=false", `${plugin.packageName}@${plugin.version}`], services.launch.cwd);
            }
            profileBefore = await appendMarketplaceProfile(configPath, plugin);
            if (!needsMarketplacePackageInstall(plugin)) {
              sendJson(response, 200, { plugin, installed: false, restartRequired: true });
              return;
            }
            entryId = await loader.create({
              id: `marketplace-${plugin.id}`,
              name: plugin.packageName,
              ...(plugin.profile.group === true ? { group: true } : {}),
              config: plugin.profile.config,
            } as never);
            const entry = loader.resolve(entryId);
            if (entry.fiber === undefined) throw new Error(`Plugin ${plugin.packageName} did not create a runtime fiber`);
            await entry.fiber.await();
            sendJson(response, 200, { plugin, installed: true });
          } catch (error) {
            if (entryId !== undefined) await loader.remove(entryId).catch(() => {});
            if (profileBefore !== undefined) await writeFile(configPath, profileBefore, "utf8").catch(() => {});
            if (packageJsonBefore !== undefined) await writeFile(packageJsonPath, packageJsonBefore, "utf8").catch(() => {});
            if (packageLockBefore !== undefined) await writeFile(packageLockPath, packageLockBefore, "utf8").catch(() => {});
            sendJson(response, 502, { error: errorText(error) });
          } finally {
            marketplaceInstallInFlight = false;
          }
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposePluginToggle = services.webServer.register({
      path: "/api/plugins/toggle",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const configPath = services.launch.configPath;
        const loader = services.loader;
        if (configPath === undefined || loader === undefined) {
          sendJson(response, 501, { error: "Plugin configuration is unavailable for this runtime" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { id?: unknown; enabled?: unknown };
          if (typeof payload.id !== "string" || typeof payload.enabled !== "boolean") {
            sendJson(response, 400, { error: "A marketplace plugin id and enabled boolean are required" });
            return;
          }
          const entry = [...loader.entries()].find((item) => item.id === payload.id || item.options.id === payload.id);
          if (entry === undefined) {
            sendJson(response, 404, { error: "Installed plugin was not found" });
            return;
          }
          const plugin = marketplacePluginForEntry(entry);
          if (plugin === undefined) {
            sendJson(response, 403, { error: "Built-in plugins cannot be changed" });
            return;
          }
          const profileEntryId = entry.options.id.startsWith("marketplace-") ? entry.options.id : `marketplace-${plugin.id}`;
          const before = await updateMarketplaceProfile(configPath, profileEntryId, { disabled: !payload.enabled });
          try {
            await entry.update({ disabled: !payload.enabled });
            sendJson(response, 200, { plugin: pluginSummary(entry) });
          } catch (error) {
            await writeFile(configPath, before, "utf8").catch(() => {});
            sendJson(response, 502, { error: errorText(error) });
          }
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposePluginUninstall = services.webServer.register({
      path: "/api/plugins/uninstall",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const configPath = services.launch.configPath;
        const loader = services.loader;
        if (configPath === undefined || loader === undefined) {
          sendJson(response, 501, { error: "Plugin configuration is unavailable for this runtime" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { id?: unknown };
          if (typeof payload.id !== "string") {
            sendJson(response, 400, { error: "A marketplace plugin id is required" });
            return;
          }
          const entry = [...loader.entries()].find((item) => item.id === payload.id || item.options.id === payload.id);
          if (entry === undefined) {
            sendJson(response, 404, { error: "Installed plugin was not found" });
            return;
          }
          const plugin = marketplacePluginForEntry(entry);
          if (plugin === undefined) {
            sendJson(response, 403, { error: "Only marketplace plugins can be uninstalled" });
            return;
          }
          const profileEntryId = entry.options.id.startsWith("marketplace-") ? entry.options.id : `marketplace-${plugin.id}`;
          const profileBefore = await readFile(configPath, "utf8");
          const packageJsonPath = join(services.launch.cwd, "package.json");
          const packageLockPath = join(services.launch.cwd, "package-lock.json");
          const packageJsonBefore = await readFile(packageJsonPath, "utf8").catch(() => undefined);
          const packageLockBefore = await readFile(packageLockPath, "utf8").catch(() => undefined);
          await entry.parent.remove(entry.options.id);
          entry.parent.tree.write();
          try {
            await updateMarketplaceProfile(configPath, profileEntryId, { remove: true });
            await runProcess("npm", ["uninstall", "--package-lock=false", plugin.packageName], services.launch.cwd);
            sendJson(response, 200, { uninstalled: true, id: payload.id });
          } catch (error) {
            await writeFile(configPath, profileBefore, "utf8").catch(() => {});
            if (packageJsonBefore !== undefined) await writeFile(packageJsonPath, packageJsonBefore, "utf8").catch(() => {});
            if (packageLockBefore !== undefined) await writeFile(packageLockPath, packageLockBefore, "utf8").catch(() => {});
            const options = entry.options as { name: string; config?: unknown; group?: boolean | null };
            await loader.create({ name: options.name, config: options.config, ...(options.group ? { group: true } : {}) }).catch(() => {});
            sendJson(response, 502, { error: errorText(error) });
          }
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeCommands = services.webServer.register({
      path: "/api/commands",
      handler(_request, response) {
        const commands = services.runtime.session.extensionRunner.getRegisteredCommands();
        const items = commands.map((command) => ({
          name: command.name,
          invocationName: command.invocationName,
          description: command.description,
          source: command.sourceInfo.path,
        }));
        sendJson(response, 200, jsonSafe({ items }));
      },
    });
    const disposeWorkspaces = services.webServer.register({
      path: "/api/workspaces",
      async handler(_request, response) {
        try {
          sendJson(response, 200, { items: await listWorkspaces(activeCwd(services)) });
        } catch (error) {
          sendJson(response, 500, { error: errorText(error) });
        }
      },
    });
    const disposePickDirectory = services.webServer.register({
      path: "/api/workspaces/pick",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (process.platform !== "darwin") {
          sendJson(response, 501, { error: "Native directory picker is only available on macOS" });
          return;
        }
        try {
          sendJson(response, 200, { path: await pickDirectory() });
        } catch (error) {
          sendJson(response, 409, { error: errorText(error) });
        }
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
        const output = await gitStatus(activeCwd(services));
        const items = output
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0)
          .map((line) => {
            const status = line.slice(0, 2).trim() || "??";
            return {
              path: line.slice(3),
              status,
              label: status === "??" ? "untracked" : status.includes("D") ? "deleted" : status.includes("A") ? "added" : "modified",
            };
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
        const root = resolve(activeCwd(services));
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
          const paths = workspacePaths(resolve(activeCwd(services)), payload.paths);
          if (paths instanceof Error) {
            sendJson(response, 400, { error: paths.message });
            return;
          }
          if (typeof payload.message !== "string" || payload.message.trim() === "") {
            sendJson(response, 400, { error: "message is required" });
            return;
          }
          const root = resolve(activeCwd(services));
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
          const root = resolve(activeCwd(services));
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
          for (const path of untracked.stdout
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean)) {
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
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
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
        sendJson(
          response,
          200,
          jsonSafe({
            sessionId: session.sessionId,
            sessionFile: session.sessionFile,
            messages: session.messages,
            entries: typeof sessionManager?.getEntries === "function" ? sessionManager.getEntries() : [],
            events,
          }),
        );
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
          const raw = await bodyText(request);
          const payload = raw.trim() ? (JSON.parse(raw) as { cwd?: unknown }) : {};
          const currentCwd = activeCwd(services);
          const requestedCwd = typeof payload.cwd === "string" ? resolve(payload.cwd) : resolve(currentCwd);
          const workspaces = await listWorkspaces(currentCwd);
          const workspace =
            workspaces.find((item) => item.path === requestedCwd) ??
            (typeof payload.cwd === "string" && (await isDirectory(requestedCwd))
              ? { path: requestedCwd, branch: "directory", current: false, name: basename(requestedCwd) || requestedCwd }
              : undefined);
          if (!workspace) {
            sendJson(response, 400, { error: "Workspace is not available" });
            return;
          }
          if (services.runtime.sessionRuntime) {
            let result;
            if (workspace.current) {
              result = await runWebSessionChange(services, () => services.runtime.sessionRuntime.newSession());
            } else {
              const manager = services.runtime.session.sessionManager;
              if (!manager || typeof manager.isPersisted !== "function" || !manager.isPersisted()) {
                sendJson(response, 409, { error: "Workspace switching requires JSONL session storage" });
                return;
              }
              const created = SessionManager.create(workspace.path, manager.getSessionDir());
              const sessionFile = created.newSession();
              if (!sessionFile) throw new Error("Unable to create a workspace session");
              result = await runWebSessionChange(services, () => services.runtime.sessionRuntime.switchSession(sessionFile, { cwdOverride: workspace.path }));
            }
            if (result.cancelled) {
              sendJson(response, 409, { error: "Session creation was cancelled by an extension" });
              return;
            }
          } else {
            const session = services.runtime.session;
            session.sessionManager.newSession();
            session.agent.state.messages = [];
          }
          events.length = 0;
          const session = services.runtime.session;
          for (const client of eventClients) writeSse(client, { type: "session", sessionId: session.sessionId, events: [] });
          sendJson(
            response,
            200,
            jsonSafe({
              sessionId: session.sessionId,
              sessionFile: session.sessionFile,
              messages: services.runtime.sessionRuntime ? session.messages : [],
              events: [],
            }),
          );
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
          const target = items.find(
            (item) =>
              (typeof payload.path === "string" && item.path === payload.path) || (typeof payload.sessionId === "string" && item.id === payload.sessionId),
          );
          if (target === undefined) {
            sendJson(response, 404, { error: "Session not found" });
            return;
          }
          if (services.runtime.sessionRuntime) {
            const result = await runWebSessionChange(services, () => services.runtime.sessionRuntime.switchSession(target.path, { cwdOverride: target.cwd }));
            if (result.cancelled) {
              sendJson(response, 409, { error: "Session switch was cancelled by an extension" });
              return;
            }
          } else {
            manager.setSessionFile(target.path);
            if (typeof services.runtime.session.reload === "function") await services.runtime.session.reload();
            else services.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
          }
          events.length = 0;
          for (const client of eventClients) writeSse(client, { type: "session", sessionId: services.runtime.session.sessionId, events: [] });
          sendJson(
            response,
            200,
            jsonSafe({
              sessionId: services.runtime.session.sessionId,
              sessionFile: services.runtime.session.sessionFile,
              messages: services.runtime.session.messages,
              events: [],
            }),
          );
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeRenameSession = services.webServer.register({
      path: "/api/session/rename",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { path?: unknown; name?: unknown };
          const manager = services.runtime.session.sessionManager;
          const path = typeof payload.path === "string" ? payload.path : services.runtime.session.sessionFile;
          const name = typeof payload.name === "string" ? payload.name.trim() : "";
          if (!path || !sessionPathInDirectory(path, manager)) {
            sendJson(response, 400, { error: "Invalid session path" });
            return;
          }
          if (name.length > 120) {
            sendJson(response, 400, { error: "Session name must be at most 120 characters" });
            return;
          }
          SessionManager.open(path, manager.getSessionDir()).appendSessionInfo(name);
          sendJson(response, 200, { path, name: name || undefined });
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeDeleteSession = services.webServer.register({
      path: "/api/session/delete",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { path?: unknown; confirm?: unknown };
          const manager = services.runtime.session.sessionManager;
          const path = typeof payload.path === "string" ? payload.path : "";
          if (payload.confirm !== true) {
            sendJson(response, 400, { error: "confirm must be true to delete a session" });
            return;
          }
          if (!sessionPathInDirectory(path, manager)) {
            sendJson(response, 400, { error: "Invalid session path" });
            return;
          }
          if (path === services.runtime.session.sessionFile) {
            if (services.runtime.session.isStreaming) {
              sendJson(response, 409, { error: "Cannot delete the active session while a prompt is running" });
              return;
            }
            const result = await runWebSessionChange(services, () => services.runtime.sessionRuntime.newSession());
            if (result.cancelled) {
              sendJson(response, 409, { error: "Session deletion was cancelled by an extension" });
              return;
            }
            events.length = 0;
          }
          await unlink(path);
          const metadata = await readSessionMetadata(manager);
          delete metadata[path];
          await writeSessionMetadata(manager, metadata);
          sendJson(response, 200, { deleted: true, path, sessionFile: services.runtime.session.sessionFile });
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeSessionMetadata = services.webServer.register({
      path: "/api/session/metadata",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { path?: unknown; archived?: unknown; pinned?: unknown };
          const manager = services.runtime.session.sessionManager;
          const path = typeof payload.path === "string" ? payload.path : "";
          if (!sessionPathInDirectory(path, manager)) {
            sendJson(response, 400, { error: "Invalid session path" });
            return;
          }
          const metadata = await readSessionMetadata(manager);
          const currentMetadata = metadata[path] ?? {};
          const nextMetadata: SessionMetadata = {
            ...currentMetadata,
            ...(payload.archived === undefined ? {} : { archived: payload.archived === true }),
            ...(payload.pinned === undefined ? {} : { pinned: payload.pinned === true }),
          };
          metadata[path] = nextMetadata;
          await writeSessionMetadata(manager, metadata);
          sendJson(response, 200, { path, metadata: metadata[path] });
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeBatchSessions = services.webServer.register({
      path: "/api/sessions/batch",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { action?: unknown; paths?: unknown; confirm?: unknown };
          const action = payload.action;
          const paths = Array.isArray(payload.paths) ? payload.paths.filter((path): path is string => typeof path === "string") : [];
          const manager = services.runtime.session.sessionManager;
          if (
            (action !== "delete" && action !== "archive" && action !== "unarchive" && action !== "pin" && action !== "unpin") ||
            paths.length === 0 ||
            paths.length > 100
          ) {
            sendJson(response, 400, { error: "action and 1-100 session paths are required" });
            return;
          }
          if (action === "delete" && payload.confirm !== true) {
            sendJson(response, 400, { error: "confirm must be true to delete sessions" });
            return;
          }
          if (paths.some((path) => !sessionPathInDirectory(path, manager))) {
            sendJson(response, 400, { error: "Invalid session path" });
            return;
          }
          if (action === "delete" && paths.includes(services.runtime.session.sessionFile ?? "")) {
            sendJson(response, 409, { error: "Cannot batch-delete the active session" });
            return;
          }
          const metadata = await readSessionMetadata(manager);
          for (const path of paths) {
            if (action === "delete") {
              await unlink(path);
              delete metadata[path];
            } else {
              const current = metadata[path] ?? {};
              metadata[path] = {
                ...current,
                ...(action === "archive" || action === "unarchive" ? { archived: action === "archive" } : {}),
                ...(action === "pin" || action === "unpin" ? { pinned: action === "pin" } : {}),
              };
            }
          }
          await writeSessionMetadata(manager, metadata);
          sendJson(response, 200, { action, count: paths.length });
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeForkSession = services.webServer.register({
      path: "/api/session/fork",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { path?: unknown; cwd?: unknown };
          const manager = services.runtime.session.sessionManager;
          const sourcePath = typeof payload.path === "string" ? payload.path : "";
          if (!sessionPathInDirectory(sourcePath, manager)) {
            sendJson(response, 400, { error: "Invalid session path" });
            return;
          }
          const sessions = await SessionManager.list(services.launch.cwd, manager.getSessionDir());
          const source = sessions.find((item) => item.path === sourcePath);
          if (!source) {
            sendJson(response, 404, { error: "Session not found" });
            return;
          }
          const targetCwd = typeof payload.cwd === "string" && payload.cwd.trim() ? resolve(payload.cwd) : source.cwd || activeCwd(services);
          const forked = SessionManager.forkFrom(source.path, targetCwd, manager.getSessionDir());
          sendJson(response, 200, { sessionId: forked.getSessionId(), sessionFile: forked.getSessionFile(), cwd: targetCwd });
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeImportSession = services.webServer.register({
      path: "/api/session/import",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (services.runtime.session.isStreaming) {
          sendJson(response, 409, { error: "Cannot import a session while a prompt is running" });
          return;
        }
        try {
          const payload = JSON.parse(await bodyText(request)) as { path?: unknown; content?: unknown; filename?: unknown; cwd?: unknown };
          const suppliedPath = typeof payload.path === "string" ? payload.path : "";
          const content = typeof payload.content === "string" ? payload.content : undefined;
          if ((!suppliedPath || !isAbsolute(suppliedPath)) && content === undefined) {
            sendJson(response, 400, { error: "A JSONL file path or file content is required" });
            return;
          }
          const manager = services.runtime.session.sessionManager;
          if (!manager.isPersisted()) {
            sendJson(response, 409, { error: "Session importing requires JSONL session storage" });
            return;
          }
          const targetCwd = typeof payload.cwd === "string" && payload.cwd.trim() ? resolve(payload.cwd) : activeCwd(services);
          const temporaryDirectory = content === undefined ? undefined : await mkdtemp(join(tmpdir(), "pi-harness-import-"));
          const importPath =
            suppliedPath ||
            join(temporaryDirectory as string, basename(typeof payload.filename === "string" && payload.filename.trim() ? payload.filename : "import.jsonl"));
          try {
            if (content !== undefined) {
              if (Buffer.byteLength(content, "utf8") > 10 * 1024 * 1024) {
                sendJson(response, 413, { error: "Imported session must be at most 10 MiB" });
                return;
              }
              await writeFile(importPath, content, "utf8");
            }
            const imported = SessionManager.forkFrom(importPath, targetCwd, manager.getSessionDir());
            const importedPath = imported.getSessionFile();
            if (!importedPath) throw new Error("Unable to persist imported session");
            const result = await runWebSessionChange(services, () => services.runtime.sessionRuntime.switchSession(importedPath, { cwdOverride: targetCwd }));
            if (result.cancelled) {
              sendJson(response, 409, { error: "Session import was cancelled by an extension" });
              return;
            }
            events.length = 0;
            sendJson(response, 200, {
              sessionId: services.runtime.session.sessionId,
              sessionFile: services.runtime.session.sessionFile,
              messages: services.runtime.session.messages.length,
            });
          } finally {
            if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
          }
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        }
      },
    });
    const disposeExportSession = services.webServer.register({
      path: "/api/session/export",
      async handler(request, response) {
        try {
          const url = new URL(request.url ?? "/api/session/export", "http://localhost");
          const manager = services.runtime.session.sessionManager;
          const path = url.searchParams.get("path") ?? services.runtime.session.sessionFile;
          if (!path || !sessionPathInDirectory(path, manager)) {
            sendJson(response, 400, { error: "Invalid session path" });
            return;
          }
          const content = await readFile(path, "utf8");
          response.writeHead(200, {
            "content-type": "application/x-ndjson; charset=utf-8",
            "content-disposition": `attachment; filename="${basename(path)}"`,
            "cache-control": "no-store",
          });
          response.end(content);
        } catch (error) {
          sendJson(response, 404, { error: errorText(error) });
        }
      },
    });
    const disposeSessions = services.webServer.register({
      path: "/api/sessions",
      async handler(_request, response) {
        try {
          const session = services.runtime.session;
          const manager = session.sessionManager;
          const url = new URL(_request.url ?? "/api/sessions", "http://localhost");
          const page = Math.max(0, Number.parseInt(url.searchParams.get("page") ?? "0", 10) || 0);
          const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50));
          const includeArchived = url.searchParams.get("includeArchived") === "true";
          const metadata = await readSessionMetadata(manager);
          const items =
            typeof manager.isPersisted === "function" && manager.isPersisted() ? await SessionManager.list(services.launch.cwd, manager.getSessionDir()) : [];
          const filtered = items.filter((item) => includeArchived || metadata[item.path]?.archived !== true);
          const sorted = filtered.sort(
            (a, b) => Number(metadata[b.path]?.pinned === true) - Number(metadata[a.path]?.pinned === true) || b.modified.getTime() - a.modified.getTime(),
          );
          const paged = sorted.slice(page * pageSize, (page + 1) * pageSize);
          sendJson(
            response,
            200,
            jsonSafe({
              items: paged.map((item) => ({
                sessionId: item.id,
                path: item.path,
                name: item.name,
                cwd: item.cwd,
                created: item.created,
                modified: item.modified,
                messageCount: item.messageCount,
                firstMessage: item.firstMessage,
                archived: metadata[item.path]?.archived === true,
                pinned: metadata[item.path]?.pinned === true,
              })),
              total: sorted.length,
              page,
              pageSize,
              hasNext: (page + 1) * pageSize < sorted.length,
            }),
          );
        } catch (error) {
          sendJson(response, 500, { error: errorText(error) });
        }
      },
    });
    context.effect(() => () => {
      disposeStatus();
      disposeConfig();
      disposeConfigReload();
      disposeConfigSource();
      disposeEvents();
      disposeModels();
      disposeProviders();
      disposeProviderTest();
      disposeProviderRefresh();
      disposeProviderAdd();
      disposePlugins();
      disposePluginUi();
      disposePluginPanels();
      disposeMarketplace();
      disposeMarketplaceInstall();
      disposePluginToggle();
      disposePluginUninstall();
      disposeCommands();
      disposeModel();
      disposeWorkspaces();
      disposePickDirectory();
      disposeFiles();
      disposeFileDiff();
      disposeFileCommit();
      disposeFileRevert();
      disposePrompt();
      disposeAbort();
      disposeSession();
      disposeNewSession();
      disposeOpenSession();
      disposeRenameSession();
      disposeDeleteSession();
      disposeSessionMetadata();
      disposeBatchSessions();
      disposeForkSession();
      disposeImportSession();
      disposeExportSession();
      disposeSessions();
      unsubscribeEvents();
      for (const response of eventClients) response.end();
      eventClients.clear();
    });
  },
};
