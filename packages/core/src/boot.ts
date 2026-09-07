import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Context, type FiberState } from "@deepseek-ai/cordis";
import Group from "@deepseek-ai/cordis-plugin-group";
import Include from "@deepseek-ai/cordis-plugin-include";
import Loader, { type EntryOptions } from "@deepseek-ai/cordis-plugin-loader";
import HardenedTimerService from "./cordis-timer.js";
import { resolvePluginEntry } from "./plugin-resolve.js";

const maxLoaderEntries = 512;
const maxLoaderGroupDepth = 16;
const maxLoaderEntryIdLength = 128;
const maxLoaderPluginNameLength = 512;
const consoleLoggerPackageName = "@deepseek-ai/cordis-plugin-logger-console";
const consoleLoggerEntryUrl = import.meta.resolve(consoleLoggerPackageName);
const timerPackageName = "@deepseek-ai/cordis-plugin-timer";
const timerEntryUrl = import.meta.resolve(timerPackageName);
const consoleLoggerConfigKeys = new Set(["colors", "label", "levels", "maxLength", "showDiff", "showTime"]);
const consoleLoggerLabelKeys = new Set(["align", "margin", "width"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function consoleLoggerConfigError(detail: string): never {
  throw new Error(`Console logger config ${detail}`);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function normalizeConsoleLoggerConfig(entry: Record<string, unknown>): void {
  if (entry.name !== consoleLoggerPackageName && entry.name !== consoleLoggerEntryUrl) return;
  const config = entry.config ?? {};
  if (!isRecord(config)) consoleLoggerConfigError("must be an object");
  const unknownKey = Object.keys(config).find((key) => !consoleLoggerConfigKeys.has(key));
  if (unknownKey !== undefined) consoleLoggerConfigError(`contains unknown option "${unknownKey}"`);
  if (config.colors !== undefined && config.colors !== false && !boundedInteger(config.colors, 0, 3))
    consoleLoggerConfigError("colors must be false or an integer from 0 to 3");
  if (config.maxLength !== undefined && !boundedInteger(config.maxLength, 1, 65_536)) consoleLoggerConfigError("maxLength must be an integer from 1 to 65536");
  if (config.showDiff !== undefined && typeof config.showDiff !== "boolean") consoleLoggerConfigError("showDiff must be a boolean");
  if (config.showTime !== undefined && (typeof config.showTime !== "string" || config.showTime.length > 64))
    consoleLoggerConfigError("showTime must be a string of at most 64 characters");

  const levels: Record<string, number> = {};
  if (config.levels !== undefined) {
    if (!isRecord(config.levels)) consoleLoggerConfigError("levels must be an object");
    const entries = Object.entries(config.levels);
    if (entries.length > 64) consoleLoggerConfigError("levels must contain at most 64 logger names");
    for (const [name, level] of entries) {
      if (name.trim().length === 0 || name.length > 128) consoleLoggerConfigError("level names must contain 1 to 128 non-whitespace characters");
      if (!boundedInteger(level, 0, 3)) consoleLoggerConfigError(`level for "${name}" must be an integer from 0 to 3`);
      levels[name] = level;
    }
  }
  if (!Object.hasOwn(levels, "default")) levels.default = 2;

  let label: Record<string, unknown> | undefined;
  if (config.label !== undefined) {
    if (!isRecord(config.label)) consoleLoggerConfigError("label must be an object");
    const unknownLabelKey = Object.keys(config.label).find((key) => !consoleLoggerLabelKeys.has(key));
    if (unknownLabelKey !== undefined) consoleLoggerConfigError(`label contains unknown option "${unknownLabelKey}"`);
    if (config.label.width !== undefined && !boundedInteger(config.label.width, 0, 256))
      consoleLoggerConfigError("label.width must be an integer from 0 to 256");
    if (config.label.margin !== undefined && !boundedInteger(config.label.margin, 0, 32))
      consoleLoggerConfigError("label.margin must be an integer from 0 to 32");
    if (config.label.align !== undefined && config.label.align !== "left" && config.label.align !== "right")
      consoleLoggerConfigError('label.align must be "left" or "right"');
    label = { ...config.label };
  }

  entry.config = { ...config, levels, ...(label === undefined ? {} : { label }) };
}

function hardenLoggerService(context: Context): void {
  const logger = context.logger;
  const bufferExporter = logger.exporters.values().next().value;
  if (bufferExporter !== undefined) bufferExporter.levels = { ...bufferExporter.levels, default: 3 };
  logger.exporter = function registerExporter(this: typeof logger, exporter) {
    return this.ctx.effect(() => {
      const id = ++this._snExporter;
      this.exporters.set(id, exporter);
      return () => this.exporters.delete(id);
    }, "ctx.logger.exporter()");
  };
}

function isTimerSpecifier(name: string): boolean {
  return name === timerPackageName || name === timerEntryUrl;
}

function assertValidEntryTree(entries: unknown): asserts entries is EntryOptions[] {
  if (!Array.isArray(entries)) throw new Error("Loader profile root must be an array");
  const ids = new Map<string, string>();
  const visited = new WeakSet<object>();
  const stack: Array<{ entries: unknown[]; depth: number }> = [{ entries, depth: 0 }];
  let total = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.entries)) throw new Error("Loader group config must not be cyclic or reused");
    visited.add(current.entries);
    for (const value of current.entries) {
      total += 1;
      if (total > maxLoaderEntries) throw new Error(`Loader profile exceeds the ${maxLoaderEntries}-entry limit`);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Loader entry must be an object");
      const entry = value as Record<string, unknown>;
      if (typeof entry.name !== "string" || entry.name.trim().length === 0 || entry.name.length > maxLoaderPluginNameLength)
        throw new Error(`Loader plugin name must be a non-empty string of at most ${maxLoaderPluginNameLength} characters`);
      normalizeConsoleLoggerConfig(entry);
      if (entry.id !== undefined) {
        if (typeof entry.id !== "string" || entry.id.trim().length === 0 || entry.id.length > maxLoaderEntryIdLength || entry.id.includes(":"))
          throw new Error(`Loader entry id must be a non-empty string of at most ${maxLoaderEntryIdLength} characters without ':'`);
        const previous = ids.get(entry.id);
        if (previous !== undefined)
          throw new Error(
            `Duplicate loader entry id "${entry.id}" is used by both ${previous} and ${entry.name}; ids must be unique across the whole profile because nested groups share their tree's entry store`,
          );
        ids.set(entry.id, entry.name);
      }
      if (entry.group !== undefined && entry.group !== null && typeof entry.group !== "boolean") throw new Error("Loader entry group must be a boolean");
      if (entry.group === true) {
        if (!Array.isArray(entry.config)) throw new Error("Loader group config must be an array");
        if (current.depth >= maxLoaderGroupDepth) throw new Error(`Loader profile exceeds the ${maxLoaderGroupDepth}-level nesting limit`);
        stack.push({ entries: entry.config, depth: current.depth + 1 });
      }
    }
  }
}

class ReadonlyInclude extends Include {
  constructor(ctx: Context, config: Include.Config) {
    super(ctx, config);
    const update = this.root.update.bind(this.root);
    this.root.update = async (entries: EntryOptions[]) => {
      assertValidEntryTree(entries);
      await update(entries);
    };
  }

  override write(): void {}

  override import(name: string, getOuterStack?: () => string[]): unknown {
    if (isTimerSpecifier(name)) return HardenedTimerService;
    if (this.ctx.loader.internal !== undefined || name.startsWith("cordis:") || name.startsWith(".") || name.startsWith("/") || name.includes("://"))
      return super.import(name, getOuterStack);
    let resolved: string | undefined;
    try {
      resolved = createRequire(this.filename).resolve(name);
    } catch {
      // The CJS resolver reports a package whose "exports" declares no "require" condition as not exported, which is every ESM-only plugin, so a marketplace package installed beside the profile has to be located under the import conditions instead of being handed straight to the loader.
      resolved = resolvePluginEntry(this.filename, name);
    }
    if (resolved === undefined) return super.import(name, getOuterStack);
    return super.import(pathToFileURL(resolved).href, getOuterStack);
  }
}

export interface BootHarnessOptions {
  configPath: string;
  prepare?: (context: Context) => Promise<void> | void;
  onFullReload?: () => void;
  signal?: AbortSignal;
}

export interface BootedHarness {
  readonly context: Context;
  dispose(): Promise<void>;
}

const FIBER_PENDING = 0 as FiberState.PENDING;
const FIBER_ACTIVE = 2 as FiberState.ACTIVE;
const FIBER_FAILED = 3 as FiberState.FAILED;

function formatError(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(formatError).join("\n");
  if (!(error instanceof Error)) return String(error);
  const own = error.stack ?? error.message;
  return error.cause === undefined ? own : `${own}\ncaused by: ${formatError(error.cause)}`;
}

async function assertEntriesActivated(context: Context): Promise<void> {
  const loader = context.get("loader");
  if (loader === undefined) throw new Error("Cordis Loader was disposed during startup");
  const failures: string[] = [];
  for (const entry of loader.entries()) {
    if (entry.disabled) continue;
    const fiber = entry.fiber;
    if (fiber === undefined) {
      failures.push(`${entry.options.name}: module did not load`);
      continue;
    }
    if (fiber.state === FIBER_ACTIVE) continue;
    if (fiber.state === FIBER_FAILED) {
      try {
        await fiber.await();
      } catch (error) {
        failures.push(`${entry.options.name}: ${formatError(error)}`);
      }
      continue;
    }
    if (fiber.state === FIBER_PENDING) {
      const missing = Object.keys(fiber.inject).filter((service) => fiber.ctx.get(service) === undefined);
      failures.push(`${entry.options.name}: pending (waiting for services: ${missing.join(", ") || "unknown"})`);
      continue;
    }
    failures.push(`${entry.options.name}: fiber state ${String(fiber.state)}`);
  }
  if (failures.length > 0) throw new Error(`Cordis plugin tree did not activate:\n${failures.join("\n")}`);
}

async function mountProfile(context: Context, configPath: string): Promise<void> {
  context.loader.builtins.include = ReadonlyInclude;
  context.loader.builtins.group = Group;
  const root: EntryOptions = {
    id: "profile",
    name: "cordis:include",
    config: { path: pathToFileURL(configPath).href },
  };
  await context.loader.create(root);
}

export async function bootHarness(options: BootHarnessOptions): Promise<BootedHarness> {
  const configPath = resolve(options.configPath);
  const context = new Context();
  hardenLoggerService(context);
  const abort = () => {
    void context.fiber.dispose().catch(() => {});
  };
  if (options.signal?.aborted) throw new Error("Pi Harness startup was aborted", { cause: options.signal.reason });
  options.signal?.addEventListener("abort", abort, { once: true });
  let stage = "host preparation";
  try {
    context.baseUrl = `${pathToFileURL(dirname(configPath)).href}/`;
    await context.plugin(Loader);
    const loadPlugin = context.loader.import.bind(context.loader);
    context.loader.import = (name, getOuterStack) => (isTimerSpecifier(name) ? HardenedTimerService : (loadPlugin(name, getOuterStack) as unknown));
    if (options.onFullReload !== undefined) context.loader.exit = options.onFullReload;
    await options.prepare?.(context);
    stage = "plugin tree activation";
    await mountProfile(context, configPath);
    await context.get("loader")?.await();
    await assertEntriesActivated(context);
    if (options.signal?.aborted === true) throw new Error("Pi Harness startup was aborted", { cause: options.signal.reason });
  } catch (cause) {
    await context.fiber.dispose();
    throw new Error(`Pi Harness ${stage} failed: ${formatError(cause)}`, { cause });
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
  return {
    context,
    async dispose() {
      await context.fiber.dispose();
    },
  };
}
