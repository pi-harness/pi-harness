import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { ClientMarketplacePlugin, ClientPiConfig } from "../src/control-room.js";
import { ChatTurnArticle, marketplaceDetailPlan, reloadRuntimeConfig, shouldRefreshForRuntimeEvent, subscribeRuntimeEvents } from "../src/react-room.js";

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
