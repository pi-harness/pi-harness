import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, opendir } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  atomicWriteFile,
  isPathInside,
  prepareWorkspaceFile,
  readBoundedFile,
  readBoundedTextFile,
  resolveExistingWorkspacePath,
  resolveWorkspaceFilePath,
} from "@pi-harness/plugin-api";

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
const maxNamedSkips = 5;
const sensitiveNames = new Set([
  ".env",
  ".envrc",
  ".npmrc",
  ".netrc",
  ".credentials",
  ".credentials.yaml",
  ".credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
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
  mode?: number;
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

// The one fold this file uses to decide whether a manifest's spelling of a name is the same name a case-insensitive filesystem will open. Plain `toLowerCase` is not that fold. Measured with stat/inode comparison on APFS, `diſt` (U+017F LATIN SMALL LETTER LONG S), `diﬅ` (U+FB05) and `diﬆ` (U+FB06) all open `dist`, `node_moduleſ` opens `node_modules`, `id_rſa` opens `id_rsa` and `x.Key` (U+212A KELVIN SIGN) opens `x.key`; NFKC maps every one of those onto its plain spelling before the lowercase runs. Measured on an HFS+ volume (`hdiutil create -fs HFS+`, still what macOS mounts for many external and Time Machine disks), the filesystem additionally ignores 16 codepoints entirely when comparing names - U+200C..U+200F, U+202A..U+202E, U+206A..U+206F and U+FEFF - so `.git‮`, `node_modules‍` and `id_r‌sa` open `.git`, `node_modules` and `id_rsa`. Stripping the whole Default_Ignorable_Code_Point property covers those 16 and is deliberately wider, because a manifest is untrusted input and refusing an exotic spelling costs only a skipped entry. NFKC is likewise wider than any filesystem fold measured here - APFS keeps `diｓt` as a separate name - and is kept for the same reason. An earlier revision also uppercased before lowercasing; that step turned out to match nothing NFKC did not already handle while wrongly folding dotless i (`dıst`, `.credentıals`) onto the ASCII spelling, which silently dropped real files from snapshots, so it is gone.
function foldName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .toLowerCase();
}

function isSensitivePath(path: string): boolean {
  const name = foldName(basename(path));
  return sensitiveNames.has(name) || name.startsWith(".env.") || name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12");
}

// The single ignore check for both the snapshot walk and the restore, and it wants a workspace-relative path: the directory the workspace itself lives in is not the agent's business, so a project checked out at ~/build/myproject must still snapshot its own files. Manifest paths are "/"-separated while relative workspace paths use the platform separator, so it splits on both rather than making each caller normalise. collectFiles reads the on-disk name from a dirent and never sees a case variant, but a hand-edited manifest can spell an ignored directory in any case and a case-insensitive filesystem (APFS, NTFS) will still land inside the real one.
function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split(/[/\\]/u).some((part) => ignoredDirectories.has(foldName(part)));
}

// A manifest is a plain JSON file in the agent directory, so the mode it records is untrusted. Restore masks off every execute bit, because a manifest that could mark a file executable is a way to plant a runnable script, and it masks off group and other write, the bit that would let another local account rewrite a workspace file. The owner read/write bits are forced back on so a manifest cannot leave a restored file that its owner can no longer open. Only group and other read survive from the manifest.
function restorableMode(mode: number): number {
  return (mode & 0o644) | 0o600;
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
    if (files.length >= maxFiles || totalBytes >= maxTotalSnapshotBytes || isIgnoredPath(relative(root, path)) || isSensitivePath(path)) return;
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
    files.push({ path: relativeName, bytes: content.byteLength, sha256: hash(content), content: content.toString("base64"), mode: info.mode & 0o777 });
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

// An entry naming an ignored directory is deliberately not checked here. Manifests taken before the save side folded case can legitimately contain `Build/x.ts`, and rejecting the whole file for one such entry destroys the savepoint: `list` stops showing it and `restore` refuses the innocent entries alongside it. Restore skips those entries instead and reports them. Everything that makes a manifest structurally untrustworthy - bad JSON, a path that escapes the workspace, a sensitive name, a hash that does not match - still fails the whole manifest here.
function isSavepointFile(value: unknown, seenPaths: Set<string>, totalBytes: { value: number }): value is SavepointFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some((key) => !new Set(["path", "bytes", "sha256", "content", "mode"]).has(key))) return false;
  if (
    (file.mode !== undefined && (typeof file.mode !== "number" || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) ||
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
    const restore = async (manifest: SavepointManifest): Promise<{ restored: string[]; skipped: string[] }> => {
      const restored: string[] = [];
      const skipped: string[] = [];
      for (const file of manifest.files) {
        const lexicalPath = resolve(cwd, ...file.path.split("/"));
        // The ignore list that keeps collectFiles out of .git and friends has to hold on the way back in as well, otherwise a hand-edited manifest could write a directory a savepoint is never allowed to snapshot. This runs before prepareWorkspaceFile precisely so a blocked entry never gets its parent directory created.
        if (!withinRoot(cwd, lexicalPath) || isSensitivePath(lexicalPath) || isIgnoredPath(relative(cwd, lexicalPath))) {
          skipped.push(file.path);
          continue;
        }
        const content = Buffer.from(file.content, "base64");
        if (hash(content) !== file.sha256) throw new Error(`Savepoint integrity check failed: ${file.path}`);
        const prepared = await prepareWorkspaceFile(cwd, file.path, `Savepoint path must stay inside the workspace and target a regular file: ${file.path}`);
        // prepareWorkspaceFile realpaths the parent directory, so the same check has to run again on the canonical path: the lexical one above only sees what the manifest spelled, and a workspace symlink, or a trailing dot that Windows strips, can spell something that resolves into an ignored directory the lexical spelling never named.
        if (isIgnoredPath(prepared.relativePath)) {
          skipped.push(file.path);
          continue;
        }
        const destinationMode = prepared.exists ? (await lstat(prepared.target)).mode & 0o777 : undefined;
        // atomicWriteFile renames a freshly created temporary file over the target, so the temporary file's permissions become the target's. Passing no mode at all makes it carry over the bits the target already has, or fall back to owner-only for a file the restore creates: that is what a manifest written before modes were recorded needs, and it is also how an already executable destination keeps its own execute bit, which the manifest itself is never allowed to grant.
        const mode = file.mode === undefined || (destinationMode !== undefined && (destinationMode & 0o111) !== 0) ? undefined : restorableMode(file.mode);
        await atomicWriteFile(prepared.target, content, mode === undefined ? {} : { mode });
        restored.push(file.path);
      }
      return { restored, skipped };
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
          const { restored, skipped } = await restore(manifest);
          // The skipped names come straight out of an untrusted manifest, which may hold up to 2000 entries of up to 4096 characters each and puts no restriction on newlines. The text goes to the model verbatim, so only the first few names are named, and each is JSON-quoted so a path cannot break out of the sentence. The full list is in the details.
          const named = skipped.slice(0, maxNamedSkips).map((path) => JSON.stringify(path));
          const remainder = skipped.length - named.length;
          const skippedNote =
            skipped.length === 0
              ? ""
              : ` Skipped ${skipped.length} entries that target an ignored directory: ${named.join(", ")}${remainder === 0 ? "" : `, and ${remainder} more`}.`;
          return {
            content: [{ type: "text", text: `Restored ${restored.length} files from ${manifest.id}.${skippedNote}` }],
            details: { action: "restore", id: manifest.id, restored, skipped },
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
