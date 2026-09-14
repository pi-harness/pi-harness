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
    mergeSearchableFiles?: (workspace: readonly Record<string, string>[], changed: readonly Record<string, string>[]) => readonly Record<string, string>[];
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
    fileDetailSource?: () => string;
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
  expect(module.fileDetailSource?.()).toBe("/api/workspace/file");
});

test("loads source content into file details and ignores a stale response", async () => {
  const module = (await import("../src/react-room.js")) as unknown as {
    loadWorkspaceFileDetail?: (
      api: { getWorkspaceFile(path: string): Promise<{ path: string; content: string }> },
      file: Record<string, string>,
      isCurrent: () => boolean,
      apply: (detail: Record<string, unknown>) => void,
    ) => Promise<void>;
  };
  expect(module.loadWorkspaceFileDetail).toBeTypeOf("function");
  if (!module.loadWorkspaceFileDetail) return;

  let resolvePreview: ((value: { path: string; content: string }) => void) | undefined;
  const preview = new Promise<{ path: string; content: string }>((resolve) => {
    resolvePreview = resolve;
  });
  const details: Record<string, unknown>[] = [];
  let current = true;
  const loading = module.loadWorkspaceFileDetail(
    { getWorkspaceFile: () => preview },
    { path: "src/main.tsx", status: "", label: "workspace" },
    () => current,
    (detail) => details.push(detail),
  );
  expect(details).toEqual([{ type: "file", path: "src/main.tsx", status: "", source: "/api/workspace/file", output: "正在加载文件…" }]);
  current = false;
  resolvePreview?.({ path: "src/main.tsx", content: "const product = 'RelayOps';\n" });
  await loading;
  expect(details).toHaveLength(1);

  current = true;
  await module.loadWorkspaceFileDetail(
    { getWorkspaceFile: () => Promise.resolve({ path: "src/main.tsx", content: "const product = 'RelayOps';\n" }) },
    { path: "src/main.tsx", status: "", label: "workspace" },
    () => current,
    (detail) => details.push(detail),
  );
  expect(details.at(-1)).toEqual({
    type: "file",
    path: "src/main.tsx",
    status: "",
    source: "/api/workspace/file",
    output: "const product = 'RelayOps';\n",
  });
});

test("shows a workspace file preview failure in the details output", async () => {
  const module = (await import("../src/react-room.js")) as unknown as {
    loadWorkspaceFileDetail?: (
      api: { getWorkspaceFile(path: string): Promise<{ path: string; content: string }> },
      file: Record<string, string>,
      isCurrent: () => boolean,
      apply: (detail: Record<string, unknown>) => void,
    ) => Promise<void>;
  };
  expect(module.loadWorkspaceFileDetail).toBeTypeOf("function");
  if (!module.loadWorkspaceFileDetail) return;
  const details: Record<string, unknown>[] = [];

  await module.loadWorkspaceFileDetail(
    { getWorkspaceFile: () => Promise.reject(new Error("binary files cannot be previewed")) },
    { path: "asset.dat", status: "", label: "workspace" },
    () => true,
    (detail) => details.push(detail),
  );

  expect(details.at(-1)?.output).toBe("无法预览文件：binary files cannot be previewed");
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
