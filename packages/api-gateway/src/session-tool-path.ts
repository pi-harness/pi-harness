import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu;

function normalizeWindowsShellPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
  const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu);
  if (!match) return path;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]?.toUpperCase()}:\\${suffix ?? ""}`;
}

// Mirrors @earendil-works/pi-coding-agent@0.85.1 core/tools/path-utils.js resolveToCwd/normalizePath so replayed successful tool paths identify the same file the built-in tool mutated.
export function normalizeSessionToolPath(input: string, platform: NodeJS.Platform = process.platform, home: string = homedir()): string | undefined {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (platform === "win32") normalized = normalizeWindowsShellPath(normalized);
  const path = platform === "win32" ? win32 : posix;
  if (normalized === "~") normalized = home;
  else if (normalized.startsWith("~/") || (platform === "win32" && normalized.startsWith("~\\"))) normalized = path.join(home, normalized.slice(2));
  try {
    return /^file:\/\//u.test(normalized) ? fileURLToPath(normalized, { windows: platform === "win32" }) : normalized;
  } catch {
    return undefined;
  }
}

export function resolveSessionToolPath(root: string, input: string): string | undefined {
  const normalized = normalizeSessionToolPath(input);
  return normalized === undefined ? undefined : resolve(root, normalized);
}
