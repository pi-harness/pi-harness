import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, opendir } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isPathInside, prepareWorkspaceFile, resolveExistingWorkspacePath, resolveWorkspaceFilePath } from "../workspace-path.js";
import { atomicWriteFile } from "../atomic-write.js";
import { readBoundedFile, readBoundedTextFile } from "../bounded-file.js";

const defaultStoreName = "undo-savepoints";
const defaultTrackedPaths = ["."];
const maxSnapshotBytes = 2 * 1024 * 1024;
const maxManifestBytes = 16 * 1024 * 1024;
const maxManifestFiles = 2_000;
const maxManifestCount = 100;
const maxReasonLength = 4_096;
const maxTraversalDepth = 32;
const maxTotalSnapshotBytes = 8 * 1024 * 1024;
const maxManifestCandidates = 1_000;
const maxTraversalDirectories = 512;
const maxPathLength = 4_096;
const maxBase64Length = Math.ceil(maxSnapshotBytes / 3) * 4;
const sensitiveNames = new Set([".env", ".env.local", ".env.production", ".credentials", ".credentials.yaml", ".credentials.json"]);
const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"]);

export interface UndoSavepointPluginConfig {
  storeName?: string;
  trackedPaths?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

export const Config: z<UndoSavepointPluginConfig> = z.object({
  storeName: z.string().default(defaultStoreName),
  trackedPaths: z.array(z.string()).default(defaultTrackedPaths),
  maxFiles: z.number().default(400),
  maxFileBytes: z.number().default(256 * 1024),
});

interface SavepointFile {
  path: string;
  bytes: number;
  sha256: string;
  content: string;
}

interface SavepointManifest {
  version: 1;
  id: string;
  reason: string;
  createdAt: string;
  files: SavepointFile[];
}

interface SavepointSummary {
  id: string;
  reason: string;
  createdAt: string;
  fileCount: number;
}

interface SavepointDiff {
  id: string;
  changed: string[];
  missing: string[];
  unchanged: number;
}

function safeStoreName(value: string | undefined): string {
  const name = (value ?? defaultStoreName).trim();
  if (name === "" || basename(name) !== name || name.includes(sep) || name === "." || name === "..")
    throw new Error("storeName must be a single directory name");
  return name;
}

function withinRoot(root: string, candidate: string): boolean {
  return isPathInside(root, candidate);
}

async function normalizedTrackedPaths(cwd: string, paths: readonly string[]): Promise<string[]> {
  const values = paths.length === 0 ? defaultTrackedPaths : paths;
  const resolved = await Promise.all(values.map((item) => resolveExistingWorkspacePath(cwd, item, "Tracked paths must stay inside the current workspace")));
  return [...new Set(resolved.map((item) => item.target))];
}

function relativePath(cwd: string, path: string): string {
  return relative(cwd, path).split(sep).join("/");
}

function isSensitivePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return sensitiveNames.has(name) || name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12");
}

function isIgnoredPath(path: string): boolean {
  return path.split(sep).some((part) => ignoredDirectories.has(part));
}

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function collectFiles(root: string, trackedPaths: readonly string[], maxFiles: number, maxFileBytes: number): Promise<SavepointFile[]> {
  const files: SavepointFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let directories = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (files.length >= maxFiles || totalBytes >= maxTotalSnapshotBytes || isIgnoredPath(path) || isSensitivePath(path)) return;
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) return;
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      directories += 1;
      if (directories > maxTraversalDirectories || depth >= maxTraversalDepth) return;
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (entry.isSymbolicLink()) continue;
        await visit(join(path, entry.name), depth + 1);
        if (files.length >= maxFiles || totalBytes >= maxTotalSnapshotBytes) return;
      }
      return;
    }
    if (!info.isFile() || info.size > maxFileBytes || info.size > maxTotalSnapshotBytes - totalBytes) return;
    const content = await readBoundedFile(path, Math.min(maxFileBytes, maxTotalSnapshotBytes - totalBytes), "Savepoint file").catch(() => undefined);
    if (content === undefined || content.byteLength > maxTotalSnapshotBytes - totalBytes) return;
    if (content.includes(0)) return;
    const relativeName = relativePath(root, path);
    if (relativeName === "" || seen.has(relativeName)) return;
    seen.add(relativeName);
    totalBytes += content.byteLength;
    files.push({ path: relativeName, bytes: content.byteLength, sha256: hash(content), content: content.toString("base64") });
  };
  for (const path of trackedPaths) {
    await visit(path, 0);
    if (files.length >= maxFiles) break;
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function isValidRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= maxPathLength &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function isCanonicalBase64(value: string): boolean {
  if (value.length > maxBase64Length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function isSavepointFile(value: unknown, seenPaths: Set<string>, totalBytes: { value: number }): value is SavepointFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some((key) => !new Set(["path", "bytes", "sha256", "content"]).has(key))) return false;
  if (
    typeof file.path !== "string" ||
    !isValidRelativePath(file.path) ||
    isSensitivePath(file.path) ||
    seenPaths.has(file.path) ||
    typeof file.bytes !== "number" ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    file.bytes > maxSnapshotBytes ||
    typeof file.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(file.sha256) ||
    typeof file.content !== "string" ||
    !isCanonicalBase64(file.content)
  )
    return false;
  const content = Buffer.from(file.content, "base64");
  if (content.byteLength !== file.bytes || hash(content) !== file.sha256 || totalBytes.value > maxTotalSnapshotBytes - content.byteLength) return false;
  seenPaths.add(file.path);
  totalBytes.value += content.byteLength;
  return true;
}

async function readManifest(path: string, maxFiles: number): Promise<SavepointManifest> {
  const source = await readBoundedTextFile(path, maxManifestBytes, "Savepoint manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid savepoint: ${basename(path)}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid savepoint: ${basename(path)}`);
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !new Set(["version", "id", "reason", "createdAt", "files"]).has(key)) ||
    record.version !== 1 ||
    typeof record.id !== "string" ||
    !/^\d{17}-[0-9a-f]{8}$/u.test(record.id) ||
    record.id !== basename(path, extname(path)) ||
    typeof record.reason !== "string" ||
    record.reason.length > maxReasonLength ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Array.isArray(record.files) ||
    record.files.length > Math.min(maxFiles, maxManifestFiles)
  )
    throw new Error(`Invalid savepoint: ${basename(path)}`);
  const seenPaths = new Set<string>();
  const totalBytes = { value: 0 };
  const files: SavepointFile[] = [];
  for (const file of record.files) {
    if (!isSavepointFile(file, seenPaths, totalBytes)) throw new Error(`Invalid savepoint: ${basename(path)}`);
    files.push(file);
  }
  return {
    version: 1,
    id: record.id,
    reason: record.reason,
    createdAt: record.createdAt,
    files,
  };
}

async function listManifests(directory: string, maxFiles: number): Promise<SavepointSummary[]> {
  const names: string[] = [];
  try {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (!entry.isFile() || extname(entry.name) !== ".json") continue;
      names.push(entry.name);
      if (names.length >= maxManifestCandidates) break;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  names.sort().reverse();
  const summaries: SavepointSummary[] = [];
  for (const name of names.slice(0, maxManifestCount)) {
    const manifest = await readManifest(join(directory, name), maxFiles).catch(() => undefined);
    if (manifest !== undefined) summaries.push({ id: manifest.id, reason: manifest.reason, createdAt: manifest.createdAt, fileCount: manifest.files.length });
  }
  return summaries;
}

async function diffManifest(root: string, manifest: SavepointManifest): Promise<SavepointDiff> {
  const changed: string[] = [];
  const missing: string[] = [];
  let unchanged = 0;
  for (const file of manifest.files) {
    const path = await resolveWorkspaceFilePath(root, file.path, "Savepoint path must stay inside the workspace").catch(() => undefined);
    if (path === undefined) {
      missing.push(file.path);
      continue;
    }
    const content = await readBoundedFile(path.target, maxSnapshotBytes, "Current workspace file").catch(() => undefined);
    if (content === undefined) {
      missing.push(file.path);
    } else if (hash(content) === file.sha256) {
      unchanged += 1;
    } else {
      changed.push(file.path);
    }
  }
  return { id: manifest.id, changed, missing, unchanged };
}

export default {
  name: "pi-undo-savepoint",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  async apply(context: Context, config: UndoSavepointPluginConfig) {
    const cwd = (await resolveExistingWorkspacePath(context.piHarnessLaunch.cwd, ".", "Workspace path is invalid")).root;
    const store = join(context.piHarnessLaunch.agentDir, safeStoreName(config.storeName));
    const trackedPaths = await normalizedTrackedPaths(cwd, config.trackedPaths ?? defaultTrackedPaths);
    const normalizeLimit = (value: number | undefined, fallback: number, maximum: number): number =>
      typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.trunc(value))) : fallback;
    const maxFiles = normalizeLimit(config.maxFiles, 400, maxManifestFiles);
    const maxFileBytes = normalizeLimit(config.maxFileBytes, 256 * 1024, maxSnapshotBytes);
    const manifestPath = (id: string): string => {
      if (!/^\d{17}-[0-9a-f]{8}$/u.test(id)) throw new Error("Invalid savepoint id");
      return join(store, `${id}.json`);
    };
    const load = async (id: string): Promise<SavepointManifest> => readManifest(manifestPath(id), maxFiles);
    const save = async (reason: string): Promise<SavepointManifest> => {
      const normalizedReason = reason.trim() || "manual savepoint";
      if (normalizedReason.length > maxReasonLength) throw new Error(`Savepoint reason must be at most ${maxReasonLength} characters`);
      const createdAt = new Date().toISOString();
      const id = `${createdAt.replace(/[-:.TZ]/gu, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
      const manifest: SavepointManifest = {
        version: 1,
        id,
        reason: normalizedReason,
        createdAt,
        files: await collectFiles(cwd, trackedPaths, maxFiles, maxFileBytes),
      };
      const serialized = JSON.stringify(manifest, null, 2);
      if (Buffer.byteLength(serialized, "utf8") > maxManifestBytes) throw new Error(`Savepoint manifest exceeds the ${maxManifestBytes}-byte limit`);
      await mkdir(store, { recursive: true });
      await atomicWriteFile(manifestPath(id), serialized, { encoding: "utf8", mode: 0o600 });
      return manifest;
    };
    const restore = async (manifest: SavepointManifest): Promise<string[]> => {
      const restored: string[] = [];
      for (const file of manifest.files) {
        const lexicalPath = resolve(cwd, ...file.path.split("/"));
        if (!withinRoot(cwd, lexicalPath) || isSensitivePath(lexicalPath)) continue;
        const content = Buffer.from(file.content, "base64");
        if (hash(content) !== file.sha256) throw new Error(`Savepoint integrity check failed: ${file.path}`);
        const prepared = await prepareWorkspaceFile(cwd, file.path, `Savepoint path must stay inside the workspace and target a regular file: ${file.path}`);
        await atomicWriteFile(prepared.target, content, { mode: 0o600 });
        restored.push(file.path);
      }
      return restored;
    };
    const report = async (): Promise<{ store: string; trackedPaths: string[]; count: number; savepoints: SavepointSummary[] }> => {
      const savepoints = await listManifests(store, maxFiles);
      return { store, trackedPaths: trackedPaths.map((path) => relativePath(cwd, path) || "."), count: savepoints.length, savepoints };
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "undo_savepoint",
        label: "Undo savepoint",
        description: "Create, inspect, diff, list, and explicitly restore safe local workspace savepoints.",
        promptSnippet: "save or restore a workspace savepoint before risky changes",
        parameters: Type.Object(
          {
            action: Type.Union([Type.Literal("save"), Type.Literal("list"), Type.Literal("diff"), Type.Literal("restore")]),
            id: Type.Optional(Type.String({ description: "Savepoint id for diff or restore" })),
            reason: Type.Optional(Type.String({ description: "Why this savepoint is being created" })),
            confirm: Type.Optional(Type.Boolean({ description: "Must be true before restoring files" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
          if (params.action === "save") {
            const manifest = await save(params.reason ?? "manual savepoint");
            return {
              content: [{ type: "text", text: `Savepoint ${manifest.id} saved (${manifest.files.length} files).` }],
              details: { action: "save", id: manifest.id, fileCount: manifest.files.length },
            };
          }
          if (params.action === "list") {
            const details = await report();
            return { content: [{ type: "text", text: `${details.savepoints.length} savepoints available.` }], details: { action: "list", ...details } };
          }
          if (params.id === undefined || params.id.trim() === "") throw new Error(`action ${params.action} requires id`);
          const manifest = await load(params.id);
          if (params.action === "diff") {
            const details = await diffManifest(cwd, manifest);
            return {
              content: [{ type: "text", text: `${details.changed.length} changed, ${details.missing.length} missing, ${details.unchanged} unchanged.` }],
              details: { action: "diff", ...details },
            };
          }
          if (params.confirm !== true) throw new Error("Restoring a savepoint requires confirm=true");
          const restored = await restore(manifest);
          return {
            content: [{ type: "text", text: `Restored ${restored.length} files from ${manifest.id}.` }],
            details: { action: "restore", id: manifest.id, restored },
          };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "undo-savepoint-panel",
        pluginId: "@pi-harness/core/plugins/undo-savepoint",
        title: "Undo Savepoints",
        description: "保存工作区文件快照，查看列表与变更，并在确认后恢复。",
        icon: "↶",
        read: report,
      });
    } catch (error) {
      unregisterTool();
      throw error;
    }
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
