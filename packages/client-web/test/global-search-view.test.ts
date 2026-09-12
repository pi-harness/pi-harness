import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

test("gives the global search result list an accessible name", async () => {
  const module = (await import("../src/react-room.js")) as unknown as {
    GlobalSearch?: (props: Record<string, unknown>) => ReturnType<typeof createElement>;
  };

  expect(module.GlobalSearch).toBeTypeOf("function");
  if (!module.GlobalSearch) return;
  const html = renderToStaticMarkup(
    createElement(module.GlobalSearch, {
      commands: [],
      sessions: [],
      files: [],
      onClose: () => {},
      onUse: () => {},
      onOpenSession: () => {},
      onOpenFile: () => {},
    }),
  );

  expect(html).toContain('id="global-search-results"');
  expect(html).toContain('aria-label="全局搜索结果"');
});

test("keeps the active search result visible while keyboard focus stays on the combobox", async () => {
  const module = (await import("../src/react-room.js")) as unknown as {
    scrollActiveOptionIntoView?: (option: Pick<HTMLElement, "scrollIntoView"> | null) => void;
  };
  let received: boolean | ScrollIntoViewOptions | undefined;
  const option = {
    scrollIntoView: (options?: boolean | ScrollIntoViewOptions) => {
      received = options;
    },
  };

  expect(module.scrollActiveOptionIntoView).toBeTypeOf("function");
  if (!module.scrollActiveOptionIntoView) return;
  module.scrollActiveOptionIntoView(option);

  expect(received).toEqual({ block: "nearest" });
});

test("merges the workspace catalogue with live Git changes for file discovery", async () => {
  const module = (await import("../src/react-room.js")) as unknown as {
    mergeSearchableFiles?: (
      workspace: readonly Record<string, string>[],
      changed: readonly Record<string, string>[],
    ) => readonly Record<string, string>[];
  };

  expect(module.mergeSearchableFiles).toBeTypeOf("function");
  if (!module.mergeSearchableFiles) return;
  expect(
    module.mergeSearchableFiles(
      [
        { path: "deleted.ts", status: "", label: "workspace" },
        { path: "src/app.ts", status: "", label: "workspace" },
      ],
      [
        { path: "deleted.ts", status: "D", label: "deleted" },
        { path: "src/app.ts", status: "M", label: "modified" },
        { path: "src/new.ts", status: "??", label: "untracked" },
      ],
    ),
  ).toEqual([
    { path: "src/app.ts", status: "M", label: "modified" },
    { path: "src/new.ts", status: "??", label: "untracked" },
  ]);
});

test("presents a clean workspace file by its path in global search", async () => {
  const module = (await import("../src/react-room.js")) as unknown as {
    GlobalSearch: (props: Record<string, unknown>) => ReturnType<typeof createElement>;
    fileDetailSource?: (file: Record<string, string>) => string;
  };
  const html = renderToStaticMarkup(
    createElement(module.GlobalSearch, {
      commands: [],
      sessions: [],
      files: [{ path: "README.md", status: "", label: "workspace" }],
      filesTruncated: true,
      onClose: () => {},
      onUse: () => {},
      onOpenSession: () => {},
      onOpenFile: () => {},
    }),
  );

  expect(html).toContain("<strong>README.md</strong>");
  expect(html).toContain("文件索引已截断，搜索结果可能不完整。");
  expect(module.fileDetailSource).toBeTypeOf("function");
  expect(module.fileDetailSource?.({ path: "README.md", status: "", label: "workspace" })).toBe("/api/workspace/files");
  expect(module.fileDetailSource?.({ path: "src/app.ts", status: "M", label: "modified" })).toBe("/api/files");
});

test("distinguishes a forked session from its identically named source", async () => {
  const module = (await import("../src/react-room.js")) as unknown as {
    GlobalSearch: (props: Record<string, unknown>) => ReturnType<typeof createElement>;
  };
  const html = renderToStaticMarkup(
    createElement(module.GlobalSearch, {
      commands: [],
      sessions: [
        { sessionId: "source", name: "Launch roadmap", messageCount: 2 },
        { sessionId: "fork", name: "Launch roadmap", messageCount: 2, forked: true },
      ],
      files: [],
      onClose: () => {},
      onUse: () => {},
      onOpenSession: () => {},
      onOpenFile: () => {},
    }),
  );

  expect(html.match(/<strong>Launch roadmap<\/strong>/gu)).toHaveLength(2);
  expect(html.match(/副本/gu)).toHaveLength(1);
});
