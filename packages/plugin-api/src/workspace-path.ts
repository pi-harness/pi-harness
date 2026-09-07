import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface WorkspacePath {
  readonly root: string;
  readonly target: string;
  readonly relativePath: string;
}

export interface WorkspaceFilePath extends WorkspacePath {
  readonly exists: boolean;
}

export function isPathInside(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function assertInside(root: string, target: string, message: string): void {
  if (!isPathInside(root, target)) throw new Error(message);
}

export async function resolveExistingWorkspacePath(root: string, requested: string, message: string): Promise<WorkspacePath> {
  const canonicalRoot = await realpath(resolve(root));
  const lexicalTarget = resolve(canonicalRoot, requested);
  assertInside(canonicalRoot, lexicalTarget, message);
  const target = await realpath(lexicalTarget);
  assertInside(canonicalRoot, target, message);
  return { root: canonicalRoot, target, relativePath: relative(canonicalRoot, target) || "." };
}

export async function resolveWorkspaceFilePath(root: string, requested: string, message: string): Promise<WorkspacePath> {
  const canonicalRoot = await realpath(resolve(root));
  const lexicalTarget = resolve(canonicalRoot, requested);
  assertInside(canonicalRoot, lexicalTarget, message);
  const canonicalParent = await realpath(dirname(lexicalTarget));
  assertInside(canonicalRoot, canonicalParent, message);
  const target = join(canonicalParent, basename(lexicalTarget));
  return { root: canonicalRoot, target, relativePath: relative(canonicalRoot, target) || "." };
}

export async function prepareWorkspaceFile(root: string, requested: string, message: string): Promise<WorkspaceFilePath> {
  const canonicalRoot = await realpath(resolve(root));
  const lexicalTarget = resolve(canonicalRoot, requested);
  assertInside(canonicalRoot, lexicalTarget, message);

  let ancestor = dirname(lexicalTarget);
  const missing: string[] = [];
  let canonicalAncestor: string;
  for (;;) {
    try {
      canonicalAncestor = await realpath(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  assertInside(canonicalRoot, canonicalAncestor, message);
  if (!(await stat(canonicalAncestor)).isDirectory()) throw new Error(message);

  const parent = join(canonicalAncestor, ...missing);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  assertInside(canonicalRoot, canonicalParent, message);
  const target = join(canonicalParent, basename(lexicalTarget));
  let exists = false;
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(message);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { root: canonicalRoot, target, relativePath: relative(canonicalRoot, target), exists };
}
