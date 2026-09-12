import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { themePresets } from "../../plugins/theme-studio/src/index.js";
import { createClientApi, type ClientMarketplacePlugin, type ClientPiConfig } from "../src/control-room.js";
import { setLocale } from "../src/i18n.js";
import type { ConfigStatus } from "../src/react-room.js";
import {
  PluginPanelCard,
  PromptError,
  ProviderAuthNotice,
  ChatTurnArticle,
  CommandPalette,
  Marketplace,
  archiveActionForSessions,
  insertCommandDraft,
  marketplaceDetailPlan,
  modelSelectable,
  pluginActionErrorText,
  providerTestAuthText,
  readRestartPendingPackages,
  reloadRuntimeConfig,
  restartRequiredNotice,
  restartPendingForProcess,
  sessionListEmptyMessage,
  shouldInterruptRun,
  shouldRefreshForRuntimeEvent,
  pinActionForSessions,
  subscribeRuntimeEvents,
  toolArgumentSummary,
  toolSignature,
  withoutInstalledPackages,
  writeRestartPendingPackages,
  nextSessionSearchPage,
} from "../src/react-room.js";

const config = (source: string): ClientPiConfig =>
  ({ path: "~/.pi/agent/settings.json", scope: "global", source, settings: { transport: "stdio" } }) as unknown as ClientPiConfig;

describe("provider auth readiness", () => {
  const provider = { provider: "everyapi", name: "EveryAPI", active: true, auth: { configured: false }, models: [] };
  const render = (model: string, providers: Parameters<typeof ProviderAuthNotice>[0]["providers"]) =>
    renderToStaticMarkup(createElement(ProviderAuthNotice, { model, providers, onConfigure: () => {} }));

  test("warns before submit when the selected provider explicitly lacks auth", () => {
    const html = render("everyapi/model/variant", [provider]);
    expect(html).toContain("模型尚未配置认证");
    expect(html).toContain("everyapi use pi-harness");
    expect(html).toContain("提供商");
  });

  test("does not confuse missing metadata or another provider with missing auth", () => {
    expect(render("everyapi/model", [])).toBe("");
    expect(render("other/model", [provider])).toBe("");
    expect(render("everyapi/model", [{ ...provider, auth: undefined }])).toBe("");
    expect(render("everyapi/model", [{ ...provider, auth: { configured: true } }])).toBe("");
  });

  test("localizes stable EveryAPI CLI auth statuses instead of rendering gateway prose", async () => {
    await setLocale("en");
    try {
      expect(providerTestAuthText({ status: "cli-auth-missing", label: "未检测到 EveryAPI CLI 登录" })).toBe("No credentials detected");
      expect(providerTestAuthText({ status: "relay-key-missing", label: "EveryAPI CLI 已登录，但 relay key 未注入当前进程" })).toBe(
        "Start it with everyapi use pi-harness, or set EVERYAPI_RELAY_KEY and restart.",
      );
      expect(providerTestAuthText({ label: "Provider-specific fallback" })).toBe("Provider-specific fallback");
    } finally {
      await setLocale("zh-CN");
    }
  });
});

describe("session search requests", () => {
  test("distinguishes an empty search result from an empty session history", async () => {
    expect(sessionListEmptyMessage("missing")).toBe("没有匹配的会话");
    expect(sessionListEmptyMessage("")).toBe("暂无已保存会话");
  });

  test("resets pagination when the session query changes", async () => {
    expect(nextSessionSearchPage(3, "old", "new")).toBe(0);
    expect(nextSessionSearchPage(3, "same", "same")).toBe(3);
  });

  test("passes the search query to the paginated session endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ items: [], total: 0, page: 0, pageSize: 30, hasNext: false }), { status: 200 });
    }) as typeof fetch;
    try {
      await createClientApi().listSessions(0, 30, false, "Road map");
      expect(requests).toEqual(["/api/sessions?page=0&pageSize=30&includeArchived=false&q=Road%20map"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("debounces session queries before they participate in the broad refresh", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    expect(source).toContain("setSessionQuery(search)");
    expect(source).toContain("api.listSessions(sessionPage, 30, includeArchivedSessions, sessionQuery)");
    expect(source).toContain("marketplaceQuery, sessionPage, sessionQuery]");
    expect(source).not.toContain("marketplaceQuery, search, sessionPage]");
  });
});

describe("model selection readiness", () => {
  const models = [
    { provider: "missing", id: "one", name: "Missing", reasoning: false, contextWindow: 8_000, active: true },
    { provider: "ready", id: "two", name: "Ready", reasoning: false, contextWindow: 8_000, active: false },
    { provider: "unknown", id: "three", name: "Unknown", reasoning: false, contextWindow: 8_000, active: false },
  ];
  const providers = [
    { provider: "missing", name: "Missing", active: true, auth: { configured: false }, models: [models[0]!] },
    { provider: "ready", name: "Ready", active: false, auth: { configured: true }, models: [models[1]!] },
  ];

  test("disables only models whose provider explicitly lacks credentials", () => {
    expect(modelSelectable(models[0]!, providers)).toBe(false);
    expect(modelSelectable(models[1]!, providers)).toBe(true);
    expect(modelSelectable(models[2]!, providers)).toBe(true);
  });

  test("reports model-switch failures as model errors and recognizes Pi's API-key wording", () => {
    const authHtml = renderToStaticMarkup(createElement(PromptError, { action: "model", message: "No API key for everyapi/gpt-5.6-sol" }));
    expect(authHtml).toContain("EveryAPI 认证未注入当前进程");
    expect(authHtml).not.toContain("发送失败");

    const runtimeHtml = renderToStaticMarkup(createElement(PromptError, { action: "model", message: "Runtime rejected model" }));
    expect(runtimeHtml).toContain("模型切换失败");
    expect(runtimeHtml).not.toContain("发送失败");
  });

  test("labels session action failures independently from prompt failures", () => {
    const html = renderToStaticMarkup(createElement(PromptError, { action: "session", message: "Invalid session path" }));
    expect(html).toContain("会话操作失败");
    expect(html).not.toContain("发送失败");
  });

  test("clears a session action error before submitting a prompt", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    expect(source).toContain('setSessionActionError("");\n    setStoredPromptUi');
  });
});

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
  const states: (ConfigStatus | undefined)[] = [];
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
      state: (status: ConfigStatus | undefined) => states.push(status),
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
    expect(target.states).toEqual([
      { text: "重载中…", kind: "progress" },
      { text: "已从磁盘重载", kind: "done" },
    ]);
    expect(target.busy).toEqual([true, false]);
  });

  test("reports the failure and leaves the editor untouched when the reload fails", async () => {
    const target = recordConfigApply();

    await reloadRuntimeConfig({ reloadConfig: () => Promise.reject(new Error("settings.json 无法解析")) }, target.handlers);

    expect(target.drafts).toEqual([]);
    expect(target.applied).toEqual([]);
    expect(target.states).toEqual([
      { text: "重载中…", kind: "progress" },
      { text: "settings.json 无法解析", kind: "error" },
    ]);
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
  test("reports EventSource connection and reconnection states", () => {
    const originalEventSource = globalThis.EventSource;
    class FakeEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      static latest: FakeEventSource | undefined;
      readyState = FakeEventSource.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      constructor(readonly url: string) {
        FakeEventSource.latest = this;
      }
      close() {
        this.closed = true;
        this.readyState = FakeEventSource.CLOSED;
      }
    }
    Object.assign(globalThis, { EventSource: FakeEventSource });
    const states: string[] = [];
    const events: Record<string, unknown>[] = [];
    try {
      const unsubscribe = createClientApi().subscribeEvents(
        (payload) => events.push(payload),
        (state) => states.push(state),
      );
      const source = FakeEventSource.latest;
      expect(source?.url).toBe("/api/events");
      expect(states).toEqual(["connecting"]);
      if (source === undefined) throw new Error("EventSource was not created");
      source.readyState = FakeEventSource.OPEN;
      source.onopen?.(new Event("open"));
      source.onmessage?.(new MessageEvent("message", { data: '{"event":"thinking"}' }));
      source.readyState = FakeEventSource.CONNECTING;
      source.onerror?.(new Event("error"));
      source.readyState = FakeEventSource.CLOSED;
      source.onerror?.(new Event("error"));
      expect(states).toEqual(["connecting", "open", "reconnecting", "closed"]);
      expect(events).toEqual([{ event: "thinking" }]);
      unsubscribe();
      expect(source.closed).toBe(true);
    } finally {
      Object.assign(globalThis, { EventSource: originalEventSource });
    }
  });

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
    expect((effect?.[1] ?? "").split(",").map((argument) => argument.trim())).toEqual(["api", "handleRuntimeEventRef", "handleEventStreamStateRef"]);
    expect((effect?.[2] ?? "").split(",").map((dependency) => dependency.trim())).toEqual(["api"]);
    // The stream stays open across re-renders only because the ref the wrapper reads is refreshed by its own effect.
    expect(source).toContain("handleRuntimeEventRef.current = handleRuntimeEvent;");
  });
});

describe("session list tools", () => {
  test("restores fully archived selections and unpins fully pinned selections", () => {
    expect(archiveActionForSessions([{ archived: true }, { archived: true }])).toBe("unarchive");
    expect(archiveActionForSessions([{ archived: true }, { archived: false }])).toBe("archive");
    expect(archiveActionForSessions([])).toBe("archive");
    expect(pinActionForSessions([{ pinned: true }, { pinned: true }])).toBe("unpin");
    expect(pinActionForSessions([{ pinned: true }, {}])).toBe("pin");
    expect(pinActionForSessions([])).toBe("pin");
  });

  test("refreshes in place instead of reloading the whole application", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    const menu = source.slice(source.indexOf('{t("刷新列表")}') - 500, source.indexOf('{t("刷新列表")}') + 100);

    expect(menu).toContain("void refresh()");
    expect(menu).toContain("restoreSessionPopoverFocus()");
    expect(menu).not.toContain("window.location.reload()");
  });

  test("returns to the first page before applying the archived-session filter", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    const start = source.indexOf("setIncludeArchivedSessions((current) => !current)");
    const handler = source.slice(start, start + 360);

    expect(handler).toContain("setSessionPage(0)");
    expect(handler).toContain("setSelectedSessionPaths(new Set())");
    expect(handler).toContain("restoreSessionPopoverFocus()");
    expect(handler).not.toContain("void refresh()");
  });

  test("clears selections before changing session pages", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    const previousPage = source.slice(
      source.indexOf("setSessionPage((page) => Math.max(0, page - 1))") - 140,
      source.indexOf("setSessionPage((page) => Math.max(0, page - 1))") + 70,
    );
    const nextPage = source.slice(source.indexOf("setSessionPage((page) => page + 1)") - 140, source.indexOf("setSessionPage((page) => page + 1)") + 55);

    expect(previousPage).toContain("setSelectedSessionPaths(new Set())");
    expect(nextPage).toContain("setSelectedSessionPaths(new Set())");
  });

  test("closes the tools popover before opening the header session menu", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    const start = source.indexOf("aria-expanded={sessionMenuOpen && !sessionMenuPath}");
    const handler = source.slice(start, start + 900);

    expect(handler).toContain("setSessionToolsOpen(false)");
    expect(handler).toContain("setSessionToolsPosition(undefined)");
  });

  test("disables session popover triggers while a session action is busy", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    const toolsTrigger = source.slice(source.indexOf("aria-expanded={sessionToolsOpen}"), source.indexOf("aria-expanded={sessionToolsOpen}") + 260);
    const headerTrigger = source.slice(
      source.indexOf("aria-expanded={sessionMenuOpen && !sessionMenuPath}"),
      source.indexOf("aria-expanded={sessionMenuOpen && !sessionMenuPath}") + 260,
    );

    expect(toolsTrigger).toContain("disabled={sessionActionBusy}");
    expect(headerTrigger).toContain("disabled={sessionActionBusy}");
  });

  test("keeps session row action triggers targetable before hover reveals them", async () => {
    const css = await readFile(new URL("../../../apps/web/src/style.css", import.meta.url), "utf8");
    const actionRule = /\.session-row-more\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";

    // The action button sits above a full-width row button. If it starts with
    // pointer-events:none, browser hit testing never reaches it to establish
    // the hover rule that would make it targetable.
    expect(actionRule).toContain("[pointer-events:auto]");
    expect(actionRule).toContain("z-index: 1");
  });

  test("marks the marketplace query as a search control", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    const marketplaceSearch = source.slice(source.indexOf('className="marketplace-search"') - 180, source.indexOf('className="marketplace-search"') + 260);

    expect(marketplaceSearch).toContain('type="search"');
  });
});

describe("new session workspace picker", () => {
  test("centers short content without clipping the start of an overflowing workspace list", async () => {
    const css = await readFile(new URL("../../../apps/web/src/style.css", import.meta.url), "utf8");
    const scrollRule = /\.chat-scroll\.is-empty\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";
    const screenRules = [...css.matchAll(/\.new-session-screen\s*\{([^}]*)\}/gu)].map((match) => match[1]).join("\n");

    expect(scrollRule).toContain("[justify-content:flex-start]");
    expect(screenRules).toContain("[margin-block:auto]");
  });
});

describe("run telemetry", () => {
  test("anchors the visually hidden live status so long turns cannot extend the page scroll area", async () => {
    const css = await readFile(new URL("../../../apps/web/src/style.css", import.meta.url), "utf8");
    const hiddenRule = /\.visually-hidden\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";

    expect(hiddenRule).toContain("[top:0]");
    expect(hiddenRule).toContain("[left:0]");
  });

  test("formats elapsed time as a stable run clock", async () => {
    const { formatRunClock } = await import("../src/react-room.js");

    expect(formatRunClock(0)).toBe("0:00");
    expect(formatRunClock(70)).toBe("1:10");
    expect(formatRunClock(3_661)).toBe("1:01:01");
    expect(formatRunClock(-1)).toBe("0:00");
    expect(formatRunClock(70.9)).toBe("1:10");
  });

  test("rehydrates an active run from the status snapshot after a page reload", async () => {
    const module = (await import("../src/react-room.js")) as Record<string, unknown>;
    expect(module.runActivityFromStatus, "runActivityFromStatus must recover a run without waiting for turn_start").toBeTypeOf("function");
    const merge = module.runActivityFromStatus as (
      status: Record<string, unknown>,
      current: unknown,
      now: number,
    ) => { startedAt: number; lastActivityAt: number; phase: string };
    const now = Date.parse("2026-09-12T00:01:10.000Z");

    expect(
      merge(
        {
          status: "running",
          run: { startedAt: "2026-09-12T00:00:00.000Z", lastActivityAt: "2026-09-12T00:00:20.000Z", phase: "thinking" },
        },
        undefined,
        now,
      ),
    ).toEqual({ startedAt: Date.parse("2026-09-12T00:00:00.000Z"), lastActivityAt: Date.parse("2026-09-12T00:00:20.000Z"), phase: "thinking" });
    expect(
      merge(
        {
          status: "running",
          run: { startedAt: "2026-09-12T00:00:00.000Z", lastActivityAt: "2026-09-12T00:00:20.000Z", phase: "thinking" },
        },
        {
          startedAt: Date.parse("2026-09-12T00:00:00.000Z"),
          lastActivityAt: Date.parse("2026-09-12T00:00:20.000Z"),
          phase: "responding",
        },
        now,
      ),
    ).toEqual({ startedAt: Date.parse("2026-09-12T00:00:00.000Z"), lastActivityAt: Date.parse("2026-09-12T00:00:20.000Z"), phase: "responding" });
    expect(merge({ status: "ready" }, { startedAt: 1, lastActivityAt: 2, phase: "tool" }, now)).toBeUndefined();
  });

  test("distinguishes active, quiet, reconnecting, and unreachable runs", async () => {
    const module = (await import("../src/react-room.js")) as Record<string, unknown>;
    expect(module.runTelemetryView).toBeTypeOf("function");
    const view = module.runTelemetryView as (
      activity: { startedAt: number; lastActivityAt: number; phase: string },
      connection: string,
      statusReachable: boolean | undefined,
      now: number,
    ) => Record<string, unknown>;
    const now = Date.parse("2026-09-12T00:01:10.000Z");
    const active = { startedAt: now - 70_000, lastActivityAt: now - 2_000, phase: "thinking" };
    const quiet = { ...active, lastActivityAt: now - 40_000 };

    expect(view(active, "open", true, now)).toEqual({ phase: "thinking", tone: "active", elapsedSeconds: 70, quietSeconds: 2 });
    expect(view(quiet, "open", true, now)).toEqual({ phase: "thinking", tone: "quiet", elapsedSeconds: 70, quietSeconds: 40 });
    expect(view(quiet, "reconnecting", true, now)).toEqual({ phase: "thinking", tone: "reconnecting", elapsedSeconds: 70, quietSeconds: 40 });
    expect(view(quiet, "closed", false, now)).toEqual({ phase: "thinking", tone: "offline", elapsedSeconds: 70, quietSeconds: 40 });
    expect(view(active, "connecting", true, now)).toEqual({ phase: "thinking", tone: "connecting", elapsedSeconds: 70, quietSeconds: 2 });
  });

  test("renders a running placeholder from status and observes the stable connection ref", async () => {
    const source = await readFile(new URL("../src/react-room.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../../../apps/web/src/style.css", import.meta.url), "utf8");

    expect(source).not.toContain('{streamingAssistant && data.status?.status === "running" && (');
    expect(source).toContain("runActivityFromStatus(data.status, current, now)");
    expect(source).toContain("subscribeRuntimeEvents(api, handleRuntimeEventRef, handleEventStreamStateRef)");
    expect(source).toContain("className={`run-indicator running ${runTelemetry.tone}`}");
    expect(source).toContain(') : data.status?.status !== "running" ? (');
    expect(source).toContain('data.session?.messages.length || data.status?.status === "running" ? "" : "is-empty"');
    expect(styles).toContain(".main-header:has(.run-indicator) .active-heading");
  });
});

describe("marketplace detail resolution", () => {
  test("shows a plugin that is already loaded on the visible page", () => {
    expect(marketplaceDetailPlan("cordis-timer", [{ locale: "en", plugins: [plugin("cordis-timer")] }], "en", undefined)).toEqual({
      kind: "show",
      plugin: plugin("cordis-timer"),
    });
  });

  test("finds a plugin that sits past the first marketplace page in the full catalog", () => {
    const catalog = Array.from({ length: 120 }, (_, index) => plugin(`plugin-${index}`));

    expect(marketplaceDetailPlan("plugin-119", [{ locale: "en", plugins: catalog }], "en", undefined)).toEqual({
      kind: "show",
      plugin: plugin("plugin-119"),
    });
  });

  test("keeps an already resolved detail instead of refetching it on every poll", () => {
    expect(marketplaceDetailPlan("cordis-timer", [], "en", { pluginId: "cordis-timer", locale: "en" })).toEqual({ kind: "keep" });
  });

  test("fetches once for a deep link that no loaded page covers and clears without a route", () => {
    expect(marketplaceDetailPlan("cordis-timer", [{ locale: "en", plugins: [plugin("other")] }], "en", { pluginId: "another-plugin", locale: "en" })).toEqual({
      kind: "fetch",
    });
    expect(marketplaceDetailPlan(undefined, [{ locale: "en", plugins: [plugin("cordis-timer")] }], "en", { pluginId: "cordis-timer", locale: "en" })).toEqual({
      kind: "clear",
    });
  });

  test("does not reuse stale detail data when the locale changes and the new catalog is unavailable", () => {
    expect(
      marketplaceDetailPlan("cordis-timer", [{ locale: "zh-CN", plugins: [plugin("cordis-timer")] }], "en", {
        pluginId: "cordis-timer",
        locale: "zh-CN",
      }),
    ).toEqual({ kind: "fetch" });
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
  test("names the profile file and the terminal action, without a start command it cannot know", () => {
    const notice = restartRequiredNotice();

    expect(notice).toContain("~/.pi-harness/profiles/");
    expect(notice).toContain("Ctrl-C");
    // The console is reachable through more than one launcher, so the sentence tells the user to repeat their own command instead of naming one.
    expect(notice).not.toContain("pih");
    expect(notice).not.toContain("everyapi");
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
    expect(
      /data\.commands\.length\s*\? t\("描述要做的改动，⌘↵ 发送；@ 引用文件，\/ 调用命令"\)\s*: t\("描述要做的改动，⌘↵ 发送；@ 引用文件"\)/u.test(source),
    ).toBe(true);
    expect(/className="tool-chip"\s*disabled=\{!data\.commands\.length\}/u.test(source)).toBe(true);
  });

  test("gives every command option a stable active-descendant target", () => {
    const html = palette([
      { name: "commit", invocationName: "commit" },
      { name: "review", invocationName: "review" },
    ]);

    expect(html).toContain('id="command-menu-option-0"');
    expect(html).toContain('id="command-menu-option-1"');
  });

  test("exposes the visible command selection through the sidebar combobox", async () => {
    const module = (await import("../src/react-room.js")) as unknown as {
      commandSearchAccessibility?: (open: boolean, activeIndex: number, itemCount: number) => Record<string, unknown>;
    };

    expect(module.commandSearchAccessibility).toBeTypeOf("function");
    if (!module.commandSearchAccessibility) return;
    expect(module.commandSearchAccessibility(true, 12, 3)).toEqual({
      "aria-activedescendant": "command-menu-option-2",
      "aria-autocomplete": "list",
      role: "combobox",
    });
    expect(module.commandSearchAccessibility(false, 0, 3)["aria-activedescendant"]).toBeUndefined();
    expect(module.commandSearchAccessibility(true, 0, 0)["aria-activedescendant"]).toBeUndefined();
  });
});

describe("tool transcript rendering", () => {
  test("memo signature changes when tool arguments or same-length output changes", () => {
    const tool = { id: "call-1", name: "read", arguments: { path: "a.ts" }, result: "ok", failed: false };

    expect(toolSignature([tool])).not.toBe(toolSignature([{ ...tool, arguments: { path: "b.ts" } }]));
    expect(toolSignature([tool])).not.toBe(toolSignature([{ ...tool, result: "no" }]));
  });

  test("summarises circular arguments without crashing the transcript", () => {
    const argumentsValue: Record<string, unknown> = { path: "a.ts" };
    argumentsValue.self = argumentsValue;

    expect(() => toolArgumentSummary(argumentsValue)).not.toThrow();
    expect(toolArgumentSummary(argumentsValue)).toContain("path=a.ts");
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
            failureReason: null,
            branch: "feature-current",
            clean: false,
            changedCount: 1,
            truncated: false,
            entries: [{ status: "??", path: "current.txt" }],
          },
          nodeCount: 0,
          gitTimeoutMs: 10_000,
        },
      },
    }),
  );
  expect(html).toContain("feature-current");
  expect(html).toContain("current.txt");
  expect(html).toContain("/workspace/current");
});

test("shows Agent Teams ids and wraps boundary-length operational values", () => {
  const memberId = `member-${"m".repeat(57)}`;
  const taskId = `task-${"t".repeat(59)}`;
  const assignee = `owner-${"a".repeat(58)}`;
  const dependency = `dependency-${"d".repeat(53)}`;
  const memberName = "N".repeat(200);
  const memberRole = "R".repeat(200);
  const taskTitle = "T".repeat(200);
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "agent-teams-panel",
        pluginId: "@pi-harness/plugin-agent-teams",
        title: "Agent Team Board",
        data: {
          members: [{ id: memberId, name: memberName, role: memberRole, status: "idle" }],
          tasks: [{ id: taskId, title: taskTitle, assignee, status: "in_progress", dependsOn: [dependency] }],
          messages: [],
          readyTasks: [],
          dependencyCycle: null,
        },
      },
    }),
  );

  expect(html).toContain('class="grid grid-cols-2 gap-2 xl:grid-cols-4"');
  expect(html).toContain(`class="min-w-0 break-words text-[11px] font-semibold text-[var(--color-ink)]">${memberName}</span>`);
  expect(html).toContain(`class="mt-1 block break-all text-[9px] text-[var(--color-blue)]">${memberId}</code>`);
  expect(html).toContain(`class="mt-1 block break-words text-[10px] leading-4 text-[var(--color-faint)]">${memberRole}</span>`);
  expect(html).toContain(`class="block break-words text-[11px] leading-4 text-[var(--color-ink)]">${taskTitle}</span>`);
  expect(html).toContain(`class="mt-1 block break-all text-[9px] text-[var(--color-blue)]">${taskId}</code>`);
  expect(html).toContain(`class="mt-1 block break-all text-[9px] text-[var(--color-faint)]">${assignee}</code>`);
  expect(html).toContain('class="mt-1 block break-all font-mono text-[9px] leading-4 text-[var(--color-faint)]"');
  expect(html).toContain(dependency);
});

test("shows incomplete workspace searches even when no matches were collected", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "workspace-search-panel",
        pluginId: "@pi-harness/plugin-workspace-search",
        title: "Workspace Search",
        data: {
          cwd: "/workspace/current",
          query: "needle",
          matchCount: 0,
          scannedFiles: 2,
          latest: {
            query: "needle",
            path: ".",
            matches: [],
            matchCount: 0,
            scannedFiles: 2,
            skippedFiles: 1,
            truncated: true,
            scannedEntries: 4,
            readBytes: 1024,
          },
        },
      },
    }),
  );
  expect(html).toContain("/workspace/current");
  expect(html).toContain("结果不完整");
  expect(html).toContain("needle");
});

test.each([
  { truncated: true, skippedFiles: 0 },
  { truncated: false, skippedFiles: 1 },
])("warns about incomplete module searches: %j", ({ truncated, skippedFiles }) => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "module-search-panel",
        pluginId: "@pi-harness/plugin-module-search",
        title: "Module Search",
        data: { latest: { query: "needle", matches: [], scannedFiles: 2, skippedFiles, truncated } },
      },
    }),
  );
  expect(html).toContain("结果不完整");
});

test.each([
  { addedTruncated: true, removedTruncated: false },
  { addedTruncated: false, removedTruncated: true },
  { addedTruncated: false, removedTruncated: false },
])("shows both comparison sides and conditional clipping warning: %j", (flags) => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "session-compare-panel",
        pluginId: "@pi-harness/plugin-session-compare",
        title: "Session Compare",
        data: {
          left: { id: "left", name: "Left" },
          right: { id: "right", name: "Right" },
          changed: true,
          added: [{ role: "assistant", text: "RIGHT_PREVIEW" }],
          removed: Array.from({ length: 5 }, (_, index) => ({ role: "assistant", text: `LEFT_PREVIEW_${index}` })),
          ...flags,
        },
      },
    }),
  );
  expect(html).toContain("RIGHT_PREVIEW");
  expect(html).toContain("左侧差异预览（最多显示 4 条）");
  expect(html).toContain("LEFT_PREVIEW_0");
  expect(html).toContain("LEFT_PREVIEW_3");
  expect(html).not.toContain("LEFT_PREVIEW_4");
  expect(html.includes("工具返回的差异预览已截断；上方计数仍为完整差异数量。")).toBe(flags.addedTruncated || flags.removedTruncated);
});

test("does not warn when a module search is complete", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "module-search-panel",
        pluginId: "@pi-harness/plugin-module-search",
        title: "Module Search",
        data: { latest: { query: "needle", matches: [], scannedFiles: 2, skippedFiles: 0, truncated: false } },
      },
    }),
  );
  expect(html).not.toContain("结果不完整");
});

test.each([
  { scanned: 1, truncated: true, reports: [{ repo: "one", verdict: "pass" }] },
  { scanned: 7, truncated: false, reports: Array.from({ length: 7 }, (_, i) => ({ repo: `repo-${i}`, verdict: "pass" })) },
])("warns when the plugin scan panel omits repositories: %j", (latest) => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "plugin-check-panel", pluginId: "@pi-harness/plugin-plugin-check", title: "Plugin Check", data: { latest } },
    }),
  );
  expect(html).toContain("结果不完整");
});

test("renders plugin schema definitions without pretending an inspection ran", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "plugin-check-panel",
        pluginId: "@pi-harness/plugin-plugin-check",
        title: "Plugin Check",
        data: {
          latest: { verdict: "pass", checks: [{ code: "no-manifest", label: "package.json exists and is valid JSON" }] },
        },
      },
    }),
  );
  expect(html).toContain("检查清单：1 项");
  expect(html).toContain("package.json exists and is valid JSON");
  expect(html).not.toContain("尚未检查插件");
  expect(html).not.toContain(">pass<");
});

test("does not show an unrun placeholder after a clean or empty plugin inspection", () => {
  for (const latest of [
    { repo: "clean", verdict: "pass", checks: { passed: 10, failed: 0, warned: 0 }, errors: [], warnings: [] },
    { scanned: 0, truncated: false, reports: [] },
  ]) {
    const html = renderToStaticMarkup(
      createElement(PluginPanelCard, {
        panel: { id: "plugin-check-panel", pluginId: "@pi-harness/plugin-plugin-check", title: "Plugin Check", data: { latest } },
      }),
    );
    expect(html).not.toContain("尚未检查插件");
  }
});

test("shows unavailable MCP separately from an empty running catalog service", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "skill-catalog-panel",
        pluginId: "@pi-harness/plugin-skill-catalog",
        title: "Skills Catalog",
        data: {
          skills: [{ name: "review", description: "Review", scope: "project" }],
          skillCount: 1,
          mcpAvailable: false,
          mcpCount: 0,
          mcpServers: [],
        },
      },
    }),
  );
  expect(html).toContain("review");
  expect(html).toContain("不可用");
});

test("shows unavailable MCP Console service instead of an empty-server snapshot", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: { id: "mcp-panel", pluginId: "@pi-harness/plugin-mcp-panel", title: "MCP Console", data: { available: false, servers: [] } },
    }),
  );
  expect(html).toContain("不可用");
});

test("identifies the source session and workspace of the last export", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "session-export-panel",
        pluginId: "@pi-harness/plugin-session-export",
        title: "Session Export",
        data: { latest: { path: "exports/session.md", sessionId: "source-session-123", workspace: "/workspace/export-source", messages: 3, bytes: 100 } },
      },
    }),
  );
  expect(html).toContain("source-session-123");
  expect(html).toContain("/workspace/export-source");
  expect(html).toContain("exports/session.md");
});

test("shows YAML warning text and the inspected workspace path", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "yaml-validator-panel",
        pluginId: "@pi-harness/plugin-yaml-validator",
        title: "YAML Validator",
        data: {
          cwd: "/workspace/current",
          latest: {
            path: "warning.yml",
            valid: true,
            documents: 1,
            bytes: 20,
            rootType: "map",
            errorCount: 0,
            warningCount: 1,
            errors: [],
            warnings: [{ message: "Unresolved tag: !unknown", code: "TAG_RESOLVE_FAILED", line: 1, column: 7 }],
          },
          status: { state: "completed" },
        },
      },
    }),
  );
  expect(html).toContain("/workspace/current");
  expect(html).toContain("warning.yml");
  expect(html).toContain("Unresolved tag: !unknown");
});

test("reports the actual sidebar preview count without calling Git truncation a directory error", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "better-sidebar-panel",
        pluginId: "@pi-harness/plugin-better-sidebar",
        title: "Better Sidebar",
        description: "",
        icon: "",
        data: {
          cwd: "/active",
          gitAvailable: true,
          gitFailureReason: null,
          branch: "feature/orders",
          clean: false,
          changedCount: 15,
          changedFiles: Array.from({ length: 12 }, (_, i) => ({ path: `file-${i}.txt`, status: "??" })),
          directoryCount: 20,
          fileCount: 60,
          truncated: true,
          sessionId: "session-orders",
          summary: "feature/orders · 15 个变更",
        },
      },
    }),
  );
  expect(html).toContain("显示 8 / 15 个变更");
  expect(html).toContain("概览包含截断的结果");
  expect(html).not.toContain("目录摘要已截断");
  expect(html).not.toContain("file-8.txt");
  expect(html).toContain('aria-label="工作区 Git 变更"');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain("whitespace-pre-wrap");
  expect(html).toContain("focus-visible:outline-2");
});

test("renders actionable Better Sidebar failures and rejects malformed panel snapshots", () => {
  const panel = {
    id: "better-sidebar-panel",
    pluginId: "@pi-harness/plugin-better-sidebar",
    title: "Better Sidebar",
    data: {
      cwd: "/active",
      gitAvailable: false,
      gitFailureReason: "timeout",
      branch: null,
      clean: false,
      changedCount: 0,
      changedFiles: [],
      directoryCount: 1,
      fileCount: 2,
      truncated: false,
      sessionId: "session-orders",
      summary: "Git 状态不可用 (timeout) · 无变更",
    },
  };
  const failureHtml = renderToStaticMarkup(createElement(PluginPanelCard, { panel }));
  const malformedHtml = renderToStaticMarkup(createElement(PluginPanelCard, { panel: { ...panel, data: { ...panel.data, changedCount: 1 } } }));
  const staleHtml = renderToStaticMarkup(createElement(PluginPanelCard, { activeSessionId: "new-session", panel }));

  expect(failureHtml).toContain("Git 状态读取超时；请提高 gitTimeoutMs 或缩小工作区。");
  expect(malformedHtml).toContain("Better Sidebar 面板数据异常");
  expect(malformedHtml).not.toContain("session-orders");
  expect(staleHtml).toContain("Better Sidebar 面板数据异常");
  expect(staleHtml).not.toContain("session-orders");
});

test("does not render a Theme Studio snapshot from another active session", () => {
  const panel = {
    id: "theme-studio-panel",
    pluginId: "@pi-harness/plugin-theme-studio",
    title: "Theme Studio",
    data: {
      ...themePresets.midnight,
      tokens: { ...themePresets.midnight.tokens },
      theme: "midnight",
      sessionId: "previous-session",
      changed: true,
      changedAt: "2026-09-12T00:00:00.000Z",
    },
  };

  const html = renderToStaticMarkup(createElement(PluginPanelCard, { activeSessionId: "active-session", panel }));

  expect(html).toContain("主题数据无效，未应用颜色。");
  expect(html).not.toContain("previous-session");
});

test("does not render Session Insights statistics from another active session", () => {
  const panel = {
    id: "session-insights-panel",
    pluginId: "@pi-harness/plugin-session-insights",
    title: "Session Insights",
    data: {
      sessionId: "previous-session",
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 5,
      tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, total: 35 },
      cost: 0.012_345,
      contextUsage: null,
      compaction: { status: "idle" },
    },
  };

  const html = renderToStaticMarkup(createElement(PluginPanelCard, { activeSessionId: "active-session", panel }));

  expect(html).toContain("会话统计数据无效");
  expect(html).not.toContain("previous-session");
  expect(html).not.toContain("0.0123");
});

test("does not render History Compressor state from another active session", () => {
  const panel = {
    id: "history-compressor-panel",
    pluginId: "@pi-harness/plugin-history-compressor",
    title: "History Compressor",
    data: {
      sessionId: "previous-session",
      enabled: true,
      thresholdPercent: 85,
      compactions: 17,
      lastUsagePercent: 92,
      queued: false,
      lastError: "previous session error",
    },
  };

  const staleHtml = renderToStaticMarkup(createElement(PluginPanelCard, { activeSessionId: "active-session", panel }));
  const activeHtml = renderToStaticMarkup(createElement(PluginPanelCard, { activeSessionId: "previous-session", panel }));

  expect(staleHtml).toContain("面板数据不完整或不一致。");
  expect(staleHtml).not.toContain("previous session error");
  expect(staleHtml).not.toContain("92%");
  expect(activeHtml).toContain("previous session error");
  expect(activeHtml).toContain("92%");
});

test("does not render Context Doctor findings from another active session", () => {
  const panel = {
    id: "context-doctor-panel",
    pluginId: "@pi-harness/plugin-context-doctor",
    title: "Context Doctor",
    data: {
      sessionId: "previous-session",
      status: "warning",
      usagePercent: 92,
      messageCount: 20,
      scannedMessages: 20,
      oversizedMessages: 2,
      uninspectableMessages: 1,
      toolErrors: 3,
      recommendations: ["old recommendation"],
      compaction: { status: "completed" },
    },
  };

  const html = renderToStaticMarkup(createElement(PluginPanelCard, { activeSessionId: "active-session", panel }));

  expect(html).toContain("面板数据不完整或不一致。");
  expect(html).not.toContain("old recommendation");
  expect(html).not.toContain("92%");
});

test("does not render Context Insights metrics from another active session", () => {
  const panel = {
    id: "context-insight-panel",
    pluginId: "@pi-harness/plugin-context",
    title: "Context Insights",
    data: {
      sessionId: "previous-session",
      tokens: 800,
      contextWindow: 8_000,
      percent: 10,
      messages: 1,
      scannedMessages: 1,
      messagesTruncated: false,
      events: 3,
      compactions: 1,
      composition: { user: 1, assistant: 0, toolResult: 0, system: 0, other: 0 },
      recentEvents: [{ type: "message_end", at: 1_788_621_601_000 }],
    },
  };

  const html = renderToStaticMarkup(createElement(PluginPanelCard, { activeSessionId: "active-session", panel }));

  expect(html).toContain("上下文洞察面板数据不完整或不一致");
  expect(html).not.toContain("previous-session");
  expect(html).not.toContain("800 tokens");
  expect(html).not.toContain("10%");
});

test("does not render retained Context Insights metrics when there is no active session", () => {
  const panel = {
    id: "context-insight-panel",
    pluginId: "@pi-harness/plugin-context",
    title: "Context Insights",
    data: {
      sessionId: "previous-session",
      tokens: 800,
      contextWindow: 8_000,
      percent: 10,
      messages: 1,
      scannedMessages: 1,
      messagesTruncated: false,
      events: 3,
      compactions: 1,
      composition: { user: 1, assistant: 0, toolResult: 0, system: 0, other: 0 },
      recentEvents: [{ type: "message_end", at: 1_788_621_601_000 }],
    },
  };

  const html = renderToStaticMarkup(createElement(PluginPanelCard, { panel }));

  expect(html).toContain("上下文洞察面板数据不完整或不一致");
  expect(html).not.toContain("800 tokens");
  expect(html).not.toContain("10%");
});

test("does not render annotations from another or closed session", () => {
  const panel = {
    id: "annotation-panel",
    pluginId: "@pi-harness/plugin-annotation",
    title: "Annotations",
    data: {
      sessionId: "previous-session",
      count: 1,
      annotations: [{ id: 1, quote: "private previous-session text", note: "private note", createdAt: "2026-09-12T00:00:00.000Z" }],
      lastPrompt: "private generated prompt",
    },
  };

  const staleHtml = renderToStaticMarkup(createElement(PluginPanelCard, { activeSessionId: "active-session", panel }));
  const closedHtml = renderToStaticMarkup(createElement(PluginPanelCard, { panel }));

  for (const html of [staleHtml, closedHtml]) {
    expect(html).toContain("批注面板数据不完整或不一致");
    expect(html).not.toContain("private previous-session text");
    expect(html).not.toContain("private generated prompt");
  }
});

test("shows review locations and prioritizes errors in the visible findings", () => {
  const html = renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "reviewer-bot-panel",
        pluginId: "@pi-harness/plugin-reviewer-bot",
        title: "Reviewer Bot",
        data: {
          latest: {
            cwd: "/workspace/active",
            status: "error",
            changedFiles: 1,
            findingCount: 6,
            addedLines: 6,
            removedLines: 0,
            findings: [
              ...Array.from({ length: 5 }, (_, index) => ({ severity: "warning", message: `warning-${index}`, path: "notes.txt" })),
              { severity: "error", message: "credential pattern", path: "current.ts" },
            ],
          },
        },
      },
    }),
  );
  expect(html).toContain("/workspace/active");
  expect(html).toContain("current.ts");
  expect(html).toContain("credential pattern");
  expect(html).toContain("4/6");
  expect(html).not.toContain("warning-3");
});
