import { execFile, type ExecFileException } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import { SessionManager, type AgentSessionEvent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type Loader from "@deepseek-ai/cordis-plugin-loader";
import { atomicWriteFile, isPiToolRegistryLeasedError } from "@pi-harness/core";
import type { PiPluginUiRegistry, PiRuntimeService, PiModelsService, PiHarnessLaunch } from "@pi-harness/core";
import type { WebServer } from "@pi-harness/host-webserver";
import {
  MARKETPLACE_PLUGINS,
  attachMarketplaceStatistics,
  createMarketplaceStatisticsLoader,
  paginateMarketplace,
  searchMarketplace,
  marketplaceNpmPackageName,
  marketplaceCapabilities,
  marketplaceCategories,
  sortMarketplaceByRecommendation,
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

// The first paint waits for every console endpoint to answer, so the catalogue is sorted from whatever npm statistics are already cached and the misses are warmed in the background instead of held on to.
const { readCached: readCachedMarketplaceStatistics } = createMarketplaceStatisticsLoader();

const RUNTIME_ENTRY_NAME = "@pi-harness/core/plugins/runtime";

const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;
const IMPORT_CONTENT_LIMIT_BYTES = 10 * 1024 * 1024;
// The import body carries the JSONL content as a JSON string, so quotes and newlines are escaped; leave headroom above the content limit for that overhead.
const IMPORT_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
// Retained trajectory events are replayed to every SSE client and returned by /api/session, so the array must stay bounded.
const MAX_RETAINED_EVENTS = 2000;
// Tool calls that opened but never closed. Far above any real concurrency, so the cap only ever trims a run the runtime abandoned.
const MAX_PENDING_TOOL_CALLS = 256;
/** A session event with the two fields the gateway owns: when it arrived, and for a tool call how long it took. */
type StampedSessionEvent = AgentSessionEvent & { readonly receivedAt: number; readonly durationMs?: number };
type RunPhase = "starting" | "thinking" | "responding" | "tool";
interface RunActivity {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly phase: RunPhase;
}
const GIT_TIMEOUT_MS = 15_000;
const PROCESS_FAILURE_TEXT_LIMIT = 400;
const PROCESS_TIMEOUT_MS = 120_000;
// Mutating commands run user hooks (pre-commit, lint-staged, test suites) and may stage large trees; killing them part-way leaves index.lock and a half-finished operation behind, so they get a far more generous bound than read-only queries.
const GIT_MUTATION_TIMEOUT_MS = 120_000;

class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "PayloadTooLargeError";
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

// A multi-byte UTF-8 sequence can straddle a chunk boundary, so the raw bytes are collected and decoded once; decoding each chunk on its own would replace the split sequence with U+FFFD.
async function bodyText(request: IncomingMessage, maxBytes = DEFAULT_BODY_LIMIT_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const input: string | Uint8Array = chunk as string | Uint8Array;
    const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.isBuffer(input) ? input : Buffer.from(input);
    length += buffer.length;
    if (length > maxBytes) throw new PayloadTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  // Only the ancestors of the current node stay marked: a sibling that repeats the same object (Pi pushes one AgentMessage instance into both the message list and its events) is legitimate data, not a cycle.
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item, seen)]));
  } finally {
    seen.delete(value);
  }
}

// A plugin that contributes tools only joins on the next start, so the console remembers what it installed until then. That memory is about one particular process, and the console cannot tell a restart from a reconnect on its own, so the identity of this process rides along with the status it already polls.
const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

function createStatus(services: ApiServices, events: readonly AgentSessionEvent[], runActivity: RunActivity | undefined) {
  const activeModel = services.runtime.session.model ?? services.models.model;
  const cwd = activeCwd(services);
  const currentRun =
    services.runtime.session.isStreaming && runActivity?.sessionId === services.runtime.session.sessionId
      ? {
          startedAt: new Date(runActivity.startedAt).toISOString(),
          lastActivityAt: new Date(runActivity.lastActivityAt).toISOString(),
          phase: runActivity.phase,
        }
      : undefined;
  return {
    processStartedAt: PROCESS_STARTED_AT,
    status: services.runtime.session.isStreaming ? "running" : "ready",
    model: activeModel.provider + "/" + activeModel.id,
    messages: services.runtime.session.messages.length,
    events: events.length,
    sessionId: services.runtime.session.sessionId,
    sessionFile: services.runtime.session.sessionFile,
    cwd,
    agentDir: services.launch.agentDir,
    plugins: services.loader ? [...services.loader.entries()].filter((entry) => !entry.disabled).map((entry) => entry.options.name) : [],
    ...(currentRun === undefined ? {} : { run: currentRun }),
  };
}

async function createSessionSnapshot(
  services: ApiServices,
  events: readonly AgentSessionEvent[],
  logger: MetadataLogger,
  messages: readonly unknown[] = services.runtime.session.messages,
) {
  const session = services.runtime.session;
  const manager = session.sessionManager;
  let metadata: SessionMetadata | undefined;
  let metadataAvailable = true;
  if (session.sessionFile) {
    try {
      metadata = (await readSessionMetadataLocked(manager, logger))[session.sessionFile];
    } catch (error) {
      // Session metadata is an enhancement, not the conversation itself. A
      // permissions or transient filesystem failure must not make a completed
      // session switch look failed after the runtime already changed.
      metadataAvailable = false;
      logger.warn(`Unable to read current session metadata: ${errorText(error)}`);
    }
  }
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    name: typeof manager?.getSessionName === "function" ? (manager.getSessionName() ?? undefined) : undefined,
    messages,
    entries: typeof manager?.getEntries === "function" ? manager.getEntries() : [],
    events,
    ...(metadataAvailable ? { archived: metadata?.archived === true, pinned: metadata?.pinned === true } : {}),
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

interface MetadataLogger {
  warn(message: string): void;
}

// A missing file is the normal first-run state. A parse or shape failure means the file exists but is unusable; it is renamed aside so the wreckage survives for recovery and the next write cannot silently replace the only copy. Any other read error (EMFILE, EBUSY, EISDIR, permissions) says nothing about the content, so it propagates and the caller's write is skipped instead of replacing a valid map with an empty one.
async function readSessionMetadata(manager: SessionManager, logger: MetadataLogger): Promise<SessionMetadataMap> {
  const file = sessionMetadataFile(manager);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("session metadata must be a JSON object");
    return parsed as SessionMetadataMap;
  } catch (error) {
    await quarantineSessionMetadata(file, logger, error);
    return {};
  }
}

async function quarantineSessionMetadata(file: string, logger: MetadataLogger, error: unknown): Promise<void> {
  const quarantined = `${file}.corrupt-${Date.now()}`;
  try {
    await rename(file, quarantined);
    logger.warn(`Session metadata at ${file} is unreadable (${errorText(error)}); moved it to ${quarantined} and starting from an empty map`);
  } catch (renameError) {
    logger.warn(`Session metadata at ${file} is unreadable (${errorText(error)}) and could not be quarantined: ${errorText(renameError)}`);
  }
}

async function writeSessionMetadata(manager: SessionManager, metadata: SessionMetadataMap): Promise<void> {
  await mkdir(manager.getSessionDir(), { recursive: true });
  await atomicWriteFile(sessionMetadataFile(manager), JSON.stringify(metadata, null, 2) + "\n", { encoding: "utf8" });
}

// Every access to the metadata file runs through this chain so concurrent requests cannot interleave and drop each other's updates. Plain reads take the lock too: a read that finds corrupt bytes quarantines the file, and doing that outside the lock could rename away a valid map that a concurrent mutation had just written.
let sessionMetadataQueue: Promise<unknown> = Promise.resolve();

function withSessionMetadataLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = sessionMetadataQueue.catch(() => undefined).then(operation);
  sessionMetadataQueue = next;
  return next;
}

function readSessionMetadataLocked(manager: SessionManager, logger: MetadataLogger): Promise<SessionMetadataMap> {
  return withSessionMetadataLock(() => readSessionMetadata(manager, logger));
}

function mutateSessionMetadata<T>(manager: SessionManager, logger: MetadataLogger, mutate: (metadata: SessionMetadataMap) => Promise<T> | T): Promise<T> {
  return withSessionMetadataLock(async () => {
    const metadata = await readSessionMetadata(manager, logger);
    const result = await mutate(metadata);
    await writeSessionMetadata(manager, metadata);
    return result;
  });
}

// True when a path.relative() result points outside the directory it was computed from. All containment checks share this predicate so they agree on every platform separator.
function escapesRoot(relativePath: string): boolean {
  return isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(".." + sep);
}

function sessionPathInDirectory(path: string, manager: SessionManager): boolean {
  const root = resolve(manager.getSessionDir());
  const target = resolve(path);
  const relativePath = relative(root, target);
  return relativePath !== "" && !escapesRoot(relativePath) && target.endsWith(".jsonl");
}

function persistSessionBeforeFirstAssistant(manager: SessionManager): void {
  const path = manager.getSessionFile();
  if (!path || existsSync(path)) return;
  const header = manager.getHeader();
  if (!header) throw new Error("Current session is missing its header");
  // Pi intentionally defers creating a JSONL file until the first assistant
  // response. A user-assigned name is durable work too: persist the current
  // tree now, then reopen the same path so Pi knows subsequent entries can be
  // appended instead of trying to create the file again on first response.
  const source = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(path, source, { encoding: "utf8", flag: "wx" });
  manager.setSessionFile(path);
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

/** The state a marketplace plugin is in between the install that wrote it and the restart that loads it. It is not a loader state because the loader has no entry for it at all. */
const RESTART_REQUIRED_STATE = "restart-required";

// The install writes the entry as two adjacent lines, so this reads back exactly what `marketplaceProfileEntry` writes rather than parsing the profile as YAML, which the `!!js` tags in it would need a schema for.
const MARKETPLACE_PROFILE_ENTRY_PATTERN = /^[ \t]*- id: (marketplace-\S+)[ \t]*\r?\n[ \t]*name: "([^"]+)"/gmu;

/** The loader holds what is running; the profile file holds what is installed. The two differ for a plugin that contributes tools, which cannot join a harness that is already running: the install leaves its package and its profile entry in place and the plugin arrives on the next start. Reading only the loader makes that plugin indistinguishable from one that was never installed, which is why the console answered an install that had just succeeded with "nothing is installed" and then could not uninstall what it had hidden. */
async function readMarketplaceProfileEntries(configPath: string): Promise<readonly { readonly id: string; readonly packageName: string }[]> {
  const source = await readFile(configPath, "utf8").catch(() => undefined);
  if (source === undefined) return [];
  const entries: { id: string; packageName: string }[] = [];
  for (const match of source.matchAll(MARKETPLACE_PROFILE_ENTRY_PATTERN)) entries.push({ id: match[1] ?? "", packageName: match[2] ?? "" });
  return entries;
}

/** The installed plugins the loader does not have, described the same way a loaded one is so the console can list them side by side instead of leaving the user to guess what happened to the install. */
async function restartPendingSummaries(services: ApiServices): Promise<readonly ReturnType<typeof pluginSummary>[]> {
  const configPath = services.launch.configPath;
  if (configPath === undefined || services.loader === undefined) return [];
  const loaded = new Set([...services.loader.entries()].map((entry) => entry.options.id));
  const entries = await readMarketplaceProfileEntries(configPath);
  return entries
    .filter((entry) => !loaded.has(entry.id))
    .map((entry) => {
      const plugin = MARKETPLACE_PLUGINS.find((item) => item.packageName === entry.packageName);
      return {
        id: entry.id,
        name: entry.packageName,
        enabled: true,
        state: RESTART_REQUIRED_STATE,
        removable: true,
        category: plugin?.category,
      };
    });
}

function pluginLoaded(services: ApiServices, packageName: string): boolean {
  return services.loader !== undefined && [...services.loader.entries()].some((entry) => entry.options.name === packageName && !entry.disabled);
}

const loggerPanelItemLimit = 40;
const loggerPanelArgumentLimit = 16;
const loggerPanelStringLimit = 2_048;
const loggerPanelPropertyLimit = 32;
const loggerPanelDepthLimit = 4;
const loggerPanelNodeLimit = 256;

function boundedLogText(value: unknown, limit: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.length <= limit ? value : value.slice(0, limit) + "…";
}

function safeLogTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

interface LogSanitizeState {
  remaining: number;
  readonly seen: WeakSet<object>;
}

function sanitizeLogValue(value: unknown, state: LogSanitizeState, depth = 0): unknown {
  if (state.remaining <= 0) return "[Truncated]";
  state.remaining -= 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedLogText(value, loggerPanelStringLimit, "");
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return String(value);
  if (typeof value !== "object") return Object.prototype.toString.call(value);
  if (depth >= loggerPanelDepthLimit) return "[Max Depth]";
  if (state.seen.has(value)) return "[Circular]";
  // Unmarked once its subtree is done, so an object logged twice as a sibling is rendered twice instead of being mistaken for a cycle.
  state.seen.add(value);

  try {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "Invalid Date";
    if (value instanceof Error)
      return {
        name: boundedLogText(value.name, 128, "Error"),
        message: boundedLogText(value.message, loggerPanelStringLimit, ""),
      };
    if (Array.isArray(value)) {
      const length = Math.min(value.length, loggerPanelArgumentLimit);
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        output.push(descriptor === undefined ? null : "value" in descriptor ? sanitizeLogValue(descriptor.value, state, depth + 1) : "[Accessor]");
      }
      if (value.length > loggerPanelArgumentLimit) output.push(`[${value.length - loggerPanelArgumentLimit} more items]`);
      return output;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true);
    const entries = keys.slice(0, loggerPanelPropertyLimit).map((key) => {
      const descriptor = descriptors[key]!;
      return [key, "value" in descriptor ? sanitizeLogValue(descriptor.value, state, depth + 1) : "[Accessor]"] as const;
    });
    if (keys.length > loggerPanelPropertyLimit) entries.push(["…", `${keys.length - loggerPanelPropertyLimit} more properties`]);
    return Object.fromEntries(entries);
  } catch {
    return "[Unavailable]";
  } finally {
    state.seen.delete(value);
  }
}

function sanitizeLogArguments(args: readonly unknown[]): unknown[] {
  const sanitized = sanitizeLogValue(args, { remaining: loggerPanelNodeLimit, seen: new WeakSet<object>() });
  return Array.isArray(sanitized) ? sanitized : [sanitized];
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
      read: () => {
        const messages = context.logger.buffer.slice(-loggerPanelItemLimit);
        return {
          total: context.logger.buffer.length,
          showing: messages.length,
          bufferLimit: context.logger.bufferSize,
          items: messages.map((message) => ({
            time: safeLogTimestamp(message.ts),
            level: boundedLogText(message.type, 32, "unknown"),
            source: boundedLogText(message.name, 256, "runtime"),
            args: sanitizeLogArguments(message.args),
          })),
        };
      },
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

// npm ends every failure with the path to a debug log inside its own cache, which the reader of this console has no reason to open and no easy way to reach.
const PROCESS_FAILURE_NOISE = /^npm (error|ERR!) A complete log of this run can be found in:/u;

// npm reports a failure over many lines and the whole text is shown to someone who never typed the command, so the lines are joined up to a character budget and the command itself stays on the cause for diagnostics. Node's own message is never used as the fallback: it reads `Command failed: <the whole command line>`, which is exactly what this is removing.
function processFailureText(executable: string, stderr: string, error: ExecFileException): string {
  const text = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !PROCESS_FAILURE_NOISE.test(line))
    .join(" ");
  if (text === "")
    return error.killed === true
      ? `${executable} was stopped after ${PROCESS_TIMEOUT_MS / 1000}s`
      : `${executable} exited with code ${error.code ?? "unknown"} and reported nothing`;
  return text.length <= PROCESS_FAILURE_TEXT_LIMIT ? text : text.slice(0, PROCESS_FAILURE_TEXT_LIMIT) + "…";
}

function runProcess(executable: string, args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    execFile(executable, [...args], { cwd, timeout: PROCESS_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        rejectProcess(new Error(processFailureText(executable, stderr, error), { cause: { command: `${executable} ${args.join(" ")}`, error } }));
        return;
      }
      resolveProcess({ stdout, stderr });
    });
  });
}

// A plugin registers its tools before pi-runtime acquires the tool registry, so an installed entry has to sit in the runtime's own group ahead of the runtime. Appended at the end of the profile it would load after the runtime and fail on every subsequent start.
function marketplaceProfileEntry(plugin: MarketplacePlugin, indent: string): string {
  const child = `${indent}  `;
  const group = plugin.profile.group === true ? `\n${child}group: true` : "";
  return `${indent}- id: marketplace-${plugin.id}\n${child}name: ${JSON.stringify(plugin.packageName)}${group}\n${child}config: ${JSON.stringify(plugin.profile.config)}\n`;
}

async function appendMarketplaceProfile(configPath: string, plugin: MarketplacePlugin, beforeEntryId?: string): Promise<string> {
  const source = await readFile(configPath, "utf8");
  if (source.includes(`name: ${JSON.stringify(plugin.packageName)}`)) return source;
  const anchor =
    beforeEntryId === undefined ? null : source.match(new RegExp(`^([ \\t]*)- id: ${beforeEntryId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[ \\t]*$`, "mu"));
  if (anchor === null) {
    await writeFile(configPath, `${source.replace(/\s*$/u, "")}\n${marketplaceProfileEntry(plugin, "")}`, "utf8");
    return source;
  }
  const start = anchor.index ?? 0;
  await writeFile(configPath, source.slice(0, start) + marketplaceProfileEntry(plugin, anchor[1] ?? "") + source.slice(start), "utf8");
  return source;
}

async function updateMarketplaceProfile(configPath: string, entryId: string, update: { disabled?: boolean; remove?: boolean }): Promise<string> {
  const source = await readFile(configPath, "utf8");
  const escapedId = entryId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^([ \\t]*)- id: ${escapedId}[ \\t]*(?:\\r?\\n|$)`, "m");
  const match = source.match(pattern);
  if (match === null) throw new Error(`Installed plugin profile entry was not found: ${entryId}`);
  const indent = match[1] ?? "";
  const start = match.index ?? 0;
  let end = source.length;
  const linePattern = /^([ \t]*)(?=\S)/gm;
  linePattern.lastIndex = start + match[0].length;
  for (let line = linePattern.exec(source); line !== null; line = linePattern.exec(source)) {
    const lineIndent = line[1] ?? "";
    const content = source.slice(line.index + lineIndent.length);
    if (lineIndent.length < indent.length || (lineIndent === indent && content.startsWith("- "))) {
      end = line.index;
      break;
    }
  }
  const originalBlock = source.slice(start, end);
  if (update.remove === true) {
    await writeFile(configPath, source.slice(0, start) + source.slice(end), "utf8");
    return source;
  }
  const childIndent = `${indent}  `;
  const disabledPattern = new RegExp(`^${childIndent}disabled: .*\\r?\\n`, "m");
  let block = originalBlock.replace(disabledPattern, "");
  if (update.disabled === true) {
    const namePattern = new RegExp(`^(${childIndent}name: .*\\r?\\n)`, "m");
    block = block.replace(namePattern, `$1${childIndent}disabled: true\n`);
  }
  await writeFile(configPath, source.slice(0, start) + block + source.slice(end), "utf8");
  return source;
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(jsonSafe(payload))}\n\n`);
}

type GitTermination = "timeout" | "output-limit";

// Node reports a maxBuffer overflow through a string error code and a timeout through `killed`; neither is a git exit status, so they must not be folded into an ordinary non-zero exit.
function gitTermination(error: ExecFileException | null): GitTermination | undefined {
  if (error === null) return undefined;
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output-limit";
  if (error.killed === true) return "timeout";
  return undefined;
}

function gitTerminationMessage(command: string, termination: GitTermination, timeoutMs = GIT_TIMEOUT_MS): string {
  return termination === "timeout"
    ? `git ${command} timed out after ${timeoutMs / 1000} seconds`
    : `git ${command} produced more output than the buffer limit allows`;
}

interface GitStatusEntry {
  readonly path: string;
  readonly status: string;
}

interface GitStatusResult {
  readonly entries: readonly GitStatusEntry[];
  readonly truncated: boolean;
}

// `-z` output is NUL-separated and never C-quoted, so non-ASCII names arrive verbatim and a rename carries its original path as the following field instead of an `old -> new` pair. The paths are relative to the repository root regardless of cwd, so they are rebased onto the cwd prefix to keep the contract with /api/files/diff, /api/files/commit and /api/files/revert, which resolve paths against the same cwd.
function parseGitStatus(output: string, prefix: string): GitStatusEntry[] {
  const fields = output.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
    entries.push({ path: prefix === "" ? path : posix.relative("/" + prefix, "/" + path), status: code.trim() || "??" });
  }
  return entries;
}

function gitStatusOutput(cwd: string): Promise<{ output: string; truncated: boolean }> {
  return new Promise((resolveStatus, rejectStatus) => {
    execFile(
      "git",
      ["status", "--porcelain", "-z", "--untracked-files=all"],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 512 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveStatus({ output: stdout, truncated: false });
          return;
        }
        const termination = gitTermination(error);
        if (termination === "output-limit") {
          // Keep the complete entries that arrived before the kill; the final entry may have been cut mid-path.
          resolveStatus({ output: stdout.slice(0, stdout.lastIndexOf("\0") + 1), truncated: true });
          return;
        }
        if (termination === undefined && error.code === 128 && /not a git repository/i.test(stderr)) {
          resolveStatus({ output: "", truncated: false });
          return;
        }
        rejectStatus(new Error(termination ? gitTerminationMessage("status", termination) : stderr.trim() || error.message, { cause: error }));
      },
    );
  });
}

async function gitStatus(cwd: string): Promise<GitStatusResult> {
  const { output, truncated } = await gitStatusOutput(cwd);
  if (output === "") return { entries: [], truncated };
  const prefix = await gitCommand(cwd, ["rev-parse", "--show-prefix"]);
  return { entries: parseGitStatus(output, prefix.code === 0 ? prefix.stdout.trim() : ""), truncated };
}

function gitDiff(cwd: string, path: string): Promise<string> {
  return new Promise((resolveOutput) => {
    execFile("git", ["diff", "--no-ext-diff", "--", path], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolveOutput(error && stdout.length === 0 ? "" : stdout),
    );
  });
}

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly terminated: GitTermination | undefined;
}

function gitCommand(cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitCommandResult> {
  return new Promise((resolveResult) => {
    execFile("git", [...args], { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolveResult({ stdout, stderr, code, terminated: gitTermination(error) });
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

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// The loader resolves a bare plugin specifier by walking node_modules from the profile file upwards, never from the shell the harness was started in, so a marketplace package has to land in the package that owns the profile or it installs successfully and then fails to load. Under a built-in profile that package is the harness home, which is why the launcher boots a copy there instead of the read-only one inside its own installation.
async function marketplaceInstallDirectory(configPath: string, fallback: string): Promise<string> {
  let directory = dirname(resolve(configPath));
  let parent = dirname(directory);
  while (parent !== directory) {
    if (await isFile(join(directory, "package.json"))) return directory;
    directory = parent;
    parent = dirname(directory);
  }
  return fallback;
}

// Where an installed plugin belongs in the running loader: inside the group that owns pi-runtime, immediately ahead of it. A profile without a runtime entry (the stdio CLI profile does have one, a hand-written profile may not) places the entry at the end of the root instead.
function runtimePlacement(loader: Loader): { groupEntryId: string | null; position: number; beforeEntryId: string } | undefined {
  const entries = [...loader.entries()];
  const runtime = entries.find((entry) => entry.options.name === RUNTIME_ENTRY_NAME);
  if (runtime === undefined) return undefined;
  const group = entries.find((entry) => entry.subgroup === runtime.parent);
  const position = runtime.parent.data.indexOf(runtime.options);
  // The loader addresses a nested group by its qualified id (`profile:agent`), while the profile file names the entry by its own id.
  return { groupEntryId: group?.id ?? null, position: position < 0 ? Infinity : position, beforeEntryId: runtime.options.id };
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
    if (escapesRoot(relativePath)) return new Error("path must stay inside the workspace");
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
    const events: StampedSessionEvent[] = [];
    const eventClients = new Set<ServerResponse>();
    const initialRunAt = Date.now();
    let runActivity: RunActivity | undefined = services.runtime.session.isStreaming
      ? {
          sessionId: services.runtime.session.sessionId,
          startedAt: initialRunAt,
          lastActivityAt: initialRunAt,
          phase: "starting",
        }
      : undefined;
    // Pi puts a wall-clock on a message payload and nowhere else, so a tool call has no time of its own and nothing downstream can recover when the harness saw it. The gateway is the one place that sees every event as it happens, so it stamps each one on arrival, and pairs a tool call's two events to record how long the call took.
    // The stamp is written onto the event rather than onto a copy: a copy would give every event a new identity, and the serializer's cycle detection reads identity, so a self-referential event would serialize one level deeper on every hop.
    const toolCallStartedAt = new Map<string, number>();
    const stampEvent = (event: AgentSessionEvent): StampedSessionEvent => {
      const receivedAt = Date.now();
      const toolCallId = (event as { readonly toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId === "string" && event.type === "tool_execution_start") {
        // A call whose end never arrives would otherwise keep its entry forever; the oldest is dropped rather than letting a stalled run grow the map without bound.
        if (toolCallStartedAt.size >= MAX_PENDING_TOOL_CALLS) {
          const oldest = toolCallStartedAt.keys().next().value;
          if (oldest !== undefined) toolCallStartedAt.delete(oldest);
        }
        toolCallStartedAt.set(toolCallId, receivedAt);
      }
      if (typeof toolCallId === "string" && event.type === "tool_execution_end") {
        const startedAt = toolCallStartedAt.get(toolCallId);
        toolCallStartedAt.delete(toolCallId);
        if (startedAt !== undefined) return Object.assign(event, { receivedAt, durationMs: receivedAt - startedAt });
      }
      return Object.assign(event, { receivedAt });
    };
    const handleEvent = (rawEvent: AgentSessionEvent) => {
      const event = stampEvent(rawEvent);
      const sessionId = services.runtime.session.sessionId;
      if (event.type === "agent_settled") {
        runActivity = undefined;
      } else if (event.type === "agent_start") {
        runActivity = { sessionId, startedAt: event.receivedAt, lastActivityAt: event.receivedAt, phase: "starting" };
      } else if (runActivity?.sessionId === sessionId || services.runtime.session.isStreaming) {
        const startedAt = runActivity?.sessionId === sessionId ? runActivity.startedAt : event.receivedAt;
        let phase = runActivity?.sessionId === sessionId ? runActivity.phase : "starting";
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "thinking_delta") phase = "thinking";
          if (event.assistantMessageEvent.type === "text_delta") phase = "responding";
        }
        if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") phase = "tool";
        runActivity = { sessionId, startedAt, lastActivityAt: event.receivedAt, phase };
      }
      // Streaming deltas reach clients live over SSE and each one carries the whole partial message, so only durable events are retained for snapshots.
      if (event.type !== "message_update") {
        events.push(event);
        if (events.length > MAX_RETAINED_EVENTS) events.splice(0, events.length - MAX_RETAINED_EVENTS);
      }
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
        sendJson(response, 200, createStatus(services, events, runActivity));
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
          // Replace the file atomically so an interrupted write never leaves a truncated settings.json behind; keep the existing permission bits. The rename must land on the resolved target, otherwise a symlinked settings.json (dotfiles repositories) would be replaced by a detached regular file.
          const path = await realpath(join(services.launch.agentDir, "settings.json")).catch(() => join(services.launch.agentDir, "settings.json"));
          const mode = await stat(path).then(
            (info) => info.mode & 0o777,
            () => 0o644,
          );
          await atomicWriteFile(path, JSON.stringify(parsed, null, 2) + "\n", { encoding: "utf8", mode });
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
      async handler(_request, response) {
        const loaded = services.loader ? [...services.loader.entries()].map(pluginSummary) : [];
        // The pending entries follow the loaded ones so a list that was stable before an install stays in the same order after it.
        const items = [...loaded, ...(await restartPendingSummaries(services))];
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
        const locale = url.searchParams.get("locale") ?? "";
        const page = Number(url.searchParams.get("page") ?? "0");
        const pageSize = Number(url.searchParams.get("pageSize") ?? "24");
        const sort = url.searchParams.get("sort") ?? "";
        if (
          query.length > 120 ||
          capability.length > 80 ||
          category.length > 80 ||
          locale.length > 20 ||
          !Number.isInteger(page) ||
          page < 0 ||
          !Number.isInteger(pageSize) ||
          pageSize < 1 ||
          pageSize > 100 ||
          (sort !== "" && sort !== "recommended")
        ) {
          sendJson(response, 400, { error: "Invalid marketplace query" });
          return;
        }
        const filtered = searchMarketplace(query, capability, category, locale);
        const cached = readCachedMarketplaceStatistics(MARKETPLACE_PLUGINS);
        // Recommendation is only applied once the whole catalogue has been looked up. Scoring a half-warm cache would reorder the grid under the reader's cursor on every poll as the background lookups land, which costs more than the few seconds the first sort is delayed.
        const items =
          sort === "recommended" && cached.ready ? sortMarketplaceByRecommendation(attachMarketplaceStatistics(filtered, cached.statistics)) : filtered;
        sendJson(response, 200, {
          ...paginateMarketplace(items, page, pageSize),
          capabilities: marketplaceCapabilities(locale),
          categories: marketplaceCategories(locale),
        });
      },
    });
    let marketplaceMutationInFlight = false;
    const disposeMarketplaceInstall = services.webServer.register({
      path: "/api/marketplace/install",
      async handler(request, response) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (marketplaceMutationInFlight) {
          sendJson(response, 409, { error: "Another marketplace plugin change is already running" });
          return;
        }
        const loader = services.loader;
        const configPath = services.launch.configPath;
        if (loader === undefined || configPath === undefined) {
          sendJson(response, 501, { error: "Plugin installation is unavailable for this runtime" });
          return;
        }
        marketplaceMutationInFlight = true;
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
          // A plugin already waiting for a restart is installed even though the loader has no entry for it, so installing it again would re-run npm and report a fresh restart for work that is already done.
          if ((await readMarketplaceProfileEntries(configPath)).some((entry) => entry.packageName === plugin.packageName)) {
            sendJson(response, 200, { plugin, installed: true, restartRequired: true });
            return;
          }
          const installDirectory = await marketplaceInstallDirectory(configPath, services.launch.cwd);
          const packageJsonPath = join(installDirectory, "package.json");
          const packageLockPath = join(installDirectory, "package-lock.json");
          const packageJsonBefore = await readFile(packageJsonPath, "utf8").catch(() => undefined);
          const packageLockBefore = await readFile(packageLockPath, "utf8").catch(() => undefined);
          const placement = runtimePlacement(loader);
          let profileBefore: string | undefined;
          let entryId: string | undefined;
          try {
            const specifier = `${marketplaceNpmPackageName(plugin.packageName)}@${plugin.version}`;
            await runProcess("npm", ["install", "--save-exact", "--package-lock=false", specifier], installDirectory);
            profileBefore = await appendMarketplaceProfile(configPath, plugin, placement?.beforeEntryId);
            entryId = await loader.create(
              {
                id: `marketplace-${plugin.id}`,
                name: plugin.packageName,
                ...(plugin.profile.group === true ? { group: true } : {}),
                config: plugin.profile.config,
              } as never,
              placement?.groupEntryId ?? null,
              placement?.position ?? Infinity,
            );
            const entry = loader.resolve(entryId);
            if (entry.fiber === undefined) throw new Error(`Plugin ${plugin.packageName} did not create a runtime fiber`);
            await entry.fiber.await();
            sendJson(response, 200, { plugin, installed: true, restartRequired: false });
          } catch (error) {
            if (entryId !== undefined) await loader.remove(entryId).catch(() => {});
            // The runtime holds the tool registry for its whole life and snapshots the tool set when it takes it, so a plugin that contributes tools cannot join a harness that is already running. The package and its profile entry stay in place and the plugin arrives on the next start; rolling the install back would leave the user unable to install it at all.
            if (isPiToolRegistryLeasedError(error)) {
              sendJson(response, 200, { plugin, installed: true, restartRequired: true });
              return;
            }
            if (profileBefore !== undefined) await writeFile(configPath, profileBefore, "utf8").catch(() => {});
            // A manifest npm created for this install is removed rather than left behind; restoring is only possible when one existed before.
            if (packageJsonBefore === undefined) await unlink(packageJsonPath).catch(() => {});
            else await writeFile(packageJsonPath, packageJsonBefore, "utf8").catch(() => {});
            if (packageLockBefore === undefined) await unlink(packageLockPath).catch(() => {});
            else await writeFile(packageLockPath, packageLockBefore, "utf8").catch(() => {});
            sendJson(response, 502, { error: errorText(error) });
          }
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        } finally {
          marketplaceMutationInFlight = false;
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
        if (marketplaceMutationInFlight) {
          sendJson(response, 409, { error: "Another marketplace plugin change is already running" });
          return;
        }
        marketplaceMutationInFlight = true;
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
          const profileEntryId = entry.options.id;
          const before = await updateMarketplaceProfile(configPath, profileEntryId, { disabled: !payload.enabled });
          try {
            await entry.update({ disabled: !payload.enabled });
            sendJson(response, 200, { plugin: pluginSummary(entry), restartRequired: false });
          } catch (error) {
            // Re-enabling a plugin that contributes tools cannot take effect in a harness the runtime already leased, so the profile keeps the change and the plugin comes back on the next start. Reverting it would leave a plugin that can be switched off but never on again.
            if (isPiToolRegistryLeasedError(error)) {
              sendJson(response, 200, { plugin: pluginSummary(entry), restartRequired: true });
              return;
            }
            await writeFile(configPath, before, "utf8").catch(() => {});
            sendJson(response, 502, { error: errorText(error) });
          }
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        } finally {
          marketplaceMutationInFlight = false;
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
        if (marketplaceMutationInFlight) {
          sendJson(response, 409, { error: "Another marketplace plugin change is already running" });
          return;
        }
        marketplaceMutationInFlight = true;
        try {
          const payload = JSON.parse(await bodyText(request)) as { id?: unknown };
          if (typeof payload.id !== "string") {
            sendJson(response, 400, { error: "A marketplace plugin id is required" });
            return;
          }
          const entry = [...loader.entries()].find((item) => item.id === payload.id || item.options.id === payload.id);
          if (entry === undefined) {
            // A plugin waiting for a restart has no loader entry to remove, only the profile entry and the package the install left behind. Refusing here left the user unable to undo an install until they restarted the very process they installed it to avoid restarting.
            const pending = (await readMarketplaceProfileEntries(configPath)).find((item) => item.id === payload.id);
            const pendingPlugin = pending === undefined ? undefined : MARKETPLACE_PLUGINS.find((item) => item.packageName === pending.packageName);
            if (pending === undefined || pendingPlugin === undefined) {
              sendJson(response, 404, { error: "Installed plugin was not found" });
              return;
            }
            const pendingProfileBefore = await readFile(configPath, "utf8");
            const pendingInstallDirectory = await marketplaceInstallDirectory(configPath, services.launch.cwd);
            try {
              await updateMarketplaceProfile(configPath, pending.id, { remove: true });
              await runProcess("npm", ["uninstall", "--package-lock=false", marketplaceNpmPackageName(pendingPlugin.packageName)], pendingInstallDirectory);
              sendJson(response, 200, { uninstalled: true, id: payload.id });
            } catch (error) {
              await writeFile(configPath, pendingProfileBefore, "utf8").catch(() => {});
              sendJson(response, 502, { error: errorText(error) });
            }
            return;
          }
          const plugin = marketplacePluginForEntry(entry);
          if (plugin === undefined) {
            sendJson(response, 403, { error: "Only marketplace plugins can be uninstalled" });
            return;
          }
          const profileEntryId = entry.options.id;
          const profileBefore = await readFile(configPath, "utf8");
          const installDirectory = await marketplaceInstallDirectory(configPath, services.launch.cwd);
          const packageJsonPath = join(installDirectory, "package.json");
          const packageLockPath = join(installDirectory, "package-lock.json");
          const packageJsonBefore = await readFile(packageJsonPath, "utf8").catch(() => undefined);
          const packageLockBefore = await readFile(packageLockPath, "utf8").catch(() => undefined);
          await entry.parent.remove(entry.options.id);
          entry.parent.tree.write();
          try {
            await updateMarketplaceProfile(configPath, profileEntryId, { remove: true });
            await runProcess("npm", ["uninstall", "--package-lock=false", marketplaceNpmPackageName(plugin.packageName)], installDirectory);
            sendJson(response, 200, { uninstalled: true, id: payload.id });
          } catch (error) {
            await writeFile(configPath, profileBefore, "utf8").catch(() => {});
            if (packageJsonBefore !== undefined) await writeFile(packageJsonPath, packageJsonBefore, "utf8").catch(() => {});
            if (packageLockBefore !== undefined) await writeFile(packageLockPath, packageLockBefore, "utf8").catch(() => {});
            const options = entry.options as { name: string; config?: unknown; group?: boolean | null };
            await loader
              .create({ id: entry.options.id, name: options.name, config: options.config, ...(options.group ? { group: true } : {}) } as never)
              .catch(() => {});
            sendJson(response, 502, { error: errorText(error) });
          }
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        } finally {
          marketplaceMutationInFlight = false;
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
        let status: GitStatusResult;
        try {
          status = await gitStatus(activeCwd(services));
        } catch (error) {
          sendJson(response, 500, { error: errorText(error) });
          return;
        }
        const items = status.entries.map((entry) => ({
          path: entry.path,
          status: entry.status,
          label: entry.status === "??" ? "untracked" : entry.status.includes("D") ? "deleted" : entry.status.includes("A") ? "added" : "modified",
        }));
        sendJson(response, 200, { items, ...(status.truncated ? { truncated: true } : {}) });
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
        if (escapesRoot(relativePath)) {
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
          const add = await gitCommand(root, ["add", "-A", "--", ...paths], GIT_MUTATION_TIMEOUT_MS);
          if (add.terminated) {
            sendJson(response, 500, { error: gitTerminationMessage("add", add.terminated, GIT_MUTATION_TIMEOUT_MS) });
            return;
          }
          if (add.code !== 0) {
            sendJson(response, 409, { error: add.stderr.trim() || "Unable to stage workspace files" });
            return;
          }
          const commit = await gitCommand(root, ["commit", "-m", payload.message.trim(), "--", ...paths], GIT_MUTATION_TIMEOUT_MS);
          if (commit.terminated) {
            sendJson(response, 500, { error: gitTerminationMessage("commit", commit.terminated, GIT_MUTATION_TIMEOUT_MS) });
            return;
          }
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
          const untracked = await gitCommand(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...paths]);
          // `git restore` refuses the whole request when any pathspec is unknown to it, so restore only the paths git tracks. `--with-tree=HEAD` keeps staged deletions in the list; it fails on an unborn HEAD, where the plain index listing is all there is.
          let tracked = await gitCommand(root, ["ls-files", "-z", "--with-tree=HEAD", "--", ...paths]);
          if (tracked.code !== 0 && tracked.terminated === undefined) tracked = await gitCommand(root, ["ls-files", "-z", "--", ...paths]);
          const listing = [untracked, tracked].find((result) => result.terminated !== undefined || result.code !== 0);
          if (listing) {
            if (listing.terminated) sendJson(response, 500, { error: gitTerminationMessage("ls-files", listing.terminated) });
            else sendJson(response, 409, { error: listing.stderr.trim() || "Unable to inspect workspace files" });
            return;
          }
          const untrackedPaths = untracked.stdout.split("\0").filter(Boolean);
          const trackedPaths = tracked.stdout.split("\0").filter(Boolean);
          const known = [...untrackedPaths, ...trackedPaths];
          const unknown = paths.filter((path) => !known.some((candidate) => candidate === path || candidate.startsWith(path + "/")));
          if (unknown.length > 0) {
            sendJson(response, 409, { error: `Paths did not match any file known to git: ${unknown.join(", ")}` });
            return;
          }
          if (trackedPaths.length > 0) {
            const restore = await gitCommand(root, ["restore", "--worktree", "--staged", "--", ...trackedPaths], GIT_MUTATION_TIMEOUT_MS);
            if (restore.terminated) {
              sendJson(response, 500, { error: gitTerminationMessage("restore", restore.terminated, GIT_MUTATION_TIMEOUT_MS) });
              return;
            }
            if (restore.code !== 0) {
              sendJson(response, 409, { error: restore.stderr.trim() || "Unable to restore workspace files" });
              return;
            }
          }
          for (const path of untrackedPaths) {
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
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        let ownsBusy = false;
        let unsubscribe: (() => void) | undefined;
        try {
          const payload = JSON.parse(await bodyText(request)) as { prompt?: unknown; streamingBehavior?: unknown };
          if (typeof payload.prompt !== "string" || payload.prompt.trim().length === 0) {
            sendJson(response, 400, { error: "Prompt must be a non-empty string" });
            return;
          }
          if (payload.streamingBehavior !== undefined && payload.streamingBehavior !== "steer" && payload.streamingBehavior !== "followUp") {
            sendJson(response, 400, { error: 'streamingBehavior must be "steer" or "followUp"' });
            return;
          }
          const streamingBehavior = payload.streamingBehavior;
          if (services.runtime.session.isStreaming) {
            if (!streamingBehavior) {
              sendJson(response, 409, { error: "Another prompt is already running; choose steer or followUp delivery" });
              return;
            }
            await services.runtime.prompt(payload.prompt, { streamingBehavior });
            sendJson(response, 200, {
              reply: "",
              messages: services.runtime.session.messages.length,
              queued: true,
              streamingBehavior,
            });
            return;
          }
          if (busy) {
            sendJson(response, 409, { error: "Another prompt is already running" });
            return;
          }
          busy = true;
          ownsBusy = true;
          const chunks: string[] = [];
          unsubscribe = services.runtime.session.subscribe((event) => {
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") chunks.push(event.assistantMessageEvent.delta);
          });
          await services.runtime.prompt(payload.prompt);
          const last = services.runtime.session.messages.at(-1);
          if (last?.role === "assistant" && last.stopReason === "error") {
            sendJson(response, 502, { error: last.errorMessage ?? "Request error" });
            return;
          }
          sendJson(response, 200, {
            reply: chunks.join(""),
            messages: services.runtime.session.messages.length,
            ...(last?.role === "assistant" && last.stopReason === "aborted" ? { aborted: true } : {}),
          });
        } catch (error) {
          sendJson(response, 400, { error: errorText(error) });
        } finally {
          unsubscribe?.();
          if (ownsBusy) busy = false;
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
      async handler(_request, response) {
        try {
          sendJson(response, 200, jsonSafe(await createSessionSnapshot(services, events, context.logger)));
        } catch (error) {
          sendJson(response, 500, { error: errorText(error) });
        }
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
          sendJson(response, 200, jsonSafe(await createSessionSnapshot(services, [], context.logger, services.runtime.sessionRuntime ? undefined : [])));
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
          const items = await SessionManager.list(activeCwd(services), manager.getSessionDir());
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
          sendJson(response, 200, jsonSafe(await createSessionSnapshot(services, [], context.logger)));
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
          if (path === services.runtime.session.sessionFile && typeof manager.appendSessionInfo === "function") {
            manager.appendSessionInfo(name);
            if (name) persistSessionBeforeFirstAssistant(manager);
          } else {
            SessionManager.open(path, manager.getSessionDir()).appendSessionInfo(name);
          }
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
          await mutateSessionMetadata(manager, context.logger, (metadata) => {
            delete metadata[path];
          });
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
          const nextMetadata = await mutateSessionMetadata(manager, context.logger, (metadata) => {
            const currentMetadata = metadata[path] ?? {};
            const updated: SessionMetadata = {
              ...currentMetadata,
              ...(payload.archived === undefined ? {} : { archived: payload.archived === true }),
              ...(payload.pinned === undefined ? {} : { pinned: payload.pinned === true }),
            };
            metadata[path] = updated;
            return updated;
          });
          sendJson(response, 200, { path, metadata: nextMetadata });
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
          if (action === "delete") {
            // The unlinks run outside the metadata mutation: a failure halfway through must not discard the key removals for the files that are already gone from disk.
            const removed: string[] = [];
            const failed: { path: string; error: string }[] = [];
            for (const path of paths) {
              try {
                await unlink(path);
                removed.push(path);
              } catch (error) {
                // A session another tab already deleted leaves nothing to unlink, but its metadata entry still has to go.
                if ((error as NodeJS.ErrnoException).code === "ENOENT") removed.push(path);
                else failed.push({ path, error: errorText(error) });
              }
            }
            await mutateSessionMetadata(manager, context.logger, (metadata) => {
              for (const path of removed) delete metadata[path];
            });
            if (failed.length > 0) {
              sendJson(response, 409, {
                error: `Some sessions could not be deleted: ${failed.map((item) => item.path).join(", ")}`,
                action,
                count: removed.length,
                failed,
              });
              return;
            }
            sendJson(response, 200, { action, count: removed.length });
            return;
          }
          await mutateSessionMetadata(manager, context.logger, (metadata) => {
            for (const path of paths) {
              const current = metadata[path] ?? {};
              metadata[path] = {
                ...current,
                ...(action === "archive" || action === "unarchive" ? { archived: action === "archive" } : {}),
                ...(action === "pin" || action === "unpin" ? { pinned: action === "pin" } : {}),
              };
            }
          });
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
          const sessions = await SessionManager.list(activeCwd(services), manager.getSessionDir());
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
          const payload = JSON.parse(await bodyText(request, IMPORT_BODY_LIMIT_BYTES)) as {
            path?: unknown;
            content?: unknown;
            filename?: unknown;
            cwd?: unknown;
          };
          const suppliedPath = typeof payload.path === "string" ? payload.path : "";
          const content = typeof payload.content === "string" ? payload.content : undefined;
          // `path` reads an existing file and `content` is written to a private temporary file; accepting both would let the request choose where the content lands.
          if (suppliedPath && content !== undefined) {
            sendJson(response, 400, { error: "Provide either a JSONL file path or file content, not both" });
            return;
          }
          if (content === undefined && (!suppliedPath || !isAbsolute(suppliedPath) || !suppliedPath.endsWith(".jsonl"))) {
            sendJson(response, 400, { error: "An absolute .jsonl file path or file content is required" });
            return;
          }
          const manager = services.runtime.session.sessionManager;
          if (!manager.isPersisted()) {
            sendJson(response, 409, { error: "Session importing requires JSONL session storage" });
            return;
          }
          const targetCwd = typeof payload.cwd === "string" && payload.cwd.trim() ? resolve(payload.cwd) : activeCwd(services);
          const temporaryDirectory = content === undefined ? undefined : await mkdtemp(join(tmpdir(), "pi-harness-import-"));
          const requestedName = basename(typeof payload.filename === "string" && payload.filename.trim() ? payload.filename : "import.jsonl");
          const importName = requestedName === "" || requestedName === "." || requestedName === ".." ? "import.jsonl" : requestedName;
          const importPath = temporaryDirectory === undefined ? suppliedPath : join(temporaryDirectory, importName);
          try {
            if (content !== undefined) {
              if (Buffer.byteLength(content, "utf8") > IMPORT_CONTENT_LIMIT_BYTES) {
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
          sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: errorText(error) });
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
          const metadata = await readSessionMetadataLocked(manager, context.logger);
          const items =
            typeof manager.isPersisted === "function" && manager.isPersisted() ? await SessionManager.list(activeCwd(services), manager.getSessionDir()) : [];
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
