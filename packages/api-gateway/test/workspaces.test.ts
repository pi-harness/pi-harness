import { describe, expect, test } from "vitest";
import { parseGitWorktrees } from "../src/workspaces.js";

describe("git workspace parsing", () => {
  test("parses worktree paths and branch names", () => {
    expect(
      parseGitWorktrees("worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def\nbranch refs/heads/feature/test\n", "/repo"),
    ).toEqual([
      { path: "/repo", branch: "main", current: true, name: "repo" },
      { path: "/repo-feature", branch: "feature/test", current: false, name: "repo-feature" },
    ]);
  });
});
