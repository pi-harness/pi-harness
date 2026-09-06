import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const customType = "pi-harness/theme-studio";

export type ThemeId = "light" | "midnight" | "paper" | "high-contrast";
export type ThemePreset = { label: string; description: string; tokens: Readonly<Record<string, string>> };
export type ThemeState = {
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
      "--color-ink": "#0f1115",
      "--color-muted": "#65707b",
      "--color-faint": "#8a949f",
      "--color-line": "rgba(15,17,21,0.12)",
      "--color-soft": "#f6f8fa",
      "--color-blue": "#4176e6",
      "--color-blue-soft": "#edf3fe",
      "--color-green": "#22c55e",
      "--color-red": "#ec1313",
      "--color-amber": "#f59e0b",
      "--color-empty": "#9aa0a6",
      "--color-starter-border": "rgba(15,17,21,0.14)",
    },
  },
  midnight: {
    label: "Midnight",
    description: "深色工作台，降低夜间屏幕亮度。",
    tokens: {
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
      "--color-ink": "#332b24",
      "--color-muted": "#76695d",
      "--color-faint": "#a09589",
      "--color-line": "rgba(82,63,45,0.16)",
      "--color-soft": "#f5f0e8",
      "--color-blue": "#876334",
      "--color-blue-soft": "#eee2d0",
      "--color-green": "#5f8b61",
      "--color-red": "#b85b4f",
      "--color-amber": "#b17b36",
      "--color-empty": "#a59a8e",
      "--color-starter-border": "rgba(82,63,45,0.18)",
    },
  },
  "high-contrast": {
    label: "High Contrast",
    description: "更清晰的文本和边界，适合低视力场景。",
    tokens: {
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

function initialTheme(context: Context, fallback: ThemeId): ThemeId {
  const entries = context.piSession.manager.getEntries();
  const entry = [...entries].reverse().find((item) => item.type === "custom" && item.customType === customType);
  if (entry?.type !== "custom" || entry.data === undefined || typeof entry.data !== "object" || entry.data === null) return fallback;
  const selected = (entry.data as { theme?: unknown }).theme;
  return isThemeId(selected) ? selected : fallback;
}

export default {
  name: "pi-theme-studio",
  inject: ["piSession", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: ThemeStudioPluginConfig) {
    let theme = initialTheme(context, config.theme ?? "light");
    let changedAt: string | null = null;
    const state = (): ThemeState => ({ ...themePresets[theme], theme, changed: changedAt !== null, changedAt });
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
        execute(_toolCallId, params): Promise<AgentToolResult<ThemeState>> {
          theme = params.theme;
          changedAt = new Date().toISOString();
          context.piSession.manager.appendCustomEntry(customType, { theme });
          const details = state();
          return Promise.resolve({ content: [{ type: "text", text: `Theme selected: ${details.label}` }], details });
        },
      }),
    );
    const unregisterStatus = context.piTools.register(
      defineTool({
        name: "theme_status",
        label: "Theme status",
        description: "Show the active theme preset and its UI color tokens.",
        promptSnippet: "inspect the active Pi Harness theme",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        execute(): Promise<AgentToolResult<ThemeState>> {
          const details = state();
          return Promise.resolve({ content: [{ type: "text", text: `${details.label}: ${details.description}` }], details });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "theme-studio-panel",
      pluginId: "@pi-harness/core/plugins/theme-studio",
      title: "Theme Studio",
      description: "切换可审计的界面主题预设，选择会保存到当前 session。",
      icon: "◐",
      read: () => ({ ...state(), presets: Object.entries(themePresets).map(([id, preset]) => ({ id, label: preset.label, description: preset.description })) }),
    });
    context.effect(() => () => {
      unregisterSet();
      unregisterStatus();
      disposePanel();
    });
  },
};
