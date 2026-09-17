import { createHash } from "node:crypto";
import { execFile, type ExecFileException } from "node:child_process";
import { constants, existsSync, lstatSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  parseSessionEntries,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
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
  marketplaceInstallPlan,
  marketplaceNpmPackageName,
  marketplaceCapabilities,
  marketplaceCategories,
  sortMarketplaceByRecommendation,
  type MarketplacePlugin,
} from "./marketplace.js";
import { resolveSessionToolPath } from "./session-tool-path.js";
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
/** A session event with gateway-owned arrival time, tool duration, and authoritative post-tool run phase. */
type StampedSessionEvent = AgentSessionEvent & { readonly receivedAt: number; readonly durationMs?: number; readonly runPhase?: RunActivity["phase"] };
type RunPhase = "starting" | "thinking" | "responding" | "tool" | "compacting";
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
const MAX_WORKSPACE_FILES = 5_000;
const MAX_WORKSPACE_FILE_CANDIDATES = 20_000;
const MAX_WORKSPACE_DIRECTORIES = 2_000;
const MAX_WORKSPACE_DEPTH = 16;
const MAX_WORKSPACE_FILE_PREVIEW_BYTES = 512 * 1024;
const WORKSPACE_FILE_CACHE_MS = 1_000;
const IGNORED_WORKSPACE_DIRECTORIES = new Set([".git", "node_modules", ".pi", "dist", "build"]);
const SESSION_HEADER_PROBE_BYTES = 64 * 1024;

class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "PayloadTooLargeError";
  }
}

/** A session header version this build can read. The import route has always refused anything newer, and a file that is already in the session directory is exactly as unreadable, so the read paths ask the same question rather than adopting a format the gateway has declared it cannot parse and then appending current-version records to it. */
function supportedSessionVersion(version: unknown): boolean {
  return typeof version === "number" && Number.isInteger(version) && version >= 1 && version <= CURRENT_SESSION_VERSION;
}

/** Reads the version off a session file's header without pulling a whole transcript into memory: the header is the first line, and the session list would otherwise read every file it lists end to end a second time. Undefined when no header could be read, which leaves such a file exactly as it is treated today. */
async function sessionFileVersion(path: string): Promise<number | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(SESSION_HEADER_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SESSION_HEADER_PROBE_BYTES, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const newline = text.indexOf("\n");
    if (newline === -1 && bytesRead === SESSION_HEADER_PROBE_BYTES) return undefined;
    const header: unknown = JSON.parse(newline === -1 ? text : text.slice(0, newline));
    if (header === null || typeof header !== "object" || (header as { type?: unknown }).type !== "session") return undefined;
    const version = (header as { version?: unknown }).version ?? 1;
    return typeof version === "number" ? version : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function validateImportedSession(content: string): void {
  let hasHeader = false;
  let version = 1;
  const nodes = new Map<string, { parentId: string | null; line: number }>();
  const invalid = (line: number, reason: string): never => {
    throw new Error(`Invalid session at line ${line}: ${reason}; no session was imported`);
  };
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid(lineNumber, "malformed JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) invalid(lineNumber, "expected a record");
    const entry = parsed as Record<string, unknown>;
    if (typeof entry.type !== "string" || !entry.type) invalid(lineNumber, "missing record type");
    if (!hasHeader) {
      if (entry.type !== "session" || typeof entry.id !== "string" || !entry.id) invalid(lineNumber, "expected a session header");
      const requestedVersion = entry.version ?? 1;
      if (!supportedSessionVersion(requestedVersion)) invalid(lineNumber, "unsupported session version");
      version = requestedVersion as number;
      hasHeader = true;
      continue;
    }
    if (entry.type === "session") invalid(lineNumber, "duplicate session header");
    if (entry.type === "message") {
      const message = entry.message;
      if (
        message === null ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        !("role" in message) ||
        typeof message.role !== "string" ||
        !message.role
      ) {
        invalid(lineNumber, "invalid message");
      }
    }
    // Version 1 receives IDs and a linear parent chain during upstream migration.
    if (version < 2) continue;
    if (typeof entry.id !== "string" || !entry.id) invalid(lineNumber, "missing record ID");
    const id = entry.id as string;
    if (nodes.has(id)) invalid(lineNumber, "duplicate record ID");
    if (entry.parentId !== null && typeof entry.parentId !== "string") invalid(lineNumber, "invalid parent ID");
    nodes.set(id, { parentId: entry.parentId as string | null, line: lineNumber });
  }
  if (!hasHeader) throw new Error("Imported session is empty; no session was imported");
  const checked = new Set<string>();
  for (const [id, node] of nodes) {
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && !checked.has(current)) {
      if (path.has(current)) invalid(node.line, "cyclic parent chain");
      path.add(current);
      const ancestor = nodes.get(current);
      if (!ancestor) invalid(node.line, "missing parent record");
      current = ancestor!.parentId;
    }
    for (const visited of path) checked.add(visited);
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

// A multi-byte UTF-8 sequence can straddle a chunk boundary, so the raw bytes are collected and decoded once; decoding each chunk on its own would replace the split sequence with U+FFFD.
// Reading and parsing the request belongs to the client's half of the exchange. Both provider routes used to do it inside the try whose catch reports an upstream failure, so malformed JSON and an oversized body came back as 502 Bad Gateway — blaming the provider for something the caller sent. This returns the provider name, or sends the error and returns undefined.
async function providerFromBody(request: IncomingMessage, response: ServerResponse): Promise<string | undefined> {
  let payload: { provider?: unknown };
  try {
    payload = JSON.parse(await bodyText(request)) as { provider?: unknown };
  } catch (error) {
    sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: errorText(error) });
    return undefined;
  }
  if (typeof payload.provider !== "string" || payload.provider.trim() === "") {
    sendJson(response, 400, { error: "provider is required" });
    return undefined;
  }
  return payload.provider;
}

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

function sessionIsBusy(services: ApiServices): boolean {
  return services.runtime.session.isStreaming || services.runtime.session.isCompacting;
}

function createStatus(services: ApiServices, events: readonly AgentSessionEvent[], runActivity: RunActivity | undefined) {
  const activeModel = services.runtime.session.model ?? services.models.model;
  const cwd = activeCwd(services);
  const currentRun =
    sessionIsBusy(services) && runActivity?.sessionId === services.runtime.session.sessionId
      ? {
          startedAt: new Date(runActivity.startedAt).toISOString(),
          lastActivityAt: new Date(runActivity.lastActivityAt).toISOString(),
          phase: services.runtime.session.isCompacting ? "compacting" : runActivity.phase,
        }
      : undefined;
  return {
    processStartedAt: PROCESS_STARTED_AT,
    status: sessionIsBusy(services) ? "running" : "ready",
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
    forked: typeof manager?.getHeader === "function" && typeof manager.getHeader()?.parentSession === "string",
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
  if (relativePath === "" || relativePath.includes(sep) || escapesRoot(relativePath) || !target.endsWith(".jsonl")) return false;
  // Session paths are supplied by the browser and are later opened, renamed, exported or unlinked. A lexical containment check is not enough: a symlinked component could redirect those operations outside the session directory. Missing final paths are allowed for the active session's deferred persistence, but every existing component must be a real directory/file.
  let current = root;
  for (const component of relativePath.split(sep)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return false;
    }
  }
  return true;
}

/**
 * Pi defers creating a session's JSONL file until its first entry, so the active session may legitimately have
 * no file yet. Every other path that does not exist names a session that was deleted or moved, and acting on it
 * writes nothing a reader can ever see — /api/session/export and /api/session/fork already say so in their own
 * comments, and /api/session/open answers 404.
 */
function sessionMissing(path: string, activeSessionFile: string | undefined): boolean {
  return path !== activeSessionFile && !existsSync(path);
}

/**
 * When a session was last itself. Pi derives `modified` from the activity time of the last message in the transcript, and a duplicate copies the source's messages verbatim, so a copy made a minute ago reports the activity time of the conversation it was copied from: `created` is today and `modified` is four days ago on the very same item, and the copy sorts last in a list ordered by `modified`. The header stamp the fork route writes is the one moment the copy can prove about itself, so the later of the two is what the list orders and groups on.
 */
function sessionRecency(item: { readonly created: Date; readonly modified: Date }): number {
  return Math.max(item.modified.getTime(), item.created.getTime());
}

function sessionHeaderVersion(content: Buffer): number {
  const header = parseSessionEntries(content.toString("utf8")).find((entry) => entry.type === "session") as { version?: unknown } | undefined;
  return typeof header?.version === "number" ? header.version : 1;
}

/**
 * forkFrom copies the source's entries verbatim but stamps the new header with CURRENT_SESSION_VERSION, so a fork of
 * an older session ends up claiming to be current while its entries are still in the old shape. The next reader sees
 * a current version and skips the migration that would have repaired them, and for a v1 source that migration is the
 * only thing that assigns id and parentId — without it every entry's parentId is undefined and the walk back from the
 * leaf stops after one entry, so a whole transcript reads as its last message alone.
 *
 * Measured on a constructed v1 session with four entries: the source reads back four entries from the leaf, the fork
 * reads back one. Restating the source's version on the copy lets migrateSessionEntries do its work, and it stamps
 * the header itself once it is done. Migration touches only `version` on the header, so the parentSession this route
 * recorded is preserved.
 */
function migratedForkContent(staged: Buffer, sourceContent: Buffer): Buffer {
  const sourceVersion = sessionHeaderVersion(sourceContent);
  if (sourceVersion >= CURRENT_SESSION_VERSION) return staged;
  const entries = parseSessionEntries(staged.toString("utf8"));
  const header = entries.find((entry): entry is FileEntry & { version?: number } => entry.type === "session");
  if (!header) return staged;
  header.version = sourceVersion;
  migrateSessionEntries(entries);
  return Buffer.from(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function canonicalSessionPath(path: string, manager: SessionManager): string | undefined {
  if (!sessionPathInDirectory(path, manager)) return undefined;
  const root = resolve(manager.getSessionDir());
  const target = resolve(path);
  try {
    const canonicalRoot = realpathSync.native(root);
    const canonicalTarget = realpathSync.native(target);
    if (dirname(canonicalTarget) !== canonicalRoot) return undefined;
    return join(root, basename(canonicalTarget));
  } catch (error) {
    // Pi can defer creating the active session file until its first entry. Its resolved direct-child path is still the unique identity while absent.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
    return undefined;
  }
}

interface SessionRootIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

function sessionRootIdentity(manager: SessionManager): SessionRootIdentity | undefined {
  const path = resolve(manager.getSessionDir());
  try {
    const details = statSync(path);
    if (!details.isDirectory()) return undefined;
    return { path, device: details.dev, inode: details.ino };
  } catch {
    return undefined;
  }
}

function sessionRootMatches(manager: SessionManager, expected: SessionRootIdentity): boolean {
  const current = sessionRootIdentity(manager);
  return current !== undefined && current.path === expected.path && current.device === expected.device && current.inode === expected.inode;
}

function persistSessionBeforeFirstAssistant(manager: SessionManager): void {
  const path = manager.getSessionFile();
  if (!path || existsSync(path)) return;
  const header = manager.getHeader();
  if (!header) throw new Error("Current session is missing its header");
  // Pi defers creating a JSONL file until the first assistant response. Names and accepted prompt receipts must survive a restart too: persist the tree now, then reopen the same path so subsequent entries append instead of recreating the file.
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

function marketplaceDependencyBlockers(plugin: MarketplacePlugin, installedPackages: ReadonlySet<string>): readonly MarketplacePlugin[] {
  return MARKETPLACE_PLUGINS.filter((candidate) => installedPackages.has(candidate.packageName) && candidate.dependencies?.includes(plugin.id) === true);
}

type MarketplaceProfileEntry = { readonly id: string; readonly packageName: string; readonly disabled: boolean };

function marketplaceEnabledPackages(loaderEntries: readonly LoaderEntrySummary[], profileEntries: readonly MarketplaceProfileEntry[]): ReadonlySet<string> {
  const configuredPackages = new Set(profileEntries.map((entry) => entry.packageName));
  const enabledPackages = new Set(profileEntries.filter((entry) => !entry.disabled).map((entry) => entry.packageName));
  for (const entry of loaderEntries) {
    if (!configuredPackages.has(entry.options.name) && !entry.options.disabled) enabledPackages.add(entry.options.name);
  }
  return enabledPackages;
}

function marketplaceActivePackages(loaderEntries: readonly LoaderEntrySummary[], profileEntries: readonly MarketplaceProfileEntry[]): ReadonlySet<string> {
  const configured = new Map(profileEntries.map((entry) => [entry.packageName, entry]));
  return new Set(
    loaderEntries.filter((entry) => !entry.options.disabled && configured.get(entry.options.name)?.disabled !== true).map((entry) => entry.options.name),
  );
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
const MARKETPLACE_PROFILE_ENTRY_PATTERN = /^[ \t]*- id: (marketplace-\S+)[ \t]*\r?\n([ \t]+)name: "([^"]+)"(?:\r?\n\2disabled: (true|false))?/gmu;

/** The loader holds what is running; the profile file holds what is installed. The two differ for a plugin that contributes tools, which cannot join a harness that is already running: the install leaves its package and its profile entry in place and the plugin arrives on the next start. Reading only the loader makes that plugin indistinguishable from one that was never installed, which is why the console answered an install that had just succeeded with "nothing is installed" and then could not uninstall what it had hidden. */
async function readMarketplaceProfileEntries(configPath: string): Promise<readonly MarketplaceProfileEntry[]> {
  const source = await readFile(configPath, "utf8").catch(() => undefined);
  if (source === undefined) return [];
  const entries: { id: string; packageName: string; disabled: boolean }[] = [];
  for (const match of source.matchAll(MARKETPLACE_PROFILE_ENTRY_PATTERN))
    entries.push({ id: match[1] ?? "", packageName: match[3] ?? "", disabled: match[4] === "true" });
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
  readonly repository: boolean;
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

function gitStatusOutput(cwd: string): Promise<{ output: string; truncated: boolean; repository: boolean }> {
  return new Promise((resolveStatus, rejectStatus) => {
    execFile(
      "git",
      ["status", "--porcelain", "-z", "--untracked-files=all"],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 512 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveStatus({ output: stdout, truncated: false, repository: true });
          return;
        }
        const termination = gitTermination(error);
        if (termination === "output-limit") {
          // Keep the complete entries that arrived before the kill; the final entry may have been cut mid-path.
          resolveStatus({ output: stdout.slice(0, stdout.lastIndexOf("\0") + 1), truncated: true, repository: true });
          return;
        }
        if (termination === undefined && error.code === 128 && /not a git repository/i.test(stderr)) {
          resolveStatus({ output: "", truncated: false, repository: false });
          return;
        }
        rejectStatus(new Error(termination ? gitTerminationMessage("status", termination) : stderr.trim() || error.message, { cause: error }));
      },
    );
  });
}

async function gitStatus(cwd: string): Promise<GitStatusResult> {
  const { output, truncated, repository } = await gitStatusOutput(cwd);
  if (output === "") return { entries: [], truncated, repository };
  const prefix = await gitCommand(cwd, ["rev-parse", "--show-prefix"]);
  return { entries: parseGitStatus(output, prefix.code === 0 ? prefix.stdout.trim() : ""), truncated, repository };
}

interface SessionFileMutation {
  readonly path: string;
  readonly status: "A" | "M" | "D";
  readonly label: "generated" | "modified" | "deleted";
}

interface ContainedWorkspacePath {
  readonly absolute: string;
  readonly relativePath: string;
}

async function containedWorkspacePath(root: string, requested: string): Promise<ContainedWorkspacePath | undefined> {
  const absolute = resolve(root, requested);
  const relativePath = relative(root, absolute);
  if (relativePath === "" || escapesRoot(relativePath)) return undefined;
  let ancestor = dirname(absolute);
  try {
    const canonicalRoot = await realpath(root);
    for (;;) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        if (escapesRoot(relative(canonicalRoot, canonicalAncestor))) return undefined;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        const parent = dirname(ancestor);
        if (parent === ancestor) return undefined;
        ancestor = parent;
      }
    }
  } catch {
    return undefined;
  }
  return { absolute, relativePath };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function sessionBranchMessages(session: ApiServices["runtime"]["session"]): readonly unknown[] {
  const manager = session.sessionManager;
  if (typeof manager?.getBranch === "function") {
    return manager
      .getBranch()
      .map((entry) => (entry.type === "message" ? entry.message : undefined))
      .filter((message) => message !== undefined);
  }
  return session.messages;
}

async function sessionFileMutations(session: ApiServices["runtime"]["session"], root: string): Promise<readonly SessionFileMutation[]> {
  const calls = new Map<string, { readonly path: string; readonly tool: "write" | "edit" | "delete" }>();
  const sources = new Map<string, SessionFileMutation>();
  const mutations = new Map<string, SessionFileMutation>();
  for (const rawMessage of sessionBranchMessages(session)) {
    const message = objectValue(rawMessage);
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const rawContent of message.content) {
        const content = objectValue(rawContent);
        const tool = content?.name;
        const id = content?.id;
        const input = objectValue(content?.arguments);
        if (
          content?.type === "toolCall" &&
          typeof id === "string" &&
          (tool === "write" || tool === "edit" || tool === "delete") &&
          typeof input?.path === "string"
        ) {
          calls.set(id, { path: input.path, tool });
        }
      }
      continue;
    }
    if (message?.role !== "toolResult" || message.isError === true || typeof message.toolCallId !== "string") continue;
    const call = calls.get(message.toolCallId);
    if (call === undefined) continue;
    const absolute = resolveSessionToolPath(root, call.path);
    if (absolute === undefined) continue;
    const path = relative(root, absolute).split(sep).join("/");
    if (path === "" || escapesRoot(path)) continue;
    let mutation: SessionFileMutation;
    if (call.tool === "delete") {
      mutation = { path, status: "D", label: "deleted" };
    } else {
      mutation = sources.get(path) ?? (call.tool === "write" ? { path, status: "A", label: "generated" } : { path, status: "M", label: "modified" });
      sources.set(path, mutation);
    }
    mutations.set(path, mutation);
  }
  const existing = await Promise.all(
    [...mutations.values()].map(async (mutation) => {
      const target = await containedWorkspacePath(root, mutation.path);
      if (target === undefined) return undefined;
      if (mutation.status === "D") return mutation;
      try {
        return (await lstat(target.absolute)).isFile() ? mutation : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return existing.filter((mutation) => mutation !== undefined).sort((left, right) => left.path.localeCompare(right.path));
}

async function gitDiff(cwd: string, path: string): Promise<string> {
  // Compare against HEAD so both staged and unstaged edits are visible in the
  // review pane. A plain `git diff` silently hides anything already staged.
  const trackedDiff = await gitCommand(cwd, ["diff", "--no-ext-diff", "HEAD", "--", path]);
  if (trackedDiff.stdout.length > 0) return trackedDiff.stdout;
  // A freshly initialized repository may not have a HEAD yet. In that case,
  // staged additions are still reviewable through the index even though the
  // HEAD comparison exits with code 128.
  if (trackedDiff.code !== 0) {
    const stagedDiff = await gitCommand(cwd, ["diff", "--no-ext-diff", "--cached", "--", path]);
    if (stagedDiff.stdout.length > 0) return stagedDiff.stdout;
  }

  // `git diff` intentionally omits untracked files, but the file status view
  // exposes them with a diff action. Generate the same patch a staged add
  // would show, without changing the index or working tree.
  const status = await gitCommand(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--", path]);
  if (status.code !== 0 && /not a git repository/iu.test(status.stderr)) {
    const snapshot = await gitCommand(cwd, ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", path]);
    return snapshot.stdout;
  }
  if (status.code !== 0 || !/^\?\? /u.test(status.stdout)) return "";
  const untrackedDiff = await gitCommand(cwd, ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", path]);
  return untrackedDiff.stdout;
}

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly terminated: GitTermination | undefined;
}

function gitCommand(cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitCommandResult> {
  return new Promise((resolveResult) => {
    // Workspace actions receive concrete paths, including filenames containing Git glob or pathspec magic characters.
    execFile("git", ["--literal-pathspecs", ...args], { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolveResult({ stdout, stderr, code, terminated: gitTermination(error) });
    });
  });
}

interface WorkspaceFileCatalogue {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

function ignoredWorkspaceDirectory(name: string): boolean {
  return IGNORED_WORKSPACE_DIRECTORIES.has(process.platform === "win32" || process.platform === "darwin" ? name.toLowerCase() : name);
}

async function existingWorkspaceFiles(root: string, candidates: readonly string[], truncated: boolean): Promise<WorkspaceFileCatalogue> {
  const canonicalRoot = await realpath(resolve(root));
  const paths: string[] = [];
  for (let start = 0; start < candidates.length && paths.length < MAX_WORKSPACE_FILES; start += 64) {
    const batch = candidates.slice(start, start + 64);
    const existing = await Promise.all(
      batch.map(async (path) => {
        const target = resolve(canonicalRoot, path);
        if (escapesRoot(relative(canonicalRoot, target))) return undefined;
        try {
          const canonical = await realpath(target);
          if (escapesRoot(relative(canonicalRoot, canonical)) || !(await stat(canonical)).isFile()) return undefined;
          return path;
        } catch {
          return undefined;
        }
      }),
    );
    for (const path of existing) {
      if (path !== undefined) paths.push(path);
      if (paths.length >= MAX_WORKSPACE_FILES) break;
    }
  }
  return { paths: paths.sort(), truncated: truncated || paths.length >= MAX_WORKSPACE_FILES };
}

async function gitWorkspaceFiles(root: string): Promise<WorkspaceFileCatalogue | undefined> {
  const result = await gitCommand(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"]);
  if (result.code !== 0 && result.terminated !== "output-limit") {
    if (/not a git repository/iu.test(result.stderr)) return undefined;
    throw new Error(result.terminated ? gitTerminationMessage("ls-files", result.terminated) : result.stderr.trim() || "Unable to list workspace files");
  }
  const lastBoundary = result.stdout.lastIndexOf("\0");
  const completeOutput = result.terminated === "output-limit" ? result.stdout.slice(0, lastBoundary + 1) : result.stdout;
  const allCandidates = [...new Set(completeOutput.split("\0").filter((path) => path !== "" && !path.includes("\uFFFD")))];
  const candidates = allCandidates.slice(0, MAX_WORKSPACE_FILE_CANDIDATES);
  return existingWorkspaceFiles(root, candidates, result.terminated === "output-limit" || allCandidates.length > candidates.length);
}

async function walkedWorkspaceFiles(root: string): Promise<WorkspaceFileCatalogue> {
  const canonicalRoot = await realpath(resolve(root));
  const pending: Array<{ readonly directory: string; readonly depth: number }> = [{ directory: canonicalRoot, depth: 0 }];
  const paths: string[] = [];
  let directories = 0;
  let scanned = 0;
  let truncated = false;
  while (pending.length > 0 && paths.length < MAX_WORKSPACE_FILES && directories < MAX_WORKSPACE_DIRECTORIES && scanned < MAX_WORKSPACE_FILE_CANDIDATES) {
    const current = pending.shift();
    if (current === undefined) break;
    directories += 1;
    try {
      const handle = await opendir(current.directory);
      for await (const entry of handle) {
        scanned += 1;
        if (scanned > MAX_WORKSPACE_FILE_CANDIDATES) {
          truncated = true;
          break;
        }
        const name = entry.name;
        if (name.includes("\uFFFD")) {
          truncated = true;
          continue;
        }
        const target = join(current.directory, name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isFile()) {
          paths.push(relative(canonicalRoot, target).split(sep).join("/"));
          if (paths.length >= MAX_WORKSPACE_FILES) {
            truncated = true;
            break;
          }
        } else if (entry.isDirectory() && !ignoredWorkspaceDirectory(name)) {
          if (current.depth >= MAX_WORKSPACE_DEPTH) truncated = true;
          else pending.push({ directory: target, depth: current.depth + 1 });
        }
      }
    } catch (error) {
      if (current.directory === canonicalRoot) throw error;
      truncated = true;
    }
  }
  if (pending.length > 0 || directories >= MAX_WORKSPACE_DIRECTORIES || scanned >= MAX_WORKSPACE_FILE_CANDIDATES) truncated = true;
  return { paths: paths.sort(), truncated };
}

async function workspaceFiles(root: string): Promise<WorkspaceFileCatalogue> {
  return (await gitWorkspaceFiles(root)) ?? walkedWorkspaceFiles(root);
}

interface EveryApiCliAuthStatus {
  configured: false;
  source: "everyapi-cli";
  status: "cli-auth-missing" | "relay-key-missing";
}

function probeEveryApiCliAuth(): Promise<EveryApiCliAuthStatus> {
  const executable = process.env.EVERYAPI_CLI_PATH?.trim() || "everyapi";
  return new Promise((resolveStatus) => {
    execFile(executable, ["auth", "status"], { timeout: 3_000, maxBuffer: 128 * 1024 }, (error) => {
      resolveStatus({
        configured: false,
        source: "everyapi-cli",
        status: error ? "cli-auth-missing" : "relay-key-missing",
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
    const pendingPromptRequests = new Map<string, string>();
    let busy = false;
    let sessionOperationBusy = false;
    const runSessionOperation = async (response: ServerResponse, streamingError: string, action: () => Promise<void>): Promise<void> => {
      if (busy || sessionIsBusy(services)) {
        sendJson(response, 409, { error: streamingError });
        return;
      }
      if (sessionOperationBusy) {
        sendJson(response, 409, { error: "Another session operation is already running" });
        return;
      }
      sessionOperationBusy = true;
      try {
        await action();
      } finally {
        sessionOperationBusy = false;
      }
    };
    let workspaceFileCache: { readonly cwd: string; readonly expiresAt: number; readonly catalogue: WorkspaceFileCatalogue } | undefined;
    let workspaceFileRequest: { readonly cwd: string; readonly promise: Promise<WorkspaceFileCatalogue> } | undefined;
    const readWorkspaceFiles = (cwd: string): Promise<WorkspaceFileCatalogue> => {
      if (workspaceFileCache?.cwd === cwd && workspaceFileCache.expiresAt > Date.now()) return Promise.resolve(workspaceFileCache.catalogue);
      if (workspaceFileRequest?.cwd === cwd) return workspaceFileRequest.promise;
      const promise = workspaceFiles(cwd)
        .then((catalogue) => {
          workspaceFileCache = { cwd, expiresAt: Date.now() + WORKSPACE_FILE_CACHE_MS, catalogue };
          return catalogue;
        })
        .finally(() => {
          if (workspaceFileRequest?.promise === promise) workspaceFileRequest = undefined;
        });
      workspaceFileRequest = { cwd, promise };
      return promise;
    };
    const events: StampedSessionEvent[] = [];
    const eventClients = new Set<ServerResponse>();
    const initialRunAt = Date.now();
    let runActivity: RunActivity | undefined = sessionIsBusy(services)
      ? {
          sessionId: services.runtime.session.sessionId,
          startedAt: initialRunAt,
          lastActivityAt: initialRunAt,
          phase: services.runtime.session.isCompacting ? "compacting" : "starting",
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
      if (event.type === "compaction_start") {
        runActivity = { sessionId, startedAt: event.receivedAt, lastActivityAt: event.receivedAt, phase: "compacting" };
        Object.assign(event, { runPhase: "compacting" });
      } else if (event.type === "compaction_end") {
        runActivity = services.runtime.session.isStreaming
          ? { sessionId, startedAt: event.receivedAt, lastActivityAt: event.receivedAt, phase: "starting" }
          : undefined;
        if (runActivity) Object.assign(event, { runPhase: runActivity.phase });
      } else if (event.type === "agent_settled") {
        toolCallStartedAt.clear();
        runActivity = undefined;
      } else if (event.type === "agent_start") {
        toolCallStartedAt.clear();
        runActivity = { sessionId, startedAt: event.receivedAt, lastActivityAt: event.receivedAt, phase: "starting" };
      } else if (runActivity?.sessionId === sessionId || services.runtime.session.isStreaming) {
        const startedAt = runActivity?.sessionId === sessionId ? runActivity.startedAt : event.receivedAt;
        let phase = runActivity?.sessionId === sessionId ? runActivity.phase : "starting";
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "thinking_delta") phase = "thinking";
          if (event.assistantMessageEvent.type === "text_delta") phase = "responding";
        }
        if (event.type === "tool_execution_start" || event.type === "tool_execution_update") phase = "tool";
        if (event.type === "tool_execution_end") {
          phase = toolCallStartedAt.size > 0 ? "tool" : "starting";
          // A client may connect after parallel tools started, so their completion events carry the authoritative remaining-work phase.
          Object.assign(event, { runPhase: phase });
        }
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
        const session = services.runtime.session;
        // Branch summaries share the compaction state but do not emit compaction_start, so polling also reconciles activity from the runtime.
        if (!sessionIsBusy(services)) runActivity = undefined;
        else if (runActivity?.sessionId !== session.sessionId || (session.isCompacting && runActivity.phase !== "compacting")) {
          const observedAt = Date.now();
          runActivity = {
            sessionId: session.sessionId,
            startedAt: observedAt,
            lastActivityAt: observedAt,
            phase: session.isCompacting ? "compacting" : "starting",
          };
        }
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
          // The settings form uses an empty value for "follow the runtime/provider". Passing undefined removes the persisted override; ignoring the empty value would leave a previous default stuck forever.
          if (typeof payload.defaultProvider === "string" && Object.hasOwn(payload, "defaultProvider"))
            (settings.setDefaultProvider as (provider: string | undefined) => void)(payload.defaultProvider.trim() || undefined);
          if (typeof payload.defaultModel === "string" && Object.hasOwn(payload, "defaultModel"))
            (settings.setDefaultModel as (modelId: string | undefined) => void)(payload.defaultModel.trim() || undefined);
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
        const provider = await providerFromBody(request, response);
        if (provider === undefined) return;
        try {
          const runtime = services.models.runtime as typeof services.models.runtime & { checkAuth?: (provider: string) => Promise<unknown> };
          if (typeof runtime.checkAuth !== "function") {
            sendJson(response, 501, { error: "The active model runtime does not support provider checks" });
            return;
          }
          const auth = await runtime.checkAuth(provider);
          if (provider === "everyapi" && auth === undefined && !process.env.EVERYAPI_RELAY_KEY?.trim()) {
            const cliAuth = await probeEveryApiCliAuth();
            sendJson(response, 200, { provider, reachable: false, auth: cliAuth });
            return;
          }
          sendJson(response, 200, jsonSafe({ provider, reachable: auth !== undefined, auth }));
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
        const provider = await providerFromBody(request, response);
        if (provider === undefined) return;
        try {
          const runtime = services.models.runtime as typeof services.models.runtime & {
            getAvailable?: (provider: string) => Promise<readonly unknown[]>;
          };
          if (typeof runtime.getAvailable !== "function") {
            sendJson(response, 501, { error: "The active model runtime does not support provider refresh" });
            return;
          }
          // getAvailable filters an unknown id out and answers with an empty list, which reads exactly like a registered provider that returned no models. /api/providers/add already asks getProvider whether the id is known; asking it here too keeps "we do not have that provider" separate from "that provider has nothing for you".
          if (runtime.getProvider(provider) === undefined) {
            sendJson(response, 404, { error: `Provider not found: ${provider}` });
            return;
          }
          const models = await runtime.getAvailable(provider);
          sendJson(response, 200, jsonSafe({ provider, models }));
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
          const loadedEntries = [...loader.entries()];
          const configuredEntries = await readMarketplaceProfileEntries(configPath);
          const loadedPackages = new Set(loadedEntries.map((entry) => entry.options.name));
          const configuredPackages = new Set(configuredEntries.map((entry) => entry.packageName));
          const installPlan = marketplaceInstallPlan(plugin);
          const missing = installPlan.filter((entry) => !loadedPackages.has(entry.packageName) && !configuredPackages.has(entry.packageName));
          const disabledDependencies = installPlan.slice(0, -1).filter((dependency) => {
            const loaded = loadedEntries.find((entry) => entry.options.name === dependency.packageName);
            const configured = configuredEntries.find((entry) => entry.packageName === dependency.packageName);
            return loaded?.options.disabled === true || configured?.disabled === true;
          });
          const pendingDependencies = installPlan
            .slice(0, -1)
            .filter((dependency) => configuredPackages.has(dependency.packageName) && !loadedPackages.has(dependency.packageName));
          if (missing.length === 0 && disabledDependencies.length === 0 && pendingDependencies.length === 0 && loadedPackages.has(plugin.packageName)) {
            sendJson(response, 409, { error: "Plugin is already installed", plugin });
            return;
          }
          // A complete plugin plan already waiting for a restart is installed even though the loader has no entry for it, so installing it again would re-run npm and report a fresh restart for work that is already done.
          if (missing.length === 0 && disabledDependencies.length === 0) {
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
          const entryIds: string[] = [];
          try {
            const specifiers = missing.map((entry) => `${marketplaceNpmPackageName(entry.packageName)}@${entry.version}`);
            if (specifiers.length > 0) await runProcess("npm", ["install", "--save-exact", "--package-lock=false", ...specifiers], installDirectory);
            profileBefore = await readFile(configPath, "utf8");
            for (const dependency of disabledDependencies) {
              const configured = configuredEntries.find((entry) => entry.packageName === dependency.packageName);
              if (configured === undefined) throw new Error(`Installed dependency profile entry was not found: ${dependency.id}`);
              await updateMarketplaceProfile(configPath, configured.id, { disabled: false });
            }
            const missingPackages = new Set(missing.map((entry) => entry.packageName));
            let profileAnchor = placement?.beforeEntryId;
            for (let index = installPlan.length - 1; index >= 0; index -= 1) {
              const entry = installPlan[index];
              if (entry === undefined) continue;
              const configured = configuredEntries.find((candidate) => candidate.packageName === entry.packageName);
              if (configured !== undefined) {
                profileAnchor = configured.id;
              } else if (missingPackages.has(entry.packageName)) {
                await appendMarketplaceProfile(configPath, entry, profileAnchor);
                profileAnchor = `marketplace-${entry.id}`;
              }
            }
            // Re-enabled and profile-only dependencies are not available to the running tool snapshot. The whole dependency-first profile is complete, so defer every activation to the next start instead of exposing a partially usable target.
            if (disabledDependencies.length > 0 || pendingDependencies.length > 0) {
              sendJson(response, 200, { plugin, installed: true, restartRequired: true });
              return;
            }
            for (const [index, pluginEntry] of missing.entries()) {
              const entryId = await loader.create(
                {
                  id: `marketplace-${pluginEntry.id}`,
                  name: pluginEntry.packageName,
                  ...(pluginEntry.profile.group === true ? { group: true } : {}),
                  config: pluginEntry.profile.config,
                } as never,
                placement?.groupEntryId ?? null,
                placement === undefined ? Infinity : placement.position + index,
              );
              entryIds.push(entryId);
              const entry = loader.resolve(entryId);
              if (entry.fiber === undefined) throw new Error(`Plugin ${pluginEntry.packageName} did not create a runtime fiber`);
              await entry.fiber.await();
            }
            sendJson(response, 200, { plugin, installed: true, restartRequired: false });
          } catch (error) {
            for (const entryId of entryIds.reverse()) await loader.remove(entryId).catch(() => {});
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
          const loaderEntries = [...loader.entries()];
          const profileEntries = await readMarketplaceProfileEntries(configPath);
          const enabledPackages = marketplaceEnabledPackages(loaderEntries, profileEntries);
          if (payload.enabled) {
            const activePackages = marketplaceActivePackages(loaderEntries, profileEntries);
            const missing = marketplaceInstallPlan(plugin)
              .slice(0, -1)
              .filter((dependency) => !activePackages.has(dependency.packageName));
            if (missing.length > 0) {
              sendJson(response, 409, {
                error: `Plugin requires installed and enabled dependencies: ${missing.map((dependency) => dependency.name).join(", ")}`,
              });
              return;
            }
          } else {
            const blockers = marketplaceDependencyBlockers(plugin, enabledPackages);
            if (blockers.length > 0) {
              sendJson(response, 409, { error: `Plugin is required by installed plugins: ${blockers.map((candidate) => candidate.name).join(", ")}` });
              return;
            }
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
          const loaderEntries = [...loader.entries()];
          const profileEntries = await readMarketplaceProfileEntries(configPath);
          const enabledPackages = marketplaceEnabledPackages(loaderEntries, profileEntries);
          const entry = loaderEntries.find((item) => item.id === payload.id || item.options.id === payload.id);
          if (entry === undefined) {
            // A plugin waiting for a restart has no loader entry to remove, only the profile entry and the package the install left behind. Refusing here left the user unable to undo an install until they restarted the very process they installed it to avoid restarting.
            const pending = profileEntries.find((item) => item.id === payload.id);
            const pendingPlugin = pending === undefined ? undefined : MARKETPLACE_PLUGINS.find((item) => item.packageName === pending.packageName);
            if (pending === undefined || pendingPlugin === undefined) {
              sendJson(response, 404, { error: "Installed plugin was not found" });
              return;
            }
            const blockers = marketplaceDependencyBlockers(pendingPlugin, enabledPackages);
            if (blockers.length > 0) {
              sendJson(response, 409, { error: `Plugin is required by installed plugins: ${blockers.map((candidate) => candidate.name).join(", ")}` });
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
          const blockers = marketplaceDependencyBlockers(plugin, enabledPackages);
          if (blockers.length > 0) {
            sendJson(response, 409, { error: `Plugin is required by installed plugins: ${blockers.map((candidate) => candidate.name).join(", ")}` });
            return;
          }
          const profileEntryId = entry.options.id;
          const profileBefore = await readFile(configPath, "utf8");
          const installDirectory = await marketplaceInstallDirectory(configPath, services.launch.cwd);
          const packageJsonPath = join(installDirectory, "package.json");
          const packageLockPath = join(installDirectory, "package-lock.json");
          const packageJsonBefore = await readFile(packageJsonPath, "utf8").catch(() => undefined);
          const packageLockBefore = await readFile(packageLockPath, "utf8").catch(() => undefined);
          // Capture the loader location before removal. If npm cleanup fails, the profile and runtime entry must be restored to the same group and slot rather than silently drifting to the root.
          const restoreParent = [...loader.entries()].find((candidate) => candidate.subgroup === entry.parent)?.id ?? null;
          const restoreIndex = Array.isArray(entry.parent.data) ? entry.parent.data.indexOf(entry.options) : -1;
          const restorePosition = restoreIndex < 0 ? Infinity : restoreIndex;
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
              .create(
                { id: entry.options.id, name: options.name, config: options.config, ...(options.group ? { group: true } : {}) } as never,
                restoreParent,
                restorePosition,
              )
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
        if (sessionIsBusy(services)) {
          sendJson(response, 409, { error: "Cannot change model while a session operation is running" });
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
          if (typeof services.runtime.setModel !== "function") {
            sendJson(response, 501, { error: "The active Pi session does not support model switching" });
            return;
          }
          await services.runtime.setModel(model);
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
        if (!status.repository) {
          sendJson(response, 200, { items: await sessionFileMutations(services.runtime.session, resolve(activeCwd(services))), repository: false });
          return;
        }
        const items = status.entries.map((entry) => ({
          path: entry.path,
          status: entry.status,
          label: entry.status === "??" ? "untracked" : entry.status.includes("D") ? "deleted" : entry.status.includes("A") ? "added" : "modified",
        }));
        sendJson(response, 200, { items, repository: true, ...(status.truncated ? { truncated: true } : {}) });
      },
    });
    const disposeWorkspaceFiles = services.webServer.register({
      path: "/api/workspace/files",
      async handler(_request, response) {
        try {
          const catalogue = await readWorkspaceFiles(activeCwd(services));
          sendJson(response, 200, {
            items: catalogue.paths.map((path) => ({ path, status: "", label: "workspace" })),
            truncated: catalogue.truncated,
          });
        } catch (error) {
          sendJson(response, 500, { error: errorText(error) });
        }
      },
    });
    const disposeWorkspaceFile = services.webServer.register({
      path: "/api/workspace/file",
      async handler(request, response) {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const url = new URL(request.url ?? "/api/workspace/file", "http://localhost");
        const requested = url.searchParams.get("path");
        if (requested === null || requested.trim() === "") {
          sendJson(response, 400, { error: "path is required" });
          return;
        }
        const root = resolve(activeCwd(services));
        const target = await containedWorkspacePath(root, requested);
        if (target === undefined) {
          sendJson(response, 400, { error: "path must stay inside the workspace" });
          return;
        }
        const relativePath = target.relativePath.split(sep).join("/");
        const catalogue = await readWorkspaceFiles(root);
        if (!catalogue.paths.includes(relativePath)) {
          sendJson(response, 404, { error: "file is not in the workspace catalogue" });
          return;
        }
        try {
          const canonicalRoot = await realpath(root);
          const beforeOpen = await lstat(target.absolute);
          if (beforeOpen.isSymbolicLink()) {
            sendJson(response, 400, { error: "symbolic links cannot be previewed" });
            return;
          }
          if (!beforeOpen.isFile()) {
            sendJson(response, 400, { error: "path must name a regular file" });
            return;
          }
          const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const metadata = await handle.stat();
            if (!metadata.isFile()) {
              sendJson(response, 400, { error: "path must name a regular file" });
              return;
            }
            if (metadata.dev !== beforeOpen.dev || metadata.ino !== beforeOpen.ino) {
              sendJson(response, 409, { error: "file changed while it was being opened" });
              return;
            }
            const afterOpen = await lstat(target.absolute);
            if (afterOpen.isSymbolicLink()) {
              sendJson(response, 400, { error: "symbolic links cannot be previewed" });
              return;
            }
            const canonicalTarget = await realpath(target.absolute);
            if (escapesRoot(relative(canonicalRoot, canonicalTarget))) {
              sendJson(response, 400, { error: "path must stay inside the workspace" });
              return;
            }
            const current = await stat(canonicalTarget);
            if (metadata.dev !== current.dev || metadata.ino !== current.ino) {
              sendJson(response, 409, { error: "file changed while it was being opened" });
              return;
            }
            if (metadata.size > MAX_WORKSPACE_FILE_PREVIEW_BYTES) {
              sendJson(response, 413, { error: "files larger than 512 KiB cannot be previewed" });
              return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            while (total <= MAX_WORKSPACE_FILE_PREVIEW_BYTES) {
              const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_WORKSPACE_FILE_PREVIEW_BYTES + 1 - total));
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
              if (bytesRead === 0) break;
              chunks.push(buffer.subarray(0, bytesRead));
              total += bytesRead;
            }
            if (total > MAX_WORKSPACE_FILE_PREVIEW_BYTES) {
              sendJson(response, 413, { error: "files larger than 512 KiB cannot be previewed" });
              return;
            }
            const content = Buffer.concat(chunks, total);
            if (content.includes(0)) {
              sendJson(response, 415, { error: "binary files cannot be previewed" });
              return;
            }
            try {
              sendJson(response, 200, { path: relativePath, content: new TextDecoder("utf-8", { fatal: true }).decode(content) });
            } catch {
              sendJson(response, 415, { error: "binary files cannot be previewed" });
            }
          } finally {
            await handle.close();
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ELOOP") sendJson(response, 400, { error: "symbolic links cannot be previewed" });
          else sendJson(response, code === "ENOENT" ? 404 : 500, { error: code === "ENOENT" ? "file does not exist" : errorText(error) });
        }
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
        const target = await containedWorkspacePath(root, requested);
        if (target === undefined) {
          sendJson(response, 400, { error: "path must stay inside the workspace" });
          return;
        }
        sendJson(response, 200, { path: target.relativePath, diff: await gitDiff(root, target.relativePath) });
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
        let accepted = false;
        let receiptPersistenceError: string | undefined;
        let requestKey: string | undefined;
        let unsubscribe: (() => void) | undefined;
        try {
          const payload = JSON.parse(await bodyText(request)) as { prompt?: unknown; streamingBehavior?: unknown; requestId?: unknown; sessionId?: unknown };
          if (typeof payload.prompt !== "string" || payload.prompt.trim().length === 0) {
            sendJson(response, 400, { error: "Prompt must be a non-empty string" });
            return;
          }
          if (payload.streamingBehavior !== undefined && payload.streamingBehavior !== "steer" && payload.streamingBehavior !== "followUp") {
            sendJson(response, 400, { error: 'streamingBehavior must be "steer" or "followUp"' });
            return;
          }
          const session = services.runtime.session;
          const requestId = payload.requestId;
          if (
            requestId !== undefined &&
            (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) || typeof payload.sessionId !== "string")
          ) {
            sendJson(response, 400, { error: "requestId and sessionId must identify a prompt submission" });
            return;
          }
          if (requestId !== undefined && payload.sessionId !== session.sessionId) {
            sendJson(response, 409, { error: "The active session changed before this prompt was submitted" });
            return;
          }
          const digest = createHash("sha256")
            .update(JSON.stringify([payload.prompt, payload.streamingBehavior ?? null]))
            .digest("hex");
          const candidateKey = requestId === undefined ? undefined : JSON.stringify([session.sessionId, requestId]);
          if (requestId !== undefined) {
            const receipt = session.sessionManager
              .getEntries()
              .find(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === "pi-harness.prompt-receipt" &&
                  (entry.data as { requestId?: unknown; sessionId?: unknown } | undefined)?.requestId === requestId &&
                  (entry.data as { sessionId?: unknown }).sessionId === session.sessionId,
              );
            const previousDigest = receipt?.type === "custom" ? (receipt.data as { digest?: unknown }).digest : pendingPromptRequests.get(candidateKey!);
            if (previousDigest !== undefined) {
              if (previousDigest !== digest) sendJson(response, 409, { error: "This requestId already identifies a different prompt" });
              else if (receipt?.type === "custom" && typeof (receipt.data as { persistenceError?: unknown }).persistenceError === "string")
                sendJson(response, 500, { error: (receipt.data as { persistenceError: string }).persistenceError, accepted: true });
              else if (receipt) sendJson(response, 200, { reply: "", messages: session.messages.length, received: true });
              else sendJson(response, 409, { error: "This submission is still being checked; wait for its result before retrying" });
              return;
            }
          }
          if (session.isCompacting) {
            sendJson(response, 409, { error: "Cannot submit a prompt while context compaction is running" });
            return;
          }
          if (sessionOperationBusy) {
            sendJson(response, 409, { error: "Another session operation is already running" });
            return;
          }
          const preflightResult = (value: boolean) => {
            if (!value || accepted) return;
            accepted = true;
            if (requestId !== undefined) {
              const receipt: { requestId: string; sessionId: string; digest: string; persistenceError?: string } = {
                requestId,
                sessionId: session.sessionId,
                digest,
              };
              try {
                session.sessionManager.appendCustomEntry("pi-harness.prompt-receipt", receipt);
                persistSessionBeforeFirstAssistant(session.sessionManager);
              } catch (error) {
                // Receipt I/O must not throw from Pi's acceptance callback: ordinary prompts have not started yet, while extension commands and queued prompts may already have taken effect.
                receiptPersistenceError = `Prompt accepted; receipt persistence failed. Check the result before retrying after a restart: ${errorText(error)}`;
                receipt.persistenceError = receiptPersistenceError;
                context.logger.warn(receiptPersistenceError);
              }
            }
          };
          const claimRequest = () => {
            if (candidateKey !== undefined) {
              requestKey = candidateKey;
              pendingPromptRequests.set(candidateKey, digest);
            }
          };
          const streamingBehavior = payload.streamingBehavior;
          if (services.runtime.session.isStreaming) {
            if (!streamingBehavior) {
              sendJson(response, 409, { error: "Another prompt is already running; choose steer or followUp delivery" });
              return;
            }
            claimRequest();
            await services.runtime.prompt(payload.prompt, { streamingBehavior, preflightResult });
            if (receiptPersistenceError) {
              sendJson(response, 500, { error: receiptPersistenceError, accepted: true });
              return;
            }
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
          claimRequest();
          await services.runtime.prompt(payload.prompt, { preflightResult });
          const last = services.runtime.session.messages.at(-1);
          if (last?.role === "assistant" && last.stopReason === "error") {
            sendJson(response, 502, { error: [last.errorMessage ?? "Request error", receiptPersistenceError].filter(Boolean).join("\n"), accepted });
            return;
          }
          if (receiptPersistenceError) {
            sendJson(response, 500, { error: receiptPersistenceError, accepted: true });
            return;
          }
          sendJson(response, 200, {
            reply: chunks.join(""),
            messages: services.runtime.session.messages.length,
            ...(last?.role === "assistant" && last.stopReason === "aborted" ? { aborted: true } : {}),
          });
        } catch (error) {
          sendJson(response, 400, { error: [errorText(error), receiptPersistenceError].filter(Boolean).join("\n"), accepted });
        } finally {
          unsubscribe?.();
          if (requestKey !== undefined) pendingPromptRequests.delete(requestKey);
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
          const wasBusy = sessionIsBusy(services);
          if (wasBusy) context.emit("pi/session-abort-requested", services.runtime.session);
          await services.runtime.abort();
          sendJson(response, 200, { aborted: wasBusy });
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
        try {
          const raw = await bodyText(request);
          const payload = raw.trim() ? (JSON.parse(raw) as { cwd?: unknown }) : {};
          await runSessionOperation(response, "Cannot create a session while a prompt is running", async () => {
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
          });
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
        try {
          const payload = JSON.parse(await bodyText(request)) as { path?: unknown; sessionId?: unknown };
          const manager = services.runtime.session.sessionManager;
          if (!manager.isPersisted()) {
            sendJson(response, 409, { error: "Session switching requires JSONL session storage" });
            return;
          }
          await runSessionOperation(response, "Cannot switch sessions while a prompt is running", async () => {
            const items = (await SessionManager.list(activeCwd(services), manager.getSessionDir())).filter((item) =>
              sessionPathInDirectory(item.path, manager),
            );
            const target = items.find(
              (item) =>
                (typeof payload.path === "string" && item.path === payload.path) || (typeof payload.sessionId === "string" && item.id === payload.sessionId),
            );
            if (target === undefined) {
              sendJson(response, 404, { error: "Session not found" });
              return;
            }
            const targetVersion = await sessionFileVersion(target.path);
            if (targetVersion !== undefined && !supportedSessionVersion(targetVersion)) {
              sendJson(response, 409, { error: "Cannot open a session with an unsupported session version" });
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
          });
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
          // The active session's file is deferred until its first entry, and renaming it before then is a real action the deferred-persistence branch below carries out. Any other path that does not exist names a session that was deleted or moved, and opening it appends nothing — so reporting 200 would hand the caller a success it cannot tell from a rename that happened.
          if (sessionMissing(path, services.runtime.session.sessionFile)) {
            sendJson(response, 404, { error: "Session not found" });
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
          const requestedPath = typeof payload.path === "string" ? payload.path : "";
          if (payload.confirm !== true) {
            sendJson(response, 400, { error: "confirm must be true to delete a session" });
            return;
          }
          const path = canonicalSessionPath(requestedPath, manager);
          if (!path) {
            sendJson(response, 400, { error: "Invalid session path" });
            return;
          }
          await runSessionOperation(response, "Cannot delete the active session while a prompt is running", async () => {
            const rootIdentity = sessionRootIdentity(manager);
            if (!rootIdentity) {
              sendJson(response, 400, { error: "Invalid session directory" });
              return;
            }
            const activeSessionPath = services.runtime.session.sessionFile;
            const canonicalActiveSessionPath = activeSessionPath ? canonicalSessionPath(activeSessionPath, manager) : undefined;
            if (path === canonicalActiveSessionPath) {
              const result = await runWebSessionChange(services, () => services.runtime.sessionRuntime.newSession());
              if (result.cancelled) {
                sendJson(response, 409, { error: "Session deletion was cancelled by an extension" });
                return;
              }
              events.length = 0;
            }
            if (!sessionRootMatches(manager, rootIdentity) || canonicalSessionPath(path, manager) !== path) {
              sendJson(response, 409, { error: "Session path changed before deletion" });
              return;
            }
            // A newly created active session may not have a JSONL file yet: Pi defers persistence until the first entry. Treat that missing file as already deleted, while preserving failures for unexpected paths such as directories.
            await unlink(path).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            });
            if (!sessionRootMatches(manager, rootIdentity)) {
              sendJson(response, 409, { error: "Session directory changed before metadata cleanup" });
              return;
            }
            await mutateSessionMetadata(manager, context.logger, (metadata) => {
              delete metadata[path];
            });
            sendJson(response, 200, { deleted: true, path, sessionFile: services.runtime.session.sessionFile });
          });
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
          // The key has to be the canonical path, which is what /api/sessions reads back and what delete and batch
          // write. Keying on the request string instead gives a session two identities as soon as the caller names
          // it any other way — a relative path, a symlinked directory, a differently cased spelling — and the entry
          // written under the second one is read by nothing and removed by nothing.
          const path = canonicalSessionPath(typeof payload.path === "string" ? payload.path : "", manager) ?? "";
          if (path === "") {
            sendJson(response, 400, { error: "Invalid session path" });
            return;
          }
          // Metadata is keyed by path and persisted, so an entry for a session that is not there outlives every
          // session in the file and nothing ever removes it: the list is built from the files on disk.
          if (sessionMissing(path, services.runtime.session.sessionFile)) {
            sendJson(response, 404, { error: "Session not found" });
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
          const requestedPaths = Array.isArray(payload.paths) ? payload.paths.filter((path): path is string => typeof path === "string") : [];
          const manager = services.runtime.session.sessionManager;
          if (
            (action !== "delete" && action !== "archive" && action !== "unarchive" && action !== "pin" && action !== "unpin") ||
            requestedPaths.length === 0 ||
            requestedPaths.length > 100
          ) {
            sendJson(response, 400, { error: "action and 1-100 session paths are required" });
            return;
          }
          if (action === "delete" && payload.confirm !== true) {
            sendJson(response, 400, { error: "confirm must be true to delete sessions" });
            return;
          }
          const canonicalPaths = requestedPaths.map((path) => canonicalSessionPath(path, manager));
          if (canonicalPaths.some((path) => path === undefined)) {
            sendJson(response, 400, { error: "Invalid session path" });
            return;
          }
          const paths = [...new Set(canonicalPaths as string[])];
          const missing = paths.filter((path) => sessionMissing(path, services.runtime.session.sessionFile));
          if (action !== "delete" && missing.length > 0) {
            sendJson(response, 404, { error: `Session not found: ${missing.join(", ")}` });
            return;
          }
          if (action === "delete") {
            await runSessionOperation(response, "Cannot delete the active session while a prompt is running", async () => {
              const rootIdentity = sessionRootIdentity(manager);
              if (!rootIdentity) {
                sendJson(response, 400, { error: "Invalid session directory" });
                return;
              }
              const activeSessionPath = services.runtime.session.sessionFile;
              const canonicalActiveSessionPath = activeSessionPath ? canonicalSessionPath(activeSessionPath, manager) : undefined;
              if (canonicalActiveSessionPath && paths.includes(canonicalActiveSessionPath)) {
                const result = await runWebSessionChange(services, () => services.runtime.sessionRuntime.newSession());
                if (result.cancelled) {
                  sendJson(response, 409, { error: "Session deletion was cancelled by an extension" });
                  return;
                }
                events.length = 0;
              }
              // The unlinks run outside the metadata mutation: a failure halfway through must not discard the key removals for the files that are already gone from disk.
              const removed: string[] = [];
              const failed: { path: string; error: string }[] = [];
              for (const path of paths) {
                try {
                  if (!sessionRootMatches(manager, rootIdentity) || canonicalSessionPath(path, manager) !== path)
                    throw new Error("Session path changed before deletion");
                  await unlink(path);
                  removed.push(path);
                } catch (error) {
                  // A session another tab already deleted leaves nothing to unlink, but its metadata entry still has to go.
                  if ((error as NodeJS.ErrnoException).code === "ENOENT") removed.push(path);
                  else failed.push({ path, error: errorText(error) });
                }
              }
              const rootUnchanged = sessionRootMatches(manager, rootIdentity);
              if (removed.length > 0 && rootUnchanged) {
                await mutateSessionMetadata(manager, context.logger, (metadata) => {
                  for (const path of removed) delete metadata[path];
                });
              } else if (!rootUnchanged && failed.length === 0) {
                failed.push({ path: rootIdentity.path, error: "Session directory changed before metadata cleanup" });
              }
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
            });
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
          const requestedSourcePath = typeof payload.path === "string" ? payload.path : "";
          const sourcePath = canonicalSessionPath(requestedSourcePath, manager);
          if (!sourcePath) {
            sendJson(response, 400, { error: "Invalid session path" });
            return;
          }
          await runSessionOperation(response, "Cannot fork a session while a prompt is running", async () => {
            const activeSessionPath = services.runtime.session.sessionFile;
            const canonicalActiveSessionPath = activeSessionPath ? canonicalSessionPath(activeSessionPath, manager) : undefined;
            // Pi defers creating a JSONL file for a new empty session until its first assistant response. A duplicate is still a durable action, so materialize the active session before listing it; missing non-active paths remain a 404.
            if (sourcePath === canonicalActiveSessionPath && !existsSync(sourcePath)) {
              try {
                persistSessionBeforeFirstAssistant(manager);
              } catch (error) {
                // Another tab may win the first-persistence race between existsSync and writeFileSync; its file is the same fork source, so continue with the list.
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              }
            }
            const sessions = await SessionManager.list(activeCwd(services), manager.getSessionDir());
            const source = sessions.find((item) => canonicalSessionPath(item.path, manager) === sourcePath);
            if (!source) {
              sendJson(response, 404, { error: "Session not found" });
              return;
            }
            const targetCwd = typeof payload.cwd === "string" && payload.cwd.trim() ? resolve(payload.cwd) : source.cwd || activeCwd(services);
            const stagingDirectory = await mkdtemp(join(tmpdir(), "pi-harness-session-fork-"));
            let sessionId: string;
            let sessionFile: string;
            let content: Buffer;
            try {
              const forked = SessionManager.forkFrom(source.path, targetCwd, stagingDirectory);
              const stagedPath = forked.getSessionFile();
              if (!stagedPath) throw new Error("Unable to persist forked session");
              sessionId = forked.getSessionId();
              sessionFile = join(manager.getSessionDir(), basename(stagedPath));
              content = migratedForkContent(await readFile(stagedPath), await readFile(source.path));
            } finally {
              await rm(stagingDirectory, { recursive: true, force: true });
            }
            await atomicWriteFile(sessionFile, content, { overwrite: false, mode: 0o600 });
            sendJson(response, 200, { sessionId, sessionFile, cwd: targetCwd });
          });
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
          await runSessionOperation(response, "Cannot import a session while a prompt is running", async () => {
            const importContent = content ?? (await readFile(suppliedPath, "utf8"));
            if (content !== undefined && Buffer.byteLength(importContent, "utf8") > IMPORT_CONTENT_LIMIT_BYTES) {
              sendJson(response, 413, { error: "Imported session must be at most 10 MiB" });
              return;
            }
            validateImportedSession(importContent);
            if (!(await stat(targetCwd)).isDirectory()) throw new Error("Session import requires an existing working directory");
            // Fork a validated snapshot: the upstream reader repairs missing final newlines and must not modify the user's source file.
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-harness-import-"));
            const requestedName = basename(typeof payload.filename === "string" && payload.filename.trim() ? payload.filename : "import.jsonl");
            const importName = requestedName === "" || requestedName === "." || requestedName === ".." ? "import.jsonl" : requestedName;
            const importPath = join(temporaryDirectory, importName);
            let importedPath: string | undefined;
            let importedId: string | undefined;
            let published = false;
            let adopted = false;
            let cancelled: boolean;
            let receipt: { sessionId: string; sessionFile: string | undefined; messages: number } | undefined;
            try {
              await writeFile(importPath, importContent, { encoding: "utf8", mode: 0o600 });
              const preview = SessionManager.open(importPath, temporaryDirectory, targetCwd);
              preview.buildSessionContext();
              const imported = SessionManager.forkFrom(importPath, targetCwd, temporaryDirectory);
              const stagedPath = imported.getSessionFile();
              importedId = imported.getSessionId();
              if (!stagedPath) throw new Error("Unable to persist imported session");
              importedPath = join(manager.getSessionDir(), basename(stagedPath));
              await mkdir(manager.getSessionDir(), { recursive: true });
              await atomicWriteFile(importedPath, await readFile(stagedPath), { overwrite: false, mode: 0o600 });
              published = true;
              const result = await runWebSessionChange(services, () =>
                services.runtime.sessionRuntime.switchSession(importedPath!, { cwdOverride: targetCwd }),
              );
              cancelled = result.cancelled;
              if (!cancelled) {
                adopted = true;
                events.length = 0;
                receipt = {
                  sessionId: services.runtime.session.sessionId,
                  sessionFile: services.runtime.session.sessionFile,
                  messages: services.runtime.session.messages.length,
                };
              }
            } finally {
              try {
                if (
                  published &&
                  !adopted &&
                  importedPath &&
                  services.runtime.session.sessionFile !== importedPath &&
                  services.runtime.session.sessionId !== importedId
                ) {
                  await rm(importedPath, { force: true });
                }
              } finally {
                await rm(temporaryDirectory, { recursive: true, force: true });
              }
            }
            if (cancelled) sendJson(response, 409, { error: "Session import was cancelled by an extension" });
            else sendJson(response, 200, receipt);
          });
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
          // Pi defers creating the JSONL file for a new empty session until its first entry. Exporting that active session is still a durable user action, so materialize its in-memory header and entries before reading it; missing non-active paths remain a 404.
          if (path === services.runtime.session.sessionFile && !existsSync(path)) {
            try {
              persistSessionBeforeFirstAssistant(manager);
            } catch (error) {
              // Another tab may win the first-persistence race between existsSync and writeFileSync; its file is the same export target, so continue with the read.
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            }
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
          const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
          const metadata = await readSessionMetadataLocked(manager, context.logger);
          const items =
            typeof manager.isPersisted === "function" && manager.isPersisted()
              ? (await SessionManager.list(activeCwd(services), manager.getSessionDir())).filter((item) => sessionPathInDirectory(item.path, manager))
              : [];
          const filtered = items.filter((item) => {
            if (!includeArchived && metadata[item.path]?.archived === true) return false;
            if (!query) return true;
            return `${item.name ?? ""} ${item.firstMessage ?? ""} ${item.id}`.toLowerCase().includes(query);
          });
          const sorted = filtered.sort(
            (a, b) => Number(metadata[b.path]?.pinned === true) - Number(metadata[a.path]?.pinned === true) || sessionRecency(b) - sessionRecency(a),
          );
          const paged = sorted.slice(page * pageSize, (page + 1) * pageSize);
          // Only the page that is about to be sent is probed: reading a header per listed file is bounded work, reading one per session in the directory is not.
          const versions = await Promise.all(paged.map((item) => sessionFileVersion(item.path)));
          sendJson(
            response,
            200,
            jsonSafe({
              items: paged.map((item, index) => ({
                sessionId: item.id,
                path: item.path,
                name: item.name,
                cwd: item.cwd,
                created: item.created,
                modified: item.modified,
                recency: new Date(sessionRecency(item)),
                messageCount: item.messageCount,
                firstMessage: item.firstMessage,
                forked: typeof item.parentSessionPath === "string" && item.parentSessionPath !== "",
                archived: metadata[item.path]?.archived === true,
                pinned: metadata[item.path]?.pinned === true,
                ...(versions[index] !== undefined && !supportedSessionVersion(versions[index]) ? { unsupportedVersion: true } : {}),
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
      disposeWorkspaceFiles();
      disposeWorkspaceFile();
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
