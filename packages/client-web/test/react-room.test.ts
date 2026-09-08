import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { ClientMarketplacePlugin, ClientPiConfig } from "../src/control-room.js";
import {
  PluginPanelCard,
  ChatTurnArticle,
  CommandPalette,
  Marketplace,
  insertCommandDraft,
  marketplaceDetailPlan,
  pluginActionErrorText,
  readRestartPendingPackages,
  reloadRuntimeConfig,
  restartPendingForProcess,
  shouldInterruptRun,
  shouldRefreshForRuntimeEvent,
  subscribeRuntimeEvents,
  withoutInstalledPackages,
  writeRestartPendingPackages,
} from "../src/react-room.js";

const config = (source: string): ClientPiConfig =>
  ({ path: "~/.pi/agent/settings.json", scope: "global", source, settings: { transport: "stdio" } }) as unknown as ClientPiConfig;

const plugin = (id: string): ClientMarketplacePlugin => ({
  id,
  packageName: `example-${id}`,
  version: "1.0.0",
  name: id,
  description: id,
  author: "example",
  repository: "https://example.com",
  license: "MIT",
  source: "official",
  status: "verified",
  category: { id: "tools", label: "工具" },
  capabilities: [],
  hooks: [],
  profile: { name: id, config: {} },
});

function recordConfigApply() {
  const applied: string[] = [];
  const states: string[] = [];
  const busy: boolean[] = [];
  const drafts: string[] = [];
  return {
    applied,
    states,
    busy,
    drafts,
    handlers: {
      config: (value: ClientPiConfig) => applied.push(value.source),
      sourceDraft: (source: string) => drafts.push(source),
      state: (message: string) => states.push(message),
      busy: (value: boolean) => busy.push(value),
    },
  };
}

describe("runtime config reload", () => {
  test("feeds the source editor with the text that was just read from disk", async () => {
    const target = recordConfigApply();

    await reloadRuntimeConfig({ reloadConfig: () => Promise.resolve(config('{\n  "transport": "stdio"\n}\n')) }, target.handlers);

    expect(target.drafts).toEqual(['{\n  "transport": "stdio"\n}\n']);
    expect(target.applied).toEqual(['{\n  "transport": "stdio"\n}\n']);
    expect(target.states).toEqual(["重载中…", "已从磁盘重载"]);
    expect(target.busy).toEqual([true, false]);
  });

  test("reports the failure and leaves the editor untouched when the reload fails", async () => {
    const target = recordConfigApply();

    await reloadRuntimeConfig({ reloadConfig: () => Promise.reject(new Error("settings.json 无法解析")) }, target.handlers);

    expect(target.drafts).toEqual([]);
    expect(target.applied).toEqual([]);
    expect(target.states).toEqual(["重载中…", "settings.json 无法解析"]);
    expect(target.busy).toEqual([true, false]);
  });
});

describe("runtime event refresh gating", () => {
  test("skips the snapshot refresh for per-token message updates", () => {
    expect(shouldRefreshForRuntimeEvent({ event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你" } } })).toBe(false);
    expect(shouldRefreshForRuntimeEvent({ event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "好" } } })).toBe(false);
  });

  test("still refreshes for durable events and for frames it cannot classify", () => {
    expect(shouldRefreshForRuntimeEvent({ event: { type: "turn_start" } })).toBe(true);
    expect(shouldRefreshForRuntimeEvent({ event: { type: "tool_execution_end" } })).toBe(true);
    expect(shouldRefreshForRuntimeEvent({ type: "snapshot", events: [] })).toBe(true);
    expect(shouldRefreshForRuntimeEvent({ event: null })).toBe(true);
  });
});

describe("runtime event subscription", () => {
  test("keeps one stream open while the handler identity changes", () => {
    let subscriptions = 0;
    let closed = 0;
    let emit: ((payload: Record<string, unknown>) => void) | undefined;
    const seen: string[] = [];
    const handler = { current: (payload: Record<string, unknown>) => seen.push(`first:${String(payload.event)}`) };

    const unsubscribe = subscribeRuntimeEvents(
      {
        subscribeEvents: (onEvent) => {
          subscriptions += 1;
          emit = onEvent;
          return () => {
            closed += 1;
          };
        },
      },
      handler,
    );
    emit?.({ event: "a" });
    handler.current = (payload) => seen.push(`second:${String(payload.event)}`);
    emit?.({ event: "b" });

    expect(subscriptions).toBe(1);
    expect(closed).toBe(0);
    expect(seen).toEqual(["first:a", "second:b"]);
    unsubscribe();
    expect(closed).toBe(1);
  });

  // The bug was never in the wrapper above, which can only subscribe once: it was the control room's effect listing the handler and the refresh callback among its dependencies, so every re-render with a new callback identity tore the EventSource down and opened a new one. Running that effect needs a DOM renderer, and this workspace has no DOM environment and no React test renderer, so the dependency list is asserted against the source instead.
  test("subscribes from an effect that depends on nothing but the api client", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    const effect = /useEffect\(\(\) => subscribeRuntimeEvents\(([^()]*)\), \[([^\]]*)\]\)/u.exec(source);

    expect(effect, "no `useEffect(() => subscribeRuntimeEvents(...), [...])` call was found").not.toBeNull();
    expect((effect?.[1] ?? "").split(",").map((argument) => argument.trim())).toEqual(["api", "handleRuntimeEventRef"]);
    expect((effect?.[2] ?? "").split(",").map((dependency) => dependency.trim())).toEqual(["api"]);
    // The stream stays open across re-renders only because the ref the wrapper reads is refreshed by its own effect.
    expect(source).toContain("handleRuntimeEventRef.current = handleRuntimeEvent;");
  });
});

describe("marketplace detail resolution", () => {
  test("shows a plugin that is already loaded on the visible page", () => {
    expect(marketplaceDetailPlan("cordis-timer", [plugin("cordis-timer")], undefined)).toEqual({ kind: "show", plugin: plugin("cordis-timer") });
  });

  test("finds a plugin that sits past the first marketplace page in the full catalog", () => {
    const catalog = Array.from({ length: 120 }, (_, index) => plugin(`plugin-${index}`));

    expect(marketplaceDetailPlan("plugin-119", catalog, undefined)).toEqual({ kind: "show", plugin: plugin("plugin-119") });
  });

  test("keeps an already resolved detail instead of refetching it on every poll", () => {
    expect(marketplaceDetailPlan("cordis-timer", [], "cordis-timer")).toEqual({ kind: "keep" });
  });

  test("fetches once for a deep link that no loaded page covers and clears without a route", () => {
    expect(marketplaceDetailPlan("cordis-timer", [plugin("other")], "another-plugin")).toEqual({ kind: "fetch" });
    expect(marketplaceDetailPlan(undefined, [plugin("cordis-timer")], "cordis-timer")).toEqual({ kind: "clear" });
  });
});

describe("chat transcript turns", () => {
  test("renders a user bubble and an assistant turn with its reasoning", () => {
    const user = renderToStaticMarkup(createElement(ChatTurnArticle, { role: "user", text: "帮我看看", thinking: "", onMouseUp: () => {} }));
    const assistant = renderToStaticMarkup(
      createElement(ChatTurnArticle, { role: "assistant", text: "**已完成**", thinking: "先读文件", onMouseUp: () => {} }),
    );
    const withoutReasoning = renderToStaticMarkup(createElement(ChatTurnArticle, { role: "assistant", text: "**已完成**", thinking: "", onMouseUp: () => {} }));

    expect(user).toContain("帮我看看");
    expect(user).toContain('class="turn user"');
    expect(user).not.toContain("turn-markdown");
    expect(assistant).toContain('class="turn text"');
    expect(assistant).toContain('class="reasoning message-reasoning"');
    expect(assistant.match(/turn-markdown/gu)).toHaveLength(2);
    expect(withoutReasoning).not.toContain("reasoning message-reasoning");
    expect(withoutReasoning.match(/turn-markdown/gu)).toHaveLength(1);
  });

  test("is memoised so an unchanged turn is not re-parsed on every poll", () => {
    expect((ChatTurnArticle as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });
});

const marketplaceMarkup = (options: { installed?: readonly string[]; restartPending?: readonly string[] } = {}) =>
  renderToStaticMarkup(
    createElement(Marketplace, {
      plugins: [plugin("cordis-timer")],
      capabilities: [],
      categories: [],
      total: 1,
      page: 0,
      hasNext: false,
      query: "",
      capabilityFilter: "",
      categoryFilter: "",
      onQueryChange: () => undefined,
      onCapabilityChange: () => undefined,
      onCategoryChange: () => undefined,
      onPageChange: () => undefined,
      onOpenDetail: () => undefined,
      onBack: () => undefined,
      onToml: () => undefined,
      installedPackages: new Set(options.installed ?? []),
      restartPendingPackages: new Set(options.restartPending ?? []),
      onInstall: () => Promise.resolve({}),
    }),
  );

describe("marketplace install feedback", () => {
  test("marks a plugin that is waiting for a restart as installed rather than offering the install again", () => {
    const pending = marketplaceMarkup({ restartPending: ["example-cordis-timer"] });

    expect(pending).toContain("重启后生效");
    expect(pending).not.toContain(">安装</button>");
    expect(/<button disabled=""[^>]*>重启后生效<\/button>/u.test(pending)).toBe(true);
  });

  test("keeps 已安装 for a loaded plugin and 安装 for one nobody touched", () => {
    expect(marketplaceMarkup({ installed: ["example-cordis-timer"] })).toContain(">已安装</button>");
    expect(marketplaceMarkup()).toContain(">安装</button>");
  });

  test("brings the restart notice back when the user returns to the marketplace", () => {
    const markup = marketplaceMarkup({ restartPending: ["example-cordis-timer"] });

    expect(markup).toContain("Ctrl-C");
    expect(markup.indexOf("Ctrl-C")).toBeLessThan(markup.indexOf('class="marketplace-scroll"'));
    expect(marketplaceMarkup()).not.toContain("Ctrl-C");
  });

  test("puts the install message region in the toolbar, above the grid that scrolls it out of sight", () => {
    const markup = marketplaceMarkup();
    const toolbar = markup.indexOf('class="marketplace-toolbar"');
    const message = markup.indexOf("marketplace-toolbar-message");
    const scroll = markup.indexOf('class="marketplace-scroll"');

    expect(toolbar).toBeGreaterThanOrEqual(0);
    expect(message).toBeGreaterThan(toolbar);
    expect(message).toBeLessThan(scroll);
    // The region has to be in the markup before the message lands in it, otherwise a screen reader announces nothing.
    expect(markup).toContain('aria-live="polite" class="marketplace-toolbar-message"');
  });
});

describe("plugin action error text", () => {
  test("translates the fixed English API errors and says what to do next", () => {
    expect(pluginActionErrorText("Another marketplace plugin change is already running")).toBe("已有插件操作正在进行，请等它完成后重试。");
    expect(pluginActionErrorText("Plugin is already installed")).toBe("这个插件已经安装过了，可以在「已安装」列表里管理它。");
    expect(pluginActionErrorText("Built-in plugins cannot be changed")).toBe("内置插件由运行时管理，不能启用或停用。");
    expect(pluginActionErrorText("Request failed with status 502")).toBe("请求失败（HTTP 502）：请确认 Pi Harness 仍在运行，然后重试。");
  });

  test("passes an unknown message through so npm output is never swallowed", () => {
    expect(pluginActionErrorText("npm ERR! code E404")).toBe("npm ERR! code E404");
  });
});

describe("restart pending plugins", () => {
  test("survives a reload and drops a package as soon as the loader reports it", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };

    writeRestartPendingPackages(storage, { packages: new Set(["example-cordis-timer", "example-other"]), process: "2026-09-07T00:00:00.000Z" });

    expect(readRestartPendingPackages(storage)).toEqual({
      packages: new Set(["example-cordis-timer", "example-other"]),
      process: "2026-09-07T00:00:00.000Z",
    });
    expect(withoutInstalledPackages(readRestartPendingPackages(storage).packages, new Set(["example-other"]))).toEqual(new Set(["example-cordis-timer"]));
  });

  test("forgets the set once another process answers, so a plugin that failed to load stops claiming a restart will fix it", () => {
    const pending = { packages: new Set(["example-cordis-timer"]), process: "2026-09-07T00:00:00.000Z" };

    expect(restartPendingForProcess(pending, "2026-09-07T00:00:00.000Z")).toBe(pending);
    // No status has arrived yet, and clearing on the strength of that would drop the set on every reload.
    expect(restartPendingForProcess(pending, "")).toBe(pending);
    expect(restartPendingForProcess(pending, "2026-09-07T09:30:00.000Z")).toEqual({ packages: new Set(), process: "2026-09-07T09:30:00.000Z" });
  });

  test("reads an empty set from missing, unusable or corrupt storage, and treats a set stored before process identity as foreign", () => {
    expect(readRestartPendingPackages(undefined)).toEqual({ packages: new Set(), process: "" });
    expect(readRestartPendingPackages({ getItem: () => null })).toEqual({ packages: new Set(), process: "" });
    expect(readRestartPendingPackages({ getItem: () => "{ not json" })).toEqual({ packages: new Set(), process: "" });
    expect(readRestartPendingPackages({ getItem: () => '{"packages":["ok",7],"process":"p1"}' })).toEqual({ packages: new Set(["ok"]), process: "p1" });
    expect(readRestartPendingPackages({ getItem: () => '["ok", 7]' })).toEqual({ packages: new Set(["ok"]), process: "" });
  });

  test("returns the same set when nothing was installed so the holding state keeps its identity", () => {
    const pending = new Set(["example-cordis-timer"]);

    expect(withoutInstalledPackages(pending, new Set(["example-other"]))).toBe(pending);
  });
});

describe("restart required notice", () => {
  test("names the profile file and the terminal action, without a start command it cannot know", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    const notice = /const RESTART_REQUIRED_NOTICE =\s*"([^"]*)";/u.exec(source);

    expect(notice, 'no `const RESTART_REQUIRED_NOTICE = "..."` declaration was found').not.toBeNull();
    expect(notice?.[1]).toContain("~/.pi-harness/profiles/");
    expect(notice?.[1]).toContain("Ctrl-C");
    // The console is reachable through more than one launcher, so the sentence tells the user to repeat their own command instead of naming one.
    expect(notice?.[1]).not.toContain("pih");
    expect(notice?.[1]).not.toContain("everyapi");
  });
});

const keyEvent = (overrides: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; key: string; target: EventTarget | null }> = {}) => ({
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  key: "c",
  target: null,
  ...overrides,
});

describe("interrupting a run with the advertised shortcut", () => {
  test("stops a run in flight, and only while one is in flight", () => {
    expect(shouldInterruptRun(keyEvent(), true, "")).toBe(true);
    expect(shouldInterruptRun(keyEvent({ key: "C" }), true, "")).toBe(true);
    expect(shouldInterruptRun(keyEvent(), false, "")).toBe(false);
    expect(shouldInterruptRun(keyEvent({ key: "v" }), true, "")).toBe(false);
    expect(shouldInterruptRun(keyEvent({ ctrlKey: false }), true, "")).toBe(false);
  });

  test("never takes a copy away from the user", () => {
    // Cmd+C on macOS is copy and nothing else, and Ctrl+Shift+C opens the browser inspector.
    expect(shouldInterruptRun(keyEvent({ metaKey: true }), true, "")).toBe(false);
    expect(shouldInterruptRun(keyEvent({ shiftKey: true }), true, "")).toBe(false);
    expect(shouldInterruptRun(keyEvent(), true, "已选中的回答")).toBe(false);
    // A textarea keeps a selection that window.getSelection() reports as empty, so the focused field is asked directly.
    expect(shouldInterruptRun(keyEvent({ target: { selectionStart: 2, selectionEnd: 9 } as unknown as EventTarget }), true, "")).toBe(false);
    expect(shouldInterruptRun(keyEvent({ target: { selectionStart: 4, selectionEnd: 4 } as unknown as EventTarget }), true, "")).toBe(true);
  });

  test("marks the interrupted turn so it does not read as a finished one", () => {
    const stopped = renderToStaticMarkup(
      createElement(ChatTurnArticle, { role: "assistant", text: "正在读取", thinking: "", stopped: true, onMouseUp: () => {} }),
    );

    expect(stopped).toContain("已中断");
    expect(renderToStaticMarkup(createElement(ChatTurnArticle, { role: "assistant", text: "正在读取", thinking: "", onMouseUp: () => {} }))).not.toContain(
      "已中断",
    );
  });

  test("keeps the stop control reachable at the width that hides the run label", async () => {
    const css = await readFile(new URL("../../../apps/web/src/style.css", import.meta.url), "utf8");
    const narrow = /@media \(max-width: 680px\) \{(.*?)\n\}/su.exec(css)?.[1] ?? "";

    expect(narrow).toContain(".run-indicator > span:not(.run-dot)");
    // Hiding the whole indicator takes the 停止 button with it and leaves a narrow window with no way to stop a run.
    expect(/\.run-indicator \{\s*@apply \[display:none\]/u.test(narrow)).toBe(false);
  });
});

describe("streaming transcript scrolling", () => {
  test("re-sticks to the bottom on every delta, not only when the turn ends", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    const effect = /if \(!stickToBottomRef\.current\) return;(.*?)\]\);/su.exec(source)?.[1] ?? "";

    expect(effect).toContain("streamingAssistant?.text.length");
    expect(effect).toContain("streamingAssistant?.thinking.length");
    expect(effect).toContain("data.session?.messages.length");
  });
});

describe("command palette insertion", () => {
  test("adds the command to what the user already typed instead of replacing it", () => {
    expect(insertCommandDraft("把登录改成 OAuth", 11, "/commit")).toEqual({ text: "把登录改成 OAuth /commit ", caret: 20 });
    expect(insertCommandDraft("修好 bug", 3, "/commit")).toEqual({ text: "修好 /commit bug", caret: 11 });
    expect(insertCommandDraft("修好这个 ", 5, "/commit")).toEqual({ text: "修好这个 /commit ", caret: 13 });
  });

  test("behaves like a plain fill when the composer is empty and clamps a caret it cannot trust", () => {
    expect(insertCommandDraft("", 0, "/commit")).toEqual({ text: "/commit ", caret: 8 });
    expect(insertCommandDraft("修好这个", 99, "/commit")).toEqual({ text: "修好这个 /commit ", caret: 13 });
    expect(insertCommandDraft("修好这个", -3, "/commit")).toEqual({ text: "/commit 修好这个", caret: 8 });
  });
});

describe("command palette with an empty registry", () => {
  const palette = (commands: readonly { name: string; invocationName: string }[]) =>
    renderToStaticMarkup(createElement(CommandPalette, { commands, query: "", activeIndex: 0, onActiveIndexChange: () => undefined, onUse: () => undefined }));

  test("says where commands come from instead of naming an internal registry", () => {
    const empty = palette([]);

    expect(empty).not.toContain("命令注册清单");
    expect(empty).toContain("~/.pi/agent/extensions");
    expect(palette([{ name: "commit", invocationName: "commit" }])).toContain("/commit");
  });

  test("stops the composer from advertising a slash that opens nothing", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");

    // The completion popover needs at least one item to open, so both the placeholder and the chip have to be tied to the command count.
    expect(source).toContain('`描述要做的改动，⌘↵ 发送；@ 引用文件${data.commands.length ? "，/ 调用命令" : ""}`');
    expect(/className="tool-chip"\s*disabled=\{!data\.commands\.length\}/u.test(source)).toBe(true);
  });
});

test("shows navigator Git status without requiring a tree first", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "workspace-navigator-panel",
        pluginId: "@pi-harness/plugin-workspace-navigator",
        title: "Workspace Navigator",
        data: {
          cwd: "/workspace/current",
          latest: null,
          git: {
            available: true,
            branch: "feature-current",
            clean: false,
            changedCount: 1,
            truncated: false,
            entries: [{ status: "??", path: "current.txt" }],
          },
        },
      },
    }),
  );
  expect(html).toContain("feature-current");
  expect(html).toContain("current.txt");
  expect(html).toContain("/workspace/current");
});
