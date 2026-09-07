import { isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { BoundedFileSizeError, BoundedFileTypeError, assertKnownConfigKeys, readBoundedFile, resolveWorkspaceFilePath } from "@pi-harness/plugin-api";

type PairReport = { base: string; target: string; baseKeys: number; targetKeys: number; missing: string[]; extra: string[] };
type PairStatus = { state: "idle" | "running" | "completed" | "failed" | "cancelled"; at?: string; error?: string };
type InspectParameters = { base: string; target: string };

export type I18nPairConfig = Record<never, never>;

export const Config: z<I18nPairConfig> = z.object({});

const defaultBase = "locales/en.json";
const defaultTarget = "locales/zh-CN.json";
const maxLocaleBytes = 4 * 1024 * 1024;
const maxLocaleDepth = 128;
const maxLocaleKeys = 50_000;
const maxFlattenedKeyLength = 2_048;
const maxLocalePathLength = 4_096;
const maxPanelKeysPerSide = 100;
const maxErrorLength = 2_000;
const inspectParameterNames = new Set(["base", "target"]);
const simplePathSegment = /^[A-Za-z0-9_$@:-]+$/u;
const unsafeUnicode = /[\p{Cc}\p{Cf}\p{Cs}]/u;

function dataObject(value: unknown, label: string): PropertyDescriptorMap {
  if (value === null || typeof value !== "object") throw new Error(`${label} must be a plain object`);
  let array: boolean;
  let prototype: unknown;
  let descriptors: PropertyDescriptorMap;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new Error(`${label} must be an accessible plain object`, { cause: error });
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) throw new Error(`${label} must be a plain object`);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error(`${label} must use data properties`);
  return descriptors;
}

function assertConfig(config: unknown): asserts config is I18nPairConfig {
  const descriptors = dataObject(config, "I18n pair config");
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) throw new Error("Unknown I18n pair config key: symbol");
  assertKnownConfigKeys("I18n pair", config, []);
}

function cloneReport(report: PairReport): PairReport {
  return { ...report, missing: [...report.missing], extra: [...report.extra] };
}

function panelReport(report: PairReport) {
  const missing = report.missing.slice(0, maxPanelKeysPerSide);
  const extra = report.extra.slice(0, maxPanelKeysPerSide);
  return {
    ...report,
    missing,
    extra,
    missingTotal: report.missing.length,
    extraTotal: report.extra.length,
    truncated: missing.length !== report.missing.length || extra.length !== report.extra.length,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("I18n pair operation was cancelled", { cause: signal.reason });
}

function rejectionError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(rejectionError(error, "I18n pair operation was cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(rejectionError(error, "I18n pair operation was cancelled"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(rejectionError(error, "I18n pair operation failed"));
      },
    );
  });
}

function boundedError(error: unknown): string {
  let message: string | undefined;
  if (typeof error === "string") message = error;
  else if (typeof error === "object" && error !== null) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") message = descriptor.value;
    } catch {
      // Fall through to the stable message below.
    }
  }
  if (message === undefined) return "Unknown I18n pair error";
  let output = "";
  let outputBytes = 0;
  let outputCharacters = 0;
  let scanned = 0;
  for (const character of message) {
    scanned += 1;
    if (scanned > maxErrorLength * 4) break;
    const safe = unsafeUnicode.test(character) ? " " : character;
    if (output === "" && /^\s$/u.test(safe)) continue;
    const bytes = Buffer.byteLength(safe, "utf8");
    if (outputCharacters >= maxErrorLength || outputBytes + bytes > maxErrorLength) break;
    output += safe;
    outputBytes += bytes;
    outputCharacters += 1;
  }
  return output.trimEnd() || "Unknown I18n pair error";
}

function localePath(value: string, field: string): string {
  if (value.length === 0) throw new Error(`I18n check ${field} must contain 1-${maxLocalePathLength} characters`);
  if (value !== value.trim()) throw new Error(`I18n check ${field} must not have leading or trailing whitespace`);
  if (value.length > maxLocalePathLength || Buffer.byteLength(value, "utf8") > maxLocalePathLength)
    throw new Error(`I18n check ${field} must contain at most ${maxLocalePathLength} characters and UTF-8 bytes`);
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]{2}/u.test(value))
    throw new Error(`I18n check ${field} must be relative to the current workspace`);
  if (value.includes("\0")) throw new Error(`I18n check ${field} must not contain NUL characters`);
  if (unsafeUnicode.test(value)) throw new Error(`I18n check ${field} must not contain Unicode control characters`);
  return value;
}

function inspectParameters(value: unknown): InspectParameters {
  const descriptors = dataObject(value, "I18n check parameters");
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !inspectParameterNames.has(key)))
    throw new Error("I18n check parameters contain an unknown property");
  const baseValue: unknown = descriptors.base?.value;
  const targetValue: unknown = descriptors.target?.value;
  const base: unknown = baseValue === undefined ? defaultBase : baseValue;
  const target: unknown = targetValue === undefined ? defaultTarget : targetValue;
  if (typeof base !== "string") throw new Error("I18n check base must be a string");
  if (typeof target !== "string") throw new Error("I18n check target must be a string");
  return { base: localePath(base, "base"), target: localePath(target, "target") };
}

function displayKeyPath(segments: readonly string[]): string {
  let result = "";
  for (const segment of segments) {
    if (simplePathSegment.test(segment)) result += result === "" ? segment : `.${segment}`;
    else result += `[${JSON.stringify(segment)}]`;
  }
  return result;
}

function flatten(value: unknown, signal: AbortSignal): Map<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Locale root must be a JSON object");
  const keys = new Map<string, string>();
  const pending: Array<{ value: unknown; segments: string[]; depth: number }> = [{ value, segments: [], depth: 0 }];
  while (pending.length > 0) {
    if ((pending.length & 255) === 0) throwIfAborted(signal);
    const current = pending.pop()!;
    if (current.depth > maxLocaleDepth) throw new Error(`Locale objects cannot exceed ${maxLocaleDepth} levels of nesting`);
    if (current.value === null || typeof current.value !== "object" || Array.isArray(current.value)) {
      const display = displayKeyPath(current.segments);
      if (display.length > maxFlattenedKeyLength || Buffer.byteLength(display, "utf8") > maxFlattenedKeyLength)
        throw new Error(`Locale flattened keys cannot exceed ${maxFlattenedKeyLength} characters and UTF-8 bytes`);
      keys.set(JSON.stringify(current.segments), display);
      if (keys.size > maxLocaleKeys) throw new Error(`Locale files cannot exceed ${maxLocaleKeys} flattened keys`);
      continue;
    }
    const entries = Object.entries(current.value as Record<string, unknown>);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      if (unsafeUnicode.test(key)) throw new Error("Locale keys must not contain Unicode control characters");
      pending.push({ value: child, segments: [...current.segments, key], depth: current.depth + 1 });
    }
  }
  return keys;
}

async function readLocale(workspace: string, requested: string, signal: AbortSignal): Promise<{ path: string; keys: Map<string, string> }> {
  throwIfAborted(signal);
  let resolved: Awaited<ReturnType<typeof resolveWorkspaceFilePath>>;
  try {
    resolved = await resolveWorkspaceFilePath(workspace, requested, "Locale path must stay inside the current workspace");
  } catch (error) {
    throw new Error("Could not resolve locale file inside the current workspace", { cause: error });
  }
  throwIfAborted(signal);
  let source: Buffer;
  try {
    source = await readBoundedFile(resolved.target, maxLocaleBytes, "Locale file");
  } catch (error) {
    if (error instanceof BoundedFileSizeError) throw new Error("Locale file exceeds the 4 MiB limit", { cause: error });
    if (error instanceof BoundedFileTypeError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Could not resolve locale file inside the current workspace", { cause: error });
    throw new Error("Could not read locale file", { cause: error });
  }
  throwIfAborted(signal);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch (error) {
    throw new Error("Locale file must contain valid UTF-8", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Invalid locale JSON", { cause: error });
  }
  throwIfAborted(signal);
  return { path: resolved.relativePath, keys: flatten(parsed, signal) };
}

async function inspectPair(workspace: string, base: string, target: string, signal: AbortSignal): Promise<PairReport> {
  const [baseLocale, targetLocale] = await Promise.all([readLocale(workspace, base, signal), readLocale(workspace, target, signal)]);
  throwIfAborted(signal);
  const missing = [...baseLocale.keys].filter(([canonical]) => !targetLocale.keys.has(canonical)).map(([, display]) => display);
  const extra = [...targetLocale.keys].filter(([canonical]) => !baseLocale.keys.has(canonical)).map(([, display]) => display);
  missing.sort();
  extra.sort();
  return { base: baseLocale.path, target: targetLocale.path, baseKeys: baseLocale.keys.size, targetKeys: targetLocale.keys.size, missing, extra };
}

export default {
  name: "pi-i18n-pair",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: I18nPairConfig) {
    assertConfig(config);
    let latest: PairReport | undefined;
    let status: PairStatus = { state: "idle" };
    const lifecycle = new AbortController();
    let unregisterTool: () => void = () => undefined;
    let disposePanel: () => void = () => undefined;
    try {
      unregisterTool = context.piTools.register(
        defineTool({
          name: "i18n_check",
          label: "I18n check",
          description: "Compare two local JSON locale files and report missing or extra translation keys.",
          promptSnippet: "check translation key parity between two locale files",
          parameters: Type.Object(
            {
              base: Type.Optional(Type.String({ description: "Base locale path", minLength: 1, maxLength: maxLocalePathLength })),
              target: Type.Optional(Type.String({ description: "Target locale path", minLength: 1, maxLength: maxLocalePathLength })),
            },
            { additionalProperties: false },
          ),
          executionMode: "sequential",
          async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<PairReport>> {
            const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            status = { state: "running" };
            try {
              throwIfAborted(operationSignal);
              const params = inspectParameters(rawParams);
              const report = await withCancellation(inspectPair(context.piHarnessLaunch.cwd, params.base, params.target, operationSignal), operationSignal);
              throwIfAborted(operationSignal);
              latest = cloneReport(report);
              status = { state: "completed", at: new Date().toISOString() };
              return {
                content: [{ type: "text", text: `${report.target}: ${report.missing.length} missing and ${report.extra.length} extra keys.` }],
                details: cloneReport(report),
              };
            } catch (error) {
              status = {
                state: operationSignal.aborted ? "cancelled" : "failed",
                at: new Date().toISOString(),
                error: boundedError(error),
              };
              throw error;
            }
          },
        }),
      );
      disposePanel = context.piPluginUi.register({
        id: "i18n-pair-panel",
        pluginId: "@pi-harness/core/plugins/i18n-pair",
        title: "I18n Pair",
        description: "检查两个本地语言包的键是否同步，不自动改写翻译文件。",
        icon: "文",
        read: () => ({
          report: latest === undefined ? null : panelReport(latest),
          status: { ...status },
          limits: {
            fileBytes: maxLocaleBytes,
            depth: maxLocaleDepth,
            keysPerFile: maxLocaleKeys,
            flattenedKeyLength: maxFlattenedKeyLength,
            pathLength: maxLocalePathLength,
            panelKeysPerSide: maxPanelKeysPerSide,
          },
        }),
      });
    } catch (error) {
      disposePanel();
      unregisterTool();
      lifecycle.abort(new Error("I18n pair plugin registration failed"));
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("I18n pair plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
