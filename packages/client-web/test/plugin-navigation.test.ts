import { describe, expect, it } from "vitest";
import {
  installedPluginDetailPath,
  navigateBackFromPluginDetail,
  pluginDetailBackAction,
  pluginDetailHistoryState,
  pluginRoutePath,
  pushSessionViewRoute,
  readInstalledPluginDetailId,
  settingsRoutePath,
  settingsCloseAction,
  syncPluginRouteHistory,
  writePluginRouteHistory,
  writeSettingsRouteHistory,
  type PluginCollectionPage,
} from "../src/plugin-navigation.js";

class MemoryHistory {
  readonly entries: { state: unknown; url: string }[];
  backCalls = 0;
  index = 0;

  constructor(url = "/?page=session&session=relay.jsonl", state: unknown = null) {
    this.entries = [{ state, url }];
  }

  get state(): unknown {
    return this.entries[this.index]?.state;
  }

  get url(): string {
    return this.entries[this.index]?.url ?? "";
  }

  pushState(state: unknown, _unused: string, url?: string | URL | null): void {
    this.entries.splice(this.index + 1);
    this.entries.push({ state, url: String(url ?? this.url) });
    this.index += 1;
  }

  replaceState(state: unknown, _unused: string, url?: string | URL | null): void {
    this.entries[this.index] = { state, url: String(url ?? this.url) };
  }

  back(): void {
    this.backCalls += 1;
    this.index = Math.max(0, this.index - 1);
  }
}

describe("client navigation", () => {
  it("pushes session view changes so browser history traverses each tab", () => {
    const history = new MemoryHistory("/console?page=session&session=relay.jsonl#events", { unrelated: "keep" });
    const location = () => new URL(history.url, "https://example.test");

    pushSessionViewRoute(history, location(), "trajectory");
    pushSessionViewRoute(history, location(), "files");

    expect(history.entries).toHaveLength(3);
    expect(history.state).toEqual({ unrelated: "keep" });
    expect(history.url).toBe("/console?page=session&session=relay.jsonl&view=files#events");
    history.back();
    expect(history.url).toBe("/console?page=session&session=relay.jsonl&view=trajectory#events");
    history.back();
    expect(history.url).toBe("/console?page=session&session=relay.jsonl#events");
  });

  it("normalizes a session view route without pushing the active tab twice", () => {
    const history = new MemoryHistory("/console?page=session&session=relay.jsonl&view=files&settings=toml&plugin=prompt-guard&marketplaceQuery=guard#events");
    const location = () => new URL(history.url, "https://example.test");

    expect(pushSessionViewRoute(history, location(), "chat")).toBe(true);
    expect(history.url).toBe("/console?page=session&session=relay.jsonl&marketplaceQuery=guard#events");
    expect(pushSessionViewRoute(history, location(), "chat")).toBe(false);
    expect(history.entries).toHaveLength(2);
  });

  it("uses a stable secondary route for installed plugin details", () => {
    expect(installedPluginDetailPath("@pi-harness/plugin-docker-sandbox")).toBe("?page=plugins&plugin=%40pi-harness%2Fplugin-docker-sandbox");
  });

  it("only reads plugin details on the installed plugins page", () => {
    expect(readInstalledPluginDetailId(new URLSearchParams("page=plugins&plugin=docker-sandbox"))).toBe("docker-sandbox");
    expect(readInstalledPluginDetailId(new URLSearchParams("page=marketplace&plugin=docker-sandbox"))).toBeUndefined();
    expect(readInstalledPluginDetailId(new URLSearchParams("page=plugins&plugin=%20%20"))).toBeUndefined();
  });

  it("returns through the pushed parent list without leaving a duplicate history entry", () => {
    const installedState = pluginDetailHistoryState({ unrelated: "keep" }, "plugins");
    const marketplaceState = pluginDetailHistoryState(undefined, "marketplace");

    expect(installedState).toMatchObject({ unrelated: "keep" });
    expect(pluginDetailBackAction(installedState, "plugins")).toBe("back");
    expect(pluginDetailBackAction(installedState, "plugins", true)).toBe("ignore");
    expect(pluginDetailBackAction(marketplaceState, "marketplace")).toBe("back");
    expect(pluginDetailBackAction(installedState, "marketplace")).toBe("replace");
  });

  it("uses the list fallback for direct or untrusted detail history", () => {
    expect(pluginDetailBackAction(undefined, "plugins")).toBe("replace");
    expect(pluginDetailBackAction(null, "plugins")).toBe("replace");
    expect(pluginDetailBackAction("plugins", "plugins")).toBe("replace");
    expect(pluginDetailBackAction({ piHarnessPluginDetailParent: "elsewhere" }, "plugins")).toBe("replace");
  });

  it.each(["plugins", "marketplace"] as const)("runs the %s list-detail-back history workflow without a duplicate list", (parent) => {
    const history = new MemoryHistory();
    const list = pluginRoutePath({ pathname: "/", search: "?page=session&session=relay.jsonl", hash: "" }, parent);
    const detail = pluginRoutePath({ pathname: "/", search: list.slice(1), hash: "" }, parent, "plugin-id");
    writePluginRouteHistory(history, list, parent, undefined, "push");
    writePluginRouteHistory(history, detail, parent, "plugin-id", "push");
    syncPluginRouteHistory(history, `${detail}&refreshed=1`);

    let pending = false;
    const fallback: PluginCollectionPage[] = [];
    const navigate = () =>
      navigateBackFromPluginDetail(
        history,
        parent,
        pending,
        () => {
          pending = true;
        },
        (page) => fallback.push(page),
      );

    expect(navigate()).toBe("back");
    expect(history.url).toBe(list);
    expect(navigate()).toBe("ignore");
    expect(history.url).toBe(list);
    expect(fallback).toEqual([]);

    pending = false; // The component releases the guard when this back emits popstate.
    history.back();
    expect(history.url).toBe("/?page=session&session=relay.jsonl");
  });

  it.each(["plugins", "marketplace"] as const)("replaces a direct %s detail link with its safe list fallback", (parent) => {
    const detail = pluginRoutePath({ pathname: "/", search: "?page=session&session=relay.jsonl", hash: "#trace" }, parent, "plugin-id");
    const history = new MemoryHistory(detail);
    const fallback = (page: PluginCollectionPage) =>
      writePluginRouteHistory(
        history,
        pluginRoutePath({ pathname: "/", search: new URL(detail, "https://example.test").search, hash: "#trace" }, page),
        page,
        undefined,
        "replace",
      );

    expect(navigateBackFromPluginDetail(history, parent, false, () => {}, fallback)).toBe("replace");
    expect(history.entries).toHaveLength(1);
    expect(new URL(history.url, "https://example.test").searchParams.get("plugin")).toBeNull();
    expect(new URL(history.url, "https://example.test").searchParams.get("session")).toBe("relay.jsonl");
    expect(history.url).toMatch(/#trace$/u);
  });

  it("preserves session and marketplace state while constructing plugin routes", () => {
    const path = pluginRoutePath(
      {
        pathname: "/console",
        search: "?page=session&settings=general&session=relay.jsonl&marketplaceQuery=guard&capability=read-only&category=security&marketplacePage=3",
        hash: "#events",
      },
      "marketplace",
      "prompt-guard",
    );
    const url = new URL(path, "https://example.test");

    expect(url.pathname).toBe("/console");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: "marketplace",
      session: "relay.jsonl",
      marketplaceQuery: "guard",
      capability: "read-only",
      category: "security",
      marketplacePage: "3",
      plugin: "prompt-guard",
    });
    expect(url.hash).toBe("#events");
  });

  it("adds settings to the current in-app route without dropping plugin context", () => {
    const history = new MemoryHistory("/console?page=plugins&session=relay.jsonl#events");
    const settings = settingsRoutePath({ pathname: "/console", search: "?page=plugins&session=relay.jsonl", hash: "#events" }, "general");

    writeSettingsRouteHistory(history, settings, "push");

    expect(history.entries).toHaveLength(2);
    expect(settingsCloseAction(history.state, false)).toBe("back");
    expect(settingsCloseAction(history.state, true)).toBe("ignore");
    expect(history.state).toMatchObject({ piHarnessSettingsEntry: true });
    expect(history.url).toBe("/console?page=plugins&session=relay.jsonl&settings=general#events");
    history.back();
    expect(history.backCalls).toBe(1);
    expect(history.url).toBe("/console?page=plugins&session=relay.jsonl#events");
  });

  it("retains plugin detail state while marking a pushed settings entry", () => {
    const history = new MemoryHistory("/console?page=plugins&plugin=prompt-guard", { piHarnessPluginDetailParent: "plugins" });
    writeSettingsRouteHistory(history, "/console?page=plugins&plugin=prompt-guard&settings=general", "push");
    expect(history.state).toMatchObject({ piHarnessPluginDetailParent: "plugins", piHarnessSettingsEntry: true });
  });

  it("replaces direct settings links instead of leaving the console", () => {
    expect(settingsCloseAction(null, false)).toBe("replace");
    expect(settingsCloseAction({ piHarnessSettingsEntry: false }, false)).toBe("replace");
  });
});
