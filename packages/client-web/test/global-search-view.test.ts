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
