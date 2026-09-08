import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Files } from "../src/react-room.js";
import type { ClientApi, ClientFile } from "../src/control-room.js";

function renderFiles(files: readonly ClientFile[]): string {
  return renderToStaticMarkup(
    createElement(Files, {
      files,
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

    expect(html).toContain("0 个文件 · 0 个新增文件 · 0 个删除文件");
  });
});
