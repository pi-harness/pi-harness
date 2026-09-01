import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Context, type FiberState } from "@deepseek-ai/cordis";
import Group from "@deepseek-ai/cordis-plugin-group";
import Include from "@deepseek-ai/cordis-plugin-include";
import Loader, { type EntryOptions } from "@deepseek-ai/cordis-plugin-loader";

class ReadonlyInclude extends Include {
  override write(): void {}
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
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
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
