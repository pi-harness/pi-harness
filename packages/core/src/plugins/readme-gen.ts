import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile } from "../atomic-write.js";
import { BoundedFileSizeError, BoundedFileTypeError, readBoundedTextFile } from "../bounded-file.js";

export type ReadmeMetadata = { name: string; version: string; description: string; scripts: string[]; plugins: string[] };
export type ReadmeReport = ReadmeMetadata & { markdown: string };
export type ReadmeWriteReport = { path: string; bytes: number; overwritten: boolean };
const maxManifestBytes = 1024 * 1024;
const maxOutputPathLength = 512;
const maxPackageNameCharacters = 256;
const maxPackageNameBytes = 512;
const maxPackageVersionCharacters = 128;
const maxPackageVersionBytes = 256;
const maxPackageDescriptionCharacters = 4_096;
const maxPackageDescriptionBytes = 4_096;
const maxScripts = 256;
const maxScriptNameCharacters = 256;
const maxScriptNameBytes = 512;
const maxLoaderEntries = 1_024;
const maxPlugins = 256;
const maxPluginNameCharacters = 256;
const maxPluginNameBytes = 512;
const maxStatusErrorCharacters = 2_000;

type ReadmeOperation = "report" | "write";
type ReadmeStatus =
  | { state: "idle" }
  | { state: "running"; operation: ReadmeOperation }
  | { state: "completed" | "failed" | "cancelled"; operation: ReadmeOperation; at: string; error?: string };

export type ReadmeGenConfig = Record<never, never>;

export const Config: z<ReadmeGenConfig> = z.object({});

function boundedError(error: unknown, fallback = "Unknown README generator error"): string {
  let message: string | undefined;
  if (typeof error === "string") message = error;
  if (typeof error === "object" && error !== null) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") message = descriptor.value;
    } catch {
      // Use the stable fallback below.
    }
  }
  const sanitized = message
    ?.replaceAll(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    .trim()
    .slice(0, maxStatusErrorCharacters);
  return sanitized === undefined || sanitized === "" ? fallback : sanitized;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new Error(boundedError(signal.reason, "README operation was cancelled"), { cause: signal.reason });
}

function dataDescriptors(value: unknown, field: string, allowed: ReadonlySet<string>): Record<PropertyKey, PropertyDescriptor> {
  if (value === null || typeof value !== "object") throw new Error(`${field} must be a plain object`);
  let descriptors: PropertyDescriptorMap;
  let prototype: unknown;
  let array: boolean;
  try {
    array = Array.isArray(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value) as unknown;
  } catch (error) {
    throw new Error(`${field} must be an accessible plain object`, { cause: error });
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) throw new Error(`${field} must be a plain object`);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) throw new Error(`${field} contains an unknown property`);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error(`${field} must use data properties`);
  return descriptors;
}

function reportParameters(value: unknown): void {
  dataDescriptors(value, "README report parameters", new Set());
}

function assertReadmeGenConfig(value: unknown): void {
  try {
    dataDescriptors(value, "README generator config", new Set());
  } catch (error) {
    throw new Error("Unknown or invalid readme-gen config", { cause: error });
  }
}

function writeParameters(value: unknown): { outputPath: string; confirm: boolean; overwrite: boolean } {
  const descriptors = dataDescriptors(value, "README write parameters", new Set(["outputPath", "confirm", "overwrite"]));
  const outputPath: unknown = descriptors.outputPath?.value;
  const confirm: unknown = descriptors.confirm?.value;
  const overwrite: unknown = descriptors.overwrite?.value;
  if (outputPath !== undefined && typeof outputPath !== "string") throw new Error("README write outputPath must be a string");
  if (typeof confirm !== "boolean") throw new Error("README write confirm must be a boolean");
  if (overwrite !== undefined && typeof overwrite !== "boolean") throw new Error("README write overwrite must be a boolean");
  return { outputPath: outputPath ?? "README.generated.md", confirm, overwrite: overwrite ?? false };
}

function plainMarkdown(value: string): string {
  return value.replaceAll(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ").replaceAll(/([\\*_[\]<>#~|>])/gu, "\\$1");
}

function codeSpan(value: string): string {
  const normalized = value.replaceAll(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ");
  const longestRun = Math.max(0, ...(normalized.match(/`+/gu)?.map((run) => run.length) ?? []));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${normalized}${fence}`;
}

function boundedString(descriptor: PropertyDescriptor | undefined, fallback: string, label: string, maxCharacters: number, maxBytes: number): string {
  if (descriptor === undefined) return fallback;
  if (!("value" in descriptor) || typeof descriptor.value !== "string") throw new Error(`${label} must be a string`);
  const value = descriptor.value;
  if ([...value].length > maxCharacters) throw new Error(`${label} must be at most ${maxCharacters} characters`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} must be at most ${maxBytes} UTF-8 bytes`);
  return value;
}

function manifestMetadata(packageJson: Record<string, unknown>): Omit<ReadmeMetadata, "plugins"> {
  const descriptors = Object.getOwnPropertyDescriptors(packageJson);
  const name = boundedString(descriptors.name, "Unnamed project", "Package name", maxPackageNameCharacters, maxPackageNameBytes);
  const version = boundedString(descriptors.version, "unknown", "Package version", maxPackageVersionCharacters, maxPackageVersionBytes);
  const description = boundedString(descriptors.description, "", "Package description", maxPackageDescriptionCharacters, maxPackageDescriptionBytes);
  if (name === "") throw new Error("Package name must be non-empty");
  if (name !== name.trim()) throw new Error("Package name must not have leading or trailing whitespace");
  if (version === "") throw new Error("Package version must be non-empty");
  if (version !== version.trim()) throw new Error("Package version must not have leading or trailing whitespace");
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(name)) throw new Error("Package name cannot contain Unicode control characters");
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(version)) throw new Error("Package version cannot contain Unicode control characters");
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(description)) throw new Error("Package description cannot contain Unicode control characters");
  const scriptsDescriptor = descriptors.scripts;
  if (scriptsDescriptor === undefined) return { name, version, description, scripts: [] };
  if (!("value" in scriptsDescriptor)) throw new Error("Package scripts must use a data property");
  const rawScripts: unknown = scriptsDescriptor.value;
  if (rawScripts === null || typeof rawScripts !== "object" || Array.isArray(rawScripts)) throw new Error("Package scripts must be an object");
  const scripts = Object.keys(rawScripts).sort();
  if (scripts.length > maxScripts) throw new Error(`Package scripts must contain at most ${maxScripts} entries`);
  for (const script of scripts) {
    if (script === "") throw new Error("Script name must be non-empty");
    if (script !== script.trim()) throw new Error("Script name must not have leading or trailing whitespace");
    if ([...script].length > maxScriptNameCharacters) throw new Error(`Script name must be at most ${maxScriptNameCharacters} characters`);
    if (Buffer.byteLength(script, "utf8") > maxScriptNameBytes) throw new Error(`Script name must be at most ${maxScriptNameBytes} UTF-8 bytes`);
    if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(script)) throw new Error("Script name cannot contain Unicode control characters");
  }
  return { name, version, description, scripts };
}

function descriptorMethod(value: unknown, key: PropertyKey, label: string): (...args: never[]) => unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") throw new Error(`${label} must be an object`);
  let current: object | null = value;
  try {
    for (let depth = 0; current !== null && depth < 32; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        const method: unknown = "value" in descriptor ? descriptor.value : undefined;
        if (typeof method !== "function") throw new Error(`${label} must expose ${String(key)} as a data method`);
        return function descriptorSafeMethod(this: unknown, ...args: never[]): unknown {
          return Reflect.apply(method, this, args);
        };
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch (error) {
    throw new Error(`${label} must be descriptor-accessible`, { cause: error });
  }
  throw new Error(`${label} must expose ${String(key)} as a data method`);
}

function loaderPluginNames(loader: unknown): string[] {
  if (loader === undefined) return [];
  const entriesMethod = descriptorMethod(loader, "entries", "README loader");
  let iterable: unknown;
  try {
    iterable = entriesMethod.call(loader);
  } catch (error) {
    throw new Error("Could not enumerate README loader entries", { cause: error });
  }
  if (iterable === null || typeof iterable !== "object") throw new Error("README loader entries must be iterable");
  const iteratorMethod = descriptorMethod(iterable, Symbol.iterator, "README loader entries");
  let iterator: object;
  try {
    const candidate: unknown = iteratorMethod.call(iterable);
    if (candidate === null || typeof candidate !== "object") throw new Error("README loader iterator must be an object");
    iterator = candidate;
  } catch (error) {
    throw new Error("Could not iterate README loader entries", { cause: error });
  }
  const nextMethod = descriptorMethod(iterator, "next", "README loader iterator");
  const plugins = new Set<string>();
  for (let scanned = 0; ; scanned += 1) {
    if (scanned > maxLoaderEntries) throw new Error(`README loader must contain at most ${maxLoaderEntries} entries`);
    let rawStep: unknown;
    try {
      rawStep = nextMethod.call(iterator);
    } catch (error) {
      throw new Error("Could not iterate README loader entries", { cause: error });
    }
    let stepDescriptors: Record<PropertyKey, PropertyDescriptor>;
    try {
      stepDescriptors = dataDescriptors(rawStep, "README loader iterator result", new Set(["done", "value"]));
    } catch (error) {
      throw new Error("README loader iterator result must use data properties", { cause: error });
    }
    const done: unknown = stepDescriptors.done?.value;
    if (typeof done !== "boolean") throw new Error("README loader iterator result done flag must be a boolean data property");
    if (done) break;
    const entry: unknown = stepDescriptors.value?.value;
    if (entry === null || typeof entry !== "object") throw new Error("README loader entry must be an object");
    let entryDescriptors: PropertyDescriptorMap;
    try {
      entryDescriptors = Object.getOwnPropertyDescriptors(entry);
    } catch (error) {
      throw new Error("README loader entry must be descriptor-accessible", { cause: error });
    }
    const fiberDescriptor = entryDescriptors.fiber;
    if (fiberDescriptor !== undefined) {
      if (!("value" in fiberDescriptor)) throw new Error("README loader entry fiber must be a data property");
      if (fiberDescriptor.value === undefined || fiberDescriptor.value === null) continue;
      if (typeof fiberDescriptor.value !== "object") throw new Error("README loader entry fiber must be an object when active");
    }
    const optionsDescriptor = entryDescriptors.options;
    if (optionsDescriptor === undefined || !("value" in optionsDescriptor)) throw new Error("README loader entry options must be a data property");
    const options: unknown = optionsDescriptor.value;
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error("README loader entry options must be an object");
    let optionDescriptors: PropertyDescriptorMap;
    try {
      optionDescriptors = Object.getOwnPropertyDescriptors(options);
    } catch (error) {
      throw new Error("README loader entry options must be descriptor-accessible", { cause: error });
    }
    const disabledDescriptor = optionDescriptors.disabled;
    if (fiberDescriptor === undefined) {
      if (disabledDescriptor !== undefined && !("value" in disabledDescriptor)) throw new Error("README loader disabled flag must be a data property");
      const disabled: unknown = disabledDescriptor?.value;
      if (disabled !== undefined && disabled !== null && typeof disabled !== "boolean") throw new Error("README loader disabled flag must be boolean or null");
      if (disabled === true) continue;
    }
    const nameDescriptor = optionDescriptors.name;
    if (nameDescriptor === undefined || !("value" in nameDescriptor) || typeof nameDescriptor.value !== "string")
      throw new Error("README loader plugin name must be a string data property");
    const name = nameDescriptor.value;
    if ([...name].length === 0 || [...name].length > maxPluginNameCharacters)
      throw new Error(`README loader plugin name must contain 1-${maxPluginNameCharacters} characters`);
    if (Buffer.byteLength(name, "utf8") > maxPluginNameBytes) throw new Error(`README loader plugin name must be at most ${maxPluginNameBytes} UTF-8 bytes`);
    if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(name)) throw new Error("README loader plugin name cannot contain Unicode control characters");
    if (name.startsWith("cordis:")) continue;
    plugins.add(name);
    if (plugins.size > maxPlugins) throw new Error(`README loader must contain at most ${maxPlugins} unique runtime plugins`);
  }
  return [...plugins].sort();
}

export function renderReadme(metadata: ReadmeMetadata): string {
  const { name, version, description, scripts, plugins } = metadata;
  return [
    `# ${plainMarkdown(name)}`,
    "",
    plainMarkdown(description),
    "",
    `Version: ${plainMarkdown(version)}`,
    "",
    "## Scripts",
    "",
    ...(scripts.length ? scripts.map((script) => `- ${codeSpan(`npm run ${script}`)}`) : ["- No npm scripts declared."]),
    "",
    "## Runtime plugins",
    "",
    ...(plugins.length ? plugins.map((plugin) => `- ${codeSpan(plugin)}`) : ["- No runtime plugins reported."]),
    "",
  ].join("\n");
}

async function generate(context: Context, signal: AbortSignal): Promise<ReadmeReport> {
  throwIfCancelled(signal);
  const path = join(context.piHarnessLaunch.cwd, "package.json");
  let source: string;
  try {
    source = await readBoundedTextFile(path, maxManifestBytes, "package.json");
  } catch (error) {
    if (error instanceof BoundedFileSizeError) throw new Error("package.json exceeds the 1 MiB limit", { cause: error });
    if (error instanceof BoundedFileTypeError) throw new Error("package.json must be a regular file and cannot be a symbolic link", { cause: error });
    throw new Error("Could not read package.json", { cause: error });
  }
  throwIfCancelled(signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("Invalid package.json", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("package.json root must be an object");
  const packageJson = parsed as Record<string, unknown>;
  const { name, version, description, scripts } = manifestMetadata(packageJson);
  const plugins = loaderPluginNames(context.get("loader"));
  throwIfCancelled(signal);
  const metadata = { name, version, description, scripts, plugins };
  return { ...metadata, markdown: renderReadme(metadata) };
}

function outputPath(root: string, requested: string): string {
  if (requested === "") throw new Error("README output path must be a non-empty relative POSIX path");
  if (requested !== requested.trim()) throw new Error("README output path must not have leading or trailing whitespace");
  if ([...requested].length > maxOutputPathLength) throw new Error(`README output path must be at most ${maxOutputPathLength} characters`);
  if (Buffer.byteLength(requested, "utf8") > maxOutputPathLength) throw new Error(`README output path must be at most ${maxOutputPathLength} UTF-8 bytes`);
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(requested)) throw new Error("README output path cannot contain Unicode control characters");
  if (requested.includes("\\") || isAbsolute(requested) || /^[A-Za-z]:[\\/]/u.test(requested) || /^[/\\]{2}/u.test(requested))
    throw new Error("README output path must be a relative POSIX path");
  const segments = requested.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment !== segment.trim()))
    throw new Error("README output path contains unsafe path segments and must stay inside the workspace");
  if (!/^README(?:[._-][^/]*)?\.md$/iu.test(basename(requested))) throw new Error("README output path must name a README Markdown file");
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, requested);
  const remainder = relative(resolvedRoot, target);
  if (remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) throw new Error("README output path must stay inside the workspace");
  return target;
}

async function ensureSafeParent(workspace: string, parent: string): Promise<void> {
  const remainder = relative(workspace, parent);
  const segments = remainder === "" ? [] : remainder.split(sep);
  let current = workspace;
  for (const segment of segments) {
    current = join(current, segment);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink()) throw new Error("README output parent cannot be a symbolic link");
    if (!metadata.isDirectory()) throw new Error("README output parent must be a directory");
  }
  const canonicalParent = await realpath(parent);
  const parentRemainder = relative(workspace, canonicalParent);
  if (parentRemainder === ".." || parentRemainder.startsWith(`..${sep}`) || isAbsolute(parentRemainder))
    throw new Error("README output path must stay inside the workspace");
}

async function writeReadmeFileInternal(
  root: string,
  markdown: string,
  requestedPath: string,
  confirm: boolean,
  overwrite = false,
  signal?: AbortSignal,
): Promise<ReadmeWriteReport> {
  if (signal !== undefined) throwIfCancelled(signal);
  if (!confirm) throw new Error("Writing a README requires confirm=true");
  const workspace = await realpath(resolve(root));
  if (signal !== undefined) throwIfCancelled(signal);
  const target = outputPath(workspace, requestedPath);
  const parent = dirname(target);
  await ensureSafeParent(workspace, parent);
  if (signal !== undefined) throwIfCancelled(signal);
  let overwritten = false;
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("README output path must be a regular file and cannot be a symbolic link");
    if (!overwrite) throw new Error("Overwriting an existing README requires overwrite=true");
    overwritten = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (signal !== undefined) throwIfCancelled(signal);
  try {
    // No explicit mode: a README is a committed project file, so regenerating it keeps the bits it already has and only a README this creates falls back to the owner-only default.
    await atomicWriteFile(target, markdown, {
      encoding: "utf8",
      overwrite,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (!overwrite && (error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Overwriting an existing README requires overwrite=true", { cause: error });
    throw error;
  }
  return { path: relative(workspace, target), bytes: Buffer.byteLength(markdown, "utf8"), overwritten };
}

export async function writeReadmeFile(
  root: string,
  markdown: string,
  requestedPath: string,
  confirm: boolean,
  overwrite = false,
  signal?: AbortSignal,
): Promise<ReadmeWriteReport> {
  try {
    return await writeReadmeFileInternal(root, markdown, requestedPath, confirm, overwrite, signal);
  } catch (error) {
    if (signal?.aborted === true) throwIfCancelled(signal);
    if (errnoCode(error) !== undefined) throw new Error("Could not write README inside the workspace", { cause: error });
    throw error;
  }
}

export default {
  name: "pi-readme-gen",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: ReadmeGenConfig) {
    assertReadmeGenConfig(config);
    let latest: ReadmeReport | undefined;
    let lastWrite: ReadmeWriteReport | undefined;
    let status: ReadmeStatus = { state: "idle" };
    const lifecycle = new AbortController();
    let unregisterTool: () => void = () => undefined;
    let unregisterWrite: () => void = () => undefined;
    let disposePanel: () => void = () => undefined;
    try {
      unregisterTool = context.piTools.register(
        defineTool({
          name: "readme_report",
          label: "README report",
          description: "Generate a Markdown project overview from the local package manifest and active Pi runtime plugins.",
          promptSnippet: "generate a project README overview",
          parameters: Type.Object({}, { additionalProperties: false }),
          executionMode: "sequential",
          async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<ReadmeReport>> {
            reportParameters(rawParams);
            const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            status = { state: "running", operation: "report" };
            try {
              const report = await generate(context, operationSignal);
              latest = structuredClone(report);
              status = { state: "completed", operation: "report", at: new Date().toISOString() };
              return { content: [{ type: "text", text: report.markdown }], details: structuredClone(report) };
            } catch (error) {
              status = {
                state: operationSignal.aborted ? "cancelled" : "failed",
                operation: "report",
                at: new Date().toISOString(),
                error: boundedError(error),
              };
              throw error;
            }
          },
        }),
      );
      unregisterWrite = context.piTools.register(
        defineTool({
          name: "readme_write",
          label: "Write README",
          description: "Write the generated Markdown to a workspace file only after explicit confirmation; defaults to README.generated.md.",
          promptSnippet: "write the generated README to a confirmed workspace path",
          parameters: Type.Object(
            {
              outputPath: Type.Optional(Type.String({ minLength: 1, maxLength: maxOutputPathLength })),
              confirm: Type.Boolean(),
              overwrite: Type.Optional(Type.Boolean()),
            },
            { additionalProperties: false },
          ),
          executionMode: "sequential",
          async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<ReadmeWriteReport>> {
            const params = writeParameters(rawParams);
            const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            status = { state: "running", operation: "write" };
            try {
              throwIfCancelled(operationSignal);
              if (!params.confirm) throw new Error("Writing a README requires confirm=true");
              const report = await generate(context, operationSignal);
              const write = await writeReadmeFile(
                context.piHarnessLaunch.cwd,
                report.markdown,
                params.outputPath,
                params.confirm,
                params.overwrite,
                operationSignal,
              );
              latest = structuredClone(report);
              lastWrite = { ...write };
              status = { state: "completed", operation: "write", at: new Date().toISOString() };
              return {
                content: [{ type: "text", text: `README written: ${write.path} (${write.bytes} bytes)` }],
                details: { ...write },
              };
            } catch (error) {
              status = {
                state: operationSignal.aborted ? "cancelled" : "failed",
                operation: "write",
                at: new Date().toISOString(),
                error: boundedError(error),
              };
              throw error;
            }
          },
        }),
      );
      disposePanel = context.piPluginUi.register({
        id: "readme-gen-panel",
        pluginId: "@pi-harness/core/plugins/readme-gen",
        title: "README Generator",
        description: "从当前项目清单生成 Markdown 概览；写入文件需要显式确认，默认不会覆盖 README。",
        icon: "▰",
        read: () =>
          latest === undefined
            ? { generated: false, lastWrite: lastWrite === undefined ? null : { ...lastWrite }, status: structuredClone(status) }
            : {
                generated: true,
                name: latest.name,
                scripts: latest.scripts.length,
                plugins: latest.plugins.length,
                lastWrite: lastWrite === undefined ? null : { ...lastWrite },
                status: structuredClone(status),
              },
      });
    } catch (error) {
      disposePanel();
      unregisterWrite();
      unregisterTool();
      lifecycle.abort(new Error("README generator registration failed"));
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("README generator plugin was disposed"));
      unregisterTool();
      unregisterWrite();
      disposePanel();
    });
  },
};
