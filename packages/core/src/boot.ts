import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Context, type FiberState } from "@deepseek-ai/cordis";
import Group from "@deepseek-ai/cordis-plugin-group";
import Include from "@deepseek-ai/cordis-plugin-include";
import Loader, { type EntryOptions } from "@deepseek-ai/cordis-plugin-loader";

function assertUniqueEntryIds(entries: readonly EntryOptions[], seen = new Map<string, string>()): void {
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.id.length > 0) {
      const previous = seen.get(entry.id);
      if (previous !== undefined) throw new Error(`Duplicate loader entry id "${entry.id}" is used by both ${previous} and ${entry.name}; ids must be unique across the whole profile because nested groups share their tree's entry store`);
      seen.set(entry.id, entry.name);
    }
    if (entry.group === true && Array.isArray(entry.config)) assertUniqueEntryIds(entry.config as EntryOptions[], seen);
  }
}

class ReadonlyInclude extends Include {
  constructor(ctx: Context, config: Include.Config) {
    super(ctx, config);
    const update = this.root.update.bind(this.root);
    this.root.update = async (entries: EntryOptions[]) => {
      assertUniqueEntryIds(entries);
      await update(entries);
    };
  }

  override write(): void {}

  override import(name: string, getOuterStack?: () => string[]): unknown {
    if (this.ctx.loader.internal !== undefined || name.startsWith("cordis:") || name.startsWith(".") || name.startsWith("/") || name.includes("://")) return super.import(name, getOuterStack);
    let resolved: string;
    try {
      resolved = createRequire(this.filename).resolve(name);
    } catch {
      return super.import(name, getOuterStack);
    }
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
  return error instanceof Error ? error.stack ?? error.message : String(error);
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
  const abort = () => {
    void context.fiber.dispose().catch(() => {});
  };
  if (options.signal?.aborted) throw new Error("Pi Harness startup was aborted", { cause: options.signal.reason });
  options.signal?.addEventListener("abort", abort, { once: true });
  let stage = "host preparation";
  try {
    context.baseUrl = `${pathToFileURL(dirname(configPath)).href}/`;
    await context.plugin(Loader);
    if (options.onFullReload !== undefined) context.loader.exit = options.onFullReload;
    await options.prepare?.(context);
    stage = "plugin tree activation";
    await mountProfile(context, configPath);
    await context.get("loader")?.await();
    if (context.get("loader") !== undefined) await assertEntriesActivated(context);
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
