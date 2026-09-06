export type ReadmeGenOperation = "report" | "write";
export type ReadmeGenStatusState = "idle" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface ReadmeGenPanelView {
  readonly generated: { readonly name: string; readonly scripts: number; readonly plugins: number } | null;
  readonly lastWrite: { readonly path: string; readonly bytes: number; readonly overwritten: boolean } | null;
  readonly status: {
    readonly state: ReadmeGenStatusState;
    readonly operation: ReadmeGenOperation | null;
    readonly at: string | null;
    readonly error: string | null;
  };
  readonly malformed: boolean;
  readonly limits: {
    readonly nameCharacters: number;
    readonly pathCharacters: number;
    readonly scripts: number;
    readonly plugins: number;
    readonly errorCharacters: number;
  };
}

const limits = { nameCharacters: 256, pathCharacters: 512, scripts: 256, plugins: 256, errorCharacters: 2_000 } as const;
const maxMarkdownBytes = 1024 * 1024;
const rootKeys = new Set(["generated", "name", "scripts", "plugins", "lastWrite", "status"]);
const writeKeys = new Set(["path", "bytes", "overwritten"]);
const statusKeys = new Set(["state", "operation", "at", "error"]);

function ownDataRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function count(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || [...value].length > limits.nameCharacters) return undefined;
  if (new TextEncoder().encode(value).byteLength > 512 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return undefined;
  return value;
}

function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || value !== value.trim() || [...value].length > limits.pathCharacters) return undefined;
  if (new TextEncoder().encode(value).byteLength > limits.pathCharacters || /[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return undefined;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment !== segment.trim())) return undefined;
  const fileName = segments.at(-1);
  return fileName !== undefined && /^README(?:[._-][^/]*)?\.md$/iu.test(fileName) ? value : undefined;
}

function statusView(value: unknown): ReadmeGenPanelView["status"] | undefined {
  const source = ownDataRecord(value, statusKeys);
  if (source === undefined) return undefined;
  const state = source.state;
  const operation = source.operation;
  const at = source.at;
  const error = source.error;
  const hasOperation = Object.hasOwn(source, "operation");
  const hasAt = Object.hasOwn(source, "at");
  const hasError = Object.hasOwn(source, "error");
  if (state === "idle" && !hasOperation && !hasAt && !hasError) return { state, operation: null, at: null, error: null };
  if (state === "running" && (operation === "report" || operation === "write") && !hasAt && !hasError) return { state, operation, at: null, error: null };
  const normalizedAt = timestamp(at);
  if (state === "completed" && (operation === "report" || operation === "write") && normalizedAt !== undefined && !hasError)
    return { state, operation, at: normalizedAt, error: null };
  if (
    (state === "failed" || state === "cancelled") &&
    (operation === "report" || operation === "write") &&
    normalizedAt !== undefined &&
    typeof error === "string" &&
    error.length > 0 &&
    error.length <= limits.errorCharacters &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(error)
  )
    return { state, operation, at: normalizedAt, error };
  return undefined;
}

function malformedView(): ReadmeGenPanelView {
  return {
    generated: null,
    lastWrite: null,
    status: { state: "unknown", operation: null, at: null, error: null },
    malformed: true,
    limits: { ...limits },
  };
}

export function readmeGenPanelView(data: unknown): ReadmeGenPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined || typeof source.generated !== "boolean") return malformedView();
  const status = statusView(source.status);
  if (status === undefined) return malformedView();

  let generated: ReadmeGenPanelView["generated"] = null;
  if (source.generated) {
    const name = safeName(source.name);
    const scripts = count(source.scripts, limits.scripts);
    const plugins = count(source.plugins, limits.plugins);
    if (name === undefined || scripts === undefined || plugins === undefined) return malformedView();
    generated = { name, scripts, plugins };
  } else if (Object.hasOwn(source, "name") || Object.hasOwn(source, "scripts") || Object.hasOwn(source, "plugins")) {
    return malformedView();
  }

  let lastWrite: ReadmeGenPanelView["lastWrite"] = null;
  if (source.lastWrite !== null) {
    const write = ownDataRecord(source.lastWrite, writeKeys);
    const path = safePath(write?.path);
    const bytes = count(write?.bytes, maxMarkdownBytes);
    const overwritten = write?.overwritten;
    if (write === undefined || path === undefined || bytes === undefined || typeof overwritten !== "boolean") return malformedView();
    lastWrite = { path, bytes, overwritten };
  }

  if ((!source.generated && lastWrite !== null) || (status.state === "idle" && (source.generated || lastWrite !== null))) return malformedView();
  if (status.state === "completed" && (!source.generated || (status.operation === "write" && lastWrite === null))) return malformedView();
  return { generated, lastWrite, status, malformed: false, limits: { ...limits } };
}
