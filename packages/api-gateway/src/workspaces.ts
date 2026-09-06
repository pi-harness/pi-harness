import { basename, resolve } from "node:path";

export interface WorkspaceSummary {
  readonly path: string;
  readonly branch: string;
  readonly current: boolean;
  readonly name: string;
}

export function parseGitWorktrees(output: string, cwd: string): readonly WorkspaceSummary[] {
  const items: WorkspaceSummary[] = [];
  for (const block of output.trim().split(/\n\s*\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1]?.trim();
    if (!path) continue;
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]?.trim() ?? "detached";
    const resolvedPath = resolve(path);
    items.push({ path: resolvedPath, branch, current: resolvedPath === resolve(cwd), name: basename(resolvedPath) || resolvedPath });
  }
  return items;
}
