import { createRequire } from "node:module";
import { gt, satisfies, valid } from "semver";

const require = createRequire(import.meta.url);
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/@pi-harness%2Fcore/latest";
const DEFAULT_TIMEOUT_MS = 1_500;

export interface CoreUpdateInfo {
  readonly currentVersion: string;
  readonly latestVersion: string;
}

export interface CoreUpdateOptions {
  readonly registryUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function installedCoreVersion(): string | undefined {
  try {
    const metadata = require("@pi-harness/core/package.json") as { version?: unknown };
    return typeof metadata.version === "string" && valid(metadata.version) !== null ? metadata.version : undefined;
  } catch {
    return undefined;
  }
}

export async function checkCoreUpdate(currentVersion: string, options: CoreUpdateOptions = {}): Promise<CoreUpdateInfo | undefined> {
  if (valid(currentVersion) === null) return undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(options.registryUrl ?? DEFAULT_REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== "object" || !("version" in payload) || typeof payload.version !== "string") return undefined;
    const latestVersion = payload.version;
    if (valid(latestVersion) === null || !gt(latestVersion, currentVersion) || !satisfies(latestVersion, `^${currentVersion}`)) return undefined;
    return { currentVersion, latestVersion };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function formatCoreUpdateNotice(info: CoreUpdateInfo): string {
  return `Pi Harness update available: @pi-harness/core ${info.currentVersion} → ${info.latestVersion}. Run \`npm update --global @pi-harness/pi-harness\` to install it.\n`;
}

export async function coreUpdateNotice(options: CoreUpdateOptions = {}): Promise<string | undefined> {
  const currentVersion = installedCoreVersion();
  if (currentVersion === undefined) return undefined;
  const update = await checkCoreUpdate(currentVersion, options);
  return update === undefined ? undefined : formatCoreUpdateNotice(update);
}
