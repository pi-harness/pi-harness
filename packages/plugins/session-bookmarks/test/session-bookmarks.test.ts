import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import { listSessionBookmarks, normalizeBookmarkLabel } from "../src/index.js";
import sessionBookmarksPlugin from "../src/index.js";

describe("session bookmarks", () => {
  test("trims labels and rejects empty or oversized values", () => {
    expect(normalizeBookmarkLabel("  release candidate  ")).toBe("release candidate");
    expect(() => normalizeBookmarkLabel(" ")).toThrow("Bookmark label must contain 1-120 characters");
    expect(() => normalizeBookmarkLabel("x".repeat(121))).toThrow("Bookmark label must contain 1-120 characters");
  });

  test("resolves the latest native labels and ignores cleared entries", () => {
    expect(
      listSessionBookmarks([
        { type: "message", id: "entry-1" },
        { type: "label", id: "label-1", targetId: "entry-1", label: "old" },
        { type: "label", id: "label-2", targetId: "entry-1", label: "release" },
        { type: "label", id: "label-3", targetId: "entry-1", label: undefined },
      ]),
    ).toEqual([]);
  });

  test("adds, lists, and removes bookmarks through the native session manager", async () => {
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    const entries: Array<Record<string, unknown>> = [{ type: "message", id: "entry-7" }];
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    context.provide("piSession", {
      manager: {
        getEntries: () => entries,
        appendLabelChange: (entryId: string, label: string | undefined) => {
          if (!entries.some((entry) => entry.id === entryId)) throw new Error(`Entry ${entryId} not found`);
          const labelId = `label-${entries.length + 1}`;
          entries.push({ type: "label", id: labelId, targetId: entryId, label });
          return labelId;
        },
      },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(sessionBookmarksPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_bookmarks");
      expect(tool).toBeDefined();
      const added = await tool!.execute("call-1", { action: "add", label: "Release candidate", entryId: "entry-7" }, undefined, undefined, {} as never);
      expect(added.details).toMatchObject({ bookmarks: [{ entryId: "entry-7", label: "Release candidate" }] });
      const bookmarkId = (added.details as { bookmarks: Array<{ id: string }> }).bookmarks[0]!.id;
      await expect(tool!.execute("call-2", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { bookmarks: [{ id: bookmarkId, label: "Release candidate" }] },
      });
      await expect(tool!.execute("call-3", { action: "remove", bookmarkId }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { bookmarks: [] },
      });
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "session-bookmarks-panel", data: { bookmarks: [], total: 0 } }]);
    } finally {
      await context.fiber.dispose();
    }
  });
});
