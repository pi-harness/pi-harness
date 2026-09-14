export type PluginCollectionPage = "plugins" | "marketplace";

export interface PluginHistory {
  readonly state: unknown;
  back(): void;
  pushState(state: unknown, unused: string, url?: string | URL | null): void;
  replaceState(state: unknown, unused: string, url?: string | URL | null): void;
}

export interface PluginRouteLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

const PLUGIN_DETAIL_PARENT_STATE_KEY = "piHarnessPluginDetailParent";
const SETTINGS_ENTRY_STATE_KEY = "piHarnessSettingsEntry";

/** Marks a detail entry with the list that pushed it, while retaining state owned by another in-page feature. */
export function pluginDetailHistoryState(state: unknown, parent: PluginCollectionPage): Readonly<Record<string, unknown>> {
  const current = typeof state === "object" && state !== null && !Array.isArray(state) ? state : {};
  return { ...current, [PLUGIN_DETAIL_PARENT_STATE_KEY]: parent };
}

/** A known in-app detail entry can return through its parent; a direct link must use the safe list fallback instead of leaving the console. */
export function pluginDetailBackAction(state: unknown, parent: PluginCollectionPage, pending = false): "back" | "replace" | "ignore" {
  if (pending) return "ignore";
  if (typeof state !== "object" || state === null || Array.isArray(state)) return "replace";
  return (state as Record<string, unknown>)[PLUGIN_DETAIL_PARENT_STATE_KEY] === parent ? "back" : "replace";
}

export function pluginRoutePath(location: PluginRouteLocation, parent: PluginCollectionPage, pluginId?: string): string {
  const params = new URLSearchParams(location.search);
  params.set("page", parent);
  params.delete("settings");
  if (pluginId) params.set("plugin", pluginId);
  else params.delete("plugin");
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

export function settingsRoutePath(location: PluginRouteLocation, tab: string | undefined): string {
  const params = new URLSearchParams(location.search);
  if (tab) params.set("settings", tab);
  else params.delete("settings");
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

export function writeSettingsRouteHistory(history: PluginHistory, route: string, mode: "push" | "replace"): void {
  const current = typeof history.state === "object" && history.state !== null && !Array.isArray(history.state) ? history.state : {};
  const state = mode === "push" ? { ...(current as Record<string, unknown>), [SETTINGS_ENTRY_STATE_KEY]: true } : history.state;
  if (mode === "replace") history.replaceState(state, "", route);
  else history.pushState(state, "", route);
}

export function settingsCloseAction(state: unknown, pending: boolean): "back" | "replace" | "ignore" {
  if (pending) return "ignore";
  return typeof state === "object" && state !== null && !Array.isArray(state) && (state as Record<string, unknown>)[SETTINGS_ENTRY_STATE_KEY] === true
    ? "back"
    : "replace";
}

export function writePluginRouteHistory(
  history: PluginHistory,
  route: string,
  parent: PluginCollectionPage,
  pluginId: string | undefined,
  mode: "push" | "replace",
): void {
  const state = pluginId ? pluginDetailHistoryState(history.state, parent) : null;
  if (mode === "replace") history.replaceState(state, "", route);
  else history.pushState(state, "", route);
}

/** Keeps the detail marker across the URL-sync render that follows pushState, including after a page reload. */
export function syncPluginRouteHistory(history: PluginHistory, route: string): void {
  history.replaceState(history.state, "", route);
}

export function navigateBackFromPluginDetail(
  history: PluginHistory,
  parent: PluginCollectionPage,
  pending: boolean,
  onBackStarted: () => void,
  fallback: (parent: PluginCollectionPage) => void,
): "back" | "replace" | "ignore" {
  const action = pluginDetailBackAction(history.state, parent, pending);
  if (action === "back") {
    onBackStarted();
    history.back();
  } else if (action === "replace") {
    fallback(parent);
  }
  return action;
}

export function installedPluginDetailPath(packageName: string): string {
  return `?page=plugins&plugin=${encodeURIComponent(packageName)}`;
}

export function readInstalledPluginDetailId(params: URLSearchParams): string | undefined {
  if (params.get("page") !== "plugins") return undefined;
  const id = params.get("plugin")?.trim();
  return id || undefined;
}
