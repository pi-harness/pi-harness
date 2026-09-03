import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isPathInside, prepareWorkspaceFile, resolveExistingWorkspacePath } from "../workspace-path.js";

const defaultStoreName = "undo-savepoints";
const defaultTrackedPaths = ["."];
const maxSnapshotBytes = 2 * 1024 * 1024;
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
  const visit = async (path: string): Promise<void> => {
    if (files.length >= maxFiles || isIgnoredPath(path) || isSensitivePath(path)) return;
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) return;
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        await visit(join(path, entry.name));
        if (files.length >= maxFiles) return;
      }
      return;
    }
    if (!info.isFile() || info.size > maxFileBytes) return;
    const content = await readFile(path);
    if (content.includes(0)) return;
    const relativeName = relativePath(root, path);
    if (relativeName === "" || seen.has(relativeName)) return;
    seen.add(relativeName);
    files.push({ path: relativeName, bytes: content.byteLength, sha256: hash(content), content: content.toString("base64") });
  };
  for (const path of trackedPaths) {
    await visit(path);
    if (files.length >= maxFiles) break;
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readManifest(path: string): Promise<SavepointManifest> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SavepointManifest>;
  if (parsed.version !== 1 || typeof parsed.id !== "string" || !Array.isArray(parsed.files)) throw new Error(`Invalid savepoint: ${basename(path)}`);
  return {
    version: 1,
    id: parsed.id,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    files: parsed.files.filter(
      (file): file is SavepointFile =>
        typeof file === "object" &&
        file !== null &&
        typeof file.path === "string" &&
        typeof file.bytes === "number" &&
        typeof file.sha256 === "string" &&
        typeof file.content === "string",
    ),
  };
}

async function listManifests(directory: string): Promise<SavepointSummary[]> {
  const names = (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => extname(name) === ".json")
    .sort()
    .reverse();
  const summaries: SavepointSummary[] = [];
  for (const name of names) {
    const manifest = await readManifest(join(directory, name)).catch(() => undefined);
    if (manifest !== undefined) summaries.push({ id: manifest.id, reason: manifest.reason, createdAt: manifest.createdAt, fileCount: manifest.files.length });
  }
  return summaries;
}

async function diffManifest(root: string, manifest: SavepointManifest): Promise<SavepointDiff> {
  const changed: string[] = [];
  const missing: string[] = [];
  let unchanged = 0;
  for (const file of manifest.files) {
    const path = await resolveExistingWorkspacePath(root, file.path, "Savepoint path must stay inside the workspace").catch(() => undefined);
    if (path === undefined) {
      missing.push(file.path);
      continue;
    }
    const content = await readFile(path.target).catch(() => undefined);
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
    const maxFiles = Math.max(1, Math.min(2_000, Math.trunc(config.maxFiles ?? 400)));
    const maxFileBytes = Math.max(1, Math.min(maxSnapshotBytes, Math.trunc(config.maxFileBytes ?? 256 * 1024)));
    const manifestPath = (id: string): string => {
      if (!/^\d{17}-[0-9a-f]{8}$/u.test(id)) throw new Error("Invalid savepoint id");
      return join(store, `${id}.json`);
    };
    const load = async (id: string): Promise<SavepointManifest> => readManifest(manifestPath(id));
    const save = async (reason: string): Promise<SavepointManifest> => {
      const createdAt = new Date().toISOString();
      const id = `${createdAt.replace(/[-:.TZ]/gu, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
      const manifest: SavepointManifest = {
        version: 1,
        id,
        reason: reason.trim() || "manual savepoint",
        createdAt,
        files: await collectFiles(cwd, trackedPaths, maxFiles, maxFileBytes),
      };
      await mkdir(store, { recursive: true });
      const temporary = join(store, `.${id}.tmp`);
      await writeFile(temporary, JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, manifestPath(id));
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
        const temporary = `${prepared.target}.${randomUUID()}.tmp`;
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, prepared.target);
        restored.push(file.path);
      }
      return restored;
    };
    const report = async (): Promise<{ store: string; trackedPaths: string[]; count: number; savepoints: SavepointSummary[] }> => {
      const savepoints = await listManifests(store);
      return { store, trackedPaths: trackedPaths.map((path) => relativePath(cwd, path) || "."), count: savepoints.length, savepoints };
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "undo_savepoint",
        label: "Undo savepoint",
        description: "Create, inspect, diff, list, and explicitly restore safe local workspace savepoints.",
        promptSnippet: "save or restore a workspace savepoint before risky changes",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("save"), Type.Literal("list"), Type.Literal("diff"), Type.Literal("restore")]),
          id: Type.Optional(Type.String({ description: "Savepoint id for diff or restore" })),
          reason: Type.Optional(Type.String({ description: "Why this savepoint is being created" })),
          confirm: Type.Optional(Type.Boolean({ description: "Must be true before restoring files" })),
        }),
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
    const disposePanel = context.piPluginUi.register({
      id: "undo-savepoint-panel",
      pluginId: "@pi-harness/core/plugins/undo-savepoint",
      title: "Undo Savepoints",
      description: "保存工作区文件快照，查看列表与变更，并在确认后恢复。",
      icon: "↶",
      read: report,
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
