import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

const customType = "pi-harness/theme-studio";

export type ThemeId = "light" | "midnight" | "paper" | "high-contrast";
export type ThemePreset = { label: string; description: string; tokens: Readonly<Record<string, string>> };
export type ThemeState = {
  sessionId: string;
  theme: ThemeId;
  label: string;
  description: string;
  tokens: Readonly<Record<string, string>>;
  changed: boolean;
  changedAt: string | null;
};

export const themePresets: Readonly<Record<ThemeId, ThemePreset>> = {
  light: {
    label: "Light",
    description: "默认浅色界面，适合长时间编码。",
    tokens: {
      "--color-green-soft": "#f0fbf4",
      "--color-red-soft": "#fff5f5",
      "--color-amber-soft": "#fff9ed",
      "--color-surface": "#ffffff",
      "--color-inverse": "#ffffff",
      "--color-ink": "#0f1115",
      "--color-muted": "#65707b",
      "--color-faint": "#687381",
      "--color-line": "rgba(15,17,21,0.12)",
      "--color-soft": "#f6f8fa",
      "--color-blue": "#3565c5",
      "--color-blue-soft": "#edf3fe",
      "--color-green": "#14733f",
      "--color-red": "#b42318",
      "--color-amber": "#754c00",
      "--color-empty": "#9aa0a6",
      "--color-starter-border": "rgba(15,17,21,0.14)",
    },
  },
  midnight: {
    label: "Midnight",
    description: "深色工作台，降低夜间屏幕亮度。",
    tokens: {
      "--color-green-soft": "#123524",
      "--color-red-soft": "#3b1d25",
      "--color-amber-soft": "#382c17",
      "--color-surface": "#0b1220",
      "--color-inverse": "#0b1220",
      "--color-ink": "#f8fafc",
      "--color-muted": "#b7c2d1",
      "--color-faint": "#8290a3",
      "--color-line": "rgba(226,232,240,0.18)",
      "--color-soft": "#111827",
      "--color-blue": "#8ab4ff",
      "--color-blue-soft": "#1e3a67",
      "--color-green": "#58d68d",
      "--color-red": "#ff8a8a",
      "--color-amber": "#f6c56a",
      "--color-empty": "#778399",
      "--color-starter-border": "rgba(226,232,240,0.22)",
    },
  },
  paper: {
    label: "Paper",
    description: "暖白纸张色调，适合阅读和文档整理。",
    tokens: {
      "--color-green-soft": "#edf3e8",
      "--color-red-soft": "#f9e9e3",
      "--color-amber-soft": "#f6ecd6",
      "--color-surface": "#fffaf2",
      "--color-inverse": "#fffaf2",
      "--color-ink": "#332b24",
      "--color-muted": "#76695d",
      "--color-faint": "#76695d",
      "--color-line": "rgba(82,63,45,0.16)",
      "--color-soft": "#f5f0e8",
      "--color-blue": "#78572c",
      "--color-blue-soft": "#eee2d0",
      "--color-green": "#37613a",
      "--color-red": "#a24438",
      "--color-amber": "#775019",
      "--color-empty": "#a59a8e",
      "--color-starter-border": "rgba(82,63,45,0.18)",
    },
  },
  "high-contrast": {
    label: "High Contrast",
    description: "更清晰的文本和边界，适合低视力场景。",
    tokens: {
      "--color-green-soft": "#e8f5eb",
      "--color-red-soft": "#fce8e8",
      "--color-amber-soft": "#fff3cd",
      "--color-surface": "#ffffff",
      "--color-inverse": "#ffffff",
      "--color-ink": "#000000",
      "--color-muted": "#262626",
      "--color-faint": "#4a4a4a",
      "--color-line": "rgba(0,0,0,0.36)",
      "--color-soft": "#eeeeee",
      "--color-blue": "#0047b3",
      "--color-blue-soft": "#dbeafe",
      "--color-green": "#0b6b2d",
      "--color-red": "#a40000",
      "--color-amber": "#754c00",
      "--color-empty": "#5c5c5c",
      "--color-starter-border": "rgba(0,0,0,0.42)",
    },
  },
};

export interface ThemeStudioPluginConfig {
  theme?: ThemeId;
}

export const Config: z<ThemeStudioPluginConfig> = z.object({
  theme: z.union(["light", "midnight", "paper", "high-contrast"]).default("light"),
});

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && Object.hasOwn(themePresets, value);
}

for (const preset of Object.values(themePresets)) {
  Object.freeze(preset.tokens);
  Object.freeze(preset);
}
Object.freeze(themePresets);
const failedManagers = new WeakMap<object, object | null>();
const writeFailureMessage = "Theme write failed; reopen the session from disk before using Theme Studio again";

function dataRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") throw new Error("Theme parameters must be a plain object");
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) throw new Error("Invalid object");
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new Error("Theme parameters must be an accessible plain object", { cause: error });
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !("value" in descriptors[key]!)) throw new Error("Theme parameters require string data properties");
    output[key] = descriptors[key].value;
  }
  return output;
}

export default {
  name: "pi-theme-studio",
  inject: ["piSession", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: ThemeStudioPluginConfig) {
    assertKnownConfigKeys("theme-studio", config, ["theme"]);
    const fallback = config.theme ?? "light";
    if (!isThemeId(fallback)) throw new Error("Invalid Theme Studio theme configuration");
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
    const checkCancelled = (signal?: AbortSignal): void => {
      if (signal?.aborted || lifecycle.signal.aborted) throw new Error("Theme request was cancelled");
    };
    const currentManager = () => context.get("piRuntime")?.session.sessionManager ?? context.piSession.manager;
    const state = (): ThemeState => {
      checkCancelled();
      const manager = currentManager();
      if (failedManagers.has(manager)) {
        if (failedManagers.get(manager) === manager.getHeader()) throw new Error(writeFailureMessage);
        failedManagers.delete(manager);
      }
      let theme = fallback;
      let changedAt: string | null = null;
      const entries = manager.getEntries();
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!;
        if (entry.type !== "custom" || entry.customType !== customType) continue;
        const data = dataRecord(entry.data);
        if (
          Object.keys(data).length !== 2 ||
          !isThemeId(data.theme) ||
          typeof data.changedAt !== "string" ||
          !Number.isFinite(Date.parse(data.changedAt)) ||
          new Date(data.changedAt).toISOString() !== data.changedAt
        )
          throw new Error("Invalid persisted Theme Studio selection");
        theme = data.theme;
        changedAt = data.changedAt;
        break;
      }
      return {
        ...themePresets[theme],
        tokens: { ...themePresets[theme].tokens },
        sessionId: manager.getSessionId(),
        theme,
        changed: changedAt !== null,
        changedAt,
      };
    };
    const execute = async (set: boolean, rawParams: unknown, signal?: AbortSignal): Promise<AgentToolResult<ThemeState>> => {
      checkCancelled(signal);
      const manager = currentManager(),
        header = manager.getHeader();
      await Promise.resolve();
      checkCancelled(signal);
      if (currentManager() !== manager || manager.getHeader() !== header) throw new Error("Theme session changed before execution");
      const params = dataRecord(rawParams);
      if (set ? Object.keys(params).length !== 1 || !isThemeId(params.theme) : Object.keys(params).length !== 0) throw new Error("Invalid theme parameters");
      state();
      if (set) {
        try {
          manager.appendCustomEntry(customType, { theme: params.theme, changedAt: new Date().toISOString() });
        } catch (error) {
          failedManagers.set(manager, header);
          throw new Error(writeFailureMessage, { cause: error });
        }
      }
      const details = state();
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    };
    const unregisterSet = context.piTools.register(
      defineTool({
        name: "theme_set",
        label: "Set UI theme",
        description: "Select one of the bounded Pi Harness theme presets and persist it in the current session.",
        promptSnippet: "switch the Pi Harness UI theme",
        parameters: Type.Object(
          { theme: Type.Union([Type.Literal("light"), Type.Literal("midnight"), Type.Literal("paper"), Type.Literal("high-contrast")]) },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        execute: (_toolCallId, params, signal) => execute(true, params, signal),
      }),
    );
    context.effect(() => unregisterSet);
    const unregisterStatus = context.piTools.register(
      defineTool({
        name: "theme_status",
        label: "Theme status",
        description: "Show the active theme preset and its UI color tokens.",
        promptSnippet: "inspect the active Pi Harness theme",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        execute: (_toolCallId, params, signal) => execute(false, params, signal),
      }),
    );
    context.effect(() => unregisterStatus);
    const disposePanel = context.piPluginUi.register({
      id: "theme-studio-panel",
      pluginId: "@pi-harness/plugin-theme-studio",
      title: "Theme Studio",
      description: "切换可审计的界面主题预设，选择会保存到当前 session。",
      icon: "◐",
      read: () => ({ ...state(), presets: Object.entries(themePresets).map(([id, preset]) => ({ id, label: preset.label, description: preset.description })) }),
    });
    context.effect(() => disposePanel);
  },
};
