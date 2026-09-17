// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Files } from "../src/react-room.js";
import type { ClientApi, ClientFile } from "../src/control-room.js";

function renderFiles(files: readonly ClientFile[], repository = true, truncated = false): string {
  return renderToStaticMarkup(
    createElement(Files, {
      files,
      repository,
      truncated,
      api: {} as ClientApi,
      onDiff: async () => {},
      onRefresh: () => {},
    }),
  );
}

describe("files view summary", () => {
  test("counts added and deleted files rather than changed lines", () => {
    const html = renderFiles([
      { path: "cart.js", status: " M", label: "modified" },
      { path: "notes.md", status: "??", label: "untracked" },
      { path: "old.js", status: " D", label: "deleted" },
    ]);

    // A modified file changes lines without adding or removing a file, so the wording has to say 文件 or the row reads as "0 lines changed" next to a diff that clearly changed some.
    expect(html).toContain("3 个文件 · 1 个新增文件 · 1 个删除文件");
    expect(html).not.toContain("个新增 ·");
  });

  test("reports an empty worktree without inventing counts", () => {
    const html = renderFiles([]);

    expect(html).toContain("未提交工作区改动");
    expect(html).not.toContain("本次会话改动");
    expect(html).toContain("0 个文件 · 0 个新增文件 · 0 个删除文件");
  });

  test("labels plain-workspace output honestly and hides Git-only actions", () => {
    const html = renderFiles([{ path: "index.html", status: "A", label: "generated" }], false);

    expect(html).toContain("本次会话产出");
    expect(html).toContain("根据成功的文件工具调用识别");
    expect(html).not.toContain("提交这些改动");
    expect(html).not.toContain("全部撤销");
  });
});

describe("files view truncation", () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const changed: readonly ClientFile[] = [{ path: "cart.js", status: " M", label: "modified" }];
  let root: Root | undefined;

  beforeEach(() => {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    let frame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return ++frame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = undefined;
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  // git status is killed on its output limit in a big worktree, and the console presented the prefix that survived as the whole list, counts and all.
  test("says the list is a prefix when the server could not send all of it", () => {
    expect(renderFiles(changed, true, true)).toContain("列表已截断");
    expect(renderFiles(changed, true, false)).not.toContain("列表已截断");
  });

  // The revert is sent as the paths on screen, so on a truncated list the old wording promised to discard changes the request never mentions.
  test("does not promise to discard changes it cannot reach", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(Files, { files: changed, repository: true, truncated: true, api: {} as ClientApi, onDiff: async () => {}, onRefresh: () => {} }),
      );
      await Promise.resolve();
    });

    const revert = [...document.querySelectorAll("button")].find((button) => button.textContent === "全部撤销");
    await act(async () => {
      revert?.click();
      await Promise.resolve();
    });

    const dialog = document.querySelector(".session-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("列表已截断");
    expect(dialog?.textContent).not.toContain("全部未提交改动");
  });
});
