import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  createClientApi,
  failedRefreshLabels,
  type ClientApi,
  type ClientCommand,
  type ClientFile,
  type ClientMarketplaceCapability,
  type ClientMarketplaceCategory,
  type ClientMarketplacePlugin,
  type ClientModel,
  type ClientPiConfig,
  type ClientPlugin,
  type ClientPluginPanel,
  type ClientProvider,
  type ClientSession,
  type ClientStatus,
  type ClientWorkspace,
} from "./control-room.js";
import { getPromptCompletion, replacePromptCompletion, type PromptCompletionKind } from "./prompt-completion.js";
import { compactThinkingEvents, eventKindLabel, eventOrigin, eventOutputText, formatEventClock, formatEventDuration } from "./runtime-events.js";
import { MarkdownMessage } from "./markdown.js";
import { type ChatToolCall, messageText, messageThinking, projectChatTurns } from "./message-content.js";
import { formatAnnotationPrompt, parseAnnotationPrompt, type ClientAnnotation } from "./annotation-ui.js";
import {
  marketplaceCapabilityLabeller,
  marketplaceCategoryTabs,
  marketplaceDetailPath,
  marketplaceStatisticItems,
  readMarketplaceDetailId,
} from "./marketplace-navigation.js";
import { loadMarketplaceCatalog } from "./marketplace-catalog.js";
import { pluginStarsPanelView } from "./plugin-stars-view.js";
import { pluginDevPanelView } from "./plugin-dev-view.js";
import { atFilePanelView } from "./at-file-view.js";
import { testHarnessPanelView } from "./test-harness-view.js";
import { sessionInsightsPanelView } from "./session-insights-view.js";
import { yamlValidatorPanelView } from "./yaml-validator-view.js";
import { browserFetchPanelView } from "./browser-fetch-view.js";
import { browserSessionPanelView } from "./browser-session-view.js";
import { cleanerPanelView } from "./cleaner-view.js";
import { matchesPluginQuery } from "./plugin-search.js";
import { readInstalledPluginDetailId } from "./plugin-navigation.js";
import { installedPluginCardContent } from "./plugin-card.js";
import { costMeterPanelView } from "./cost-meter-view.js";
import { dependencyCheckerPanelView } from "./dependency-checker-view.js";
import { dockerSandboxPanelView } from "./docker-sandbox-view.js";
import { failLoggerPanelView } from "./fail-logger-view.js";
import { genUiPanelView } from "./genui-view.js";
import { gitTimeCapsulePanelView } from "./git-time-capsule-view.js";
import { graphMemoryPanelView } from "./graph-memory-view.js";
import { i18nPairPanelView } from "./i18n-pair-view.js";
import { mcpClientPanelView } from "./mcp-client-view.js";
import { openPetsPanelView } from "./openpets-view.js";
import { recallUnreadPanelView } from "./recall-unread-view.js";
import { turnRewindPanelView } from "./turn-rewind-view.js";
import { contextDoctorPanelView } from "./context-doctor-view.js";
import { contextInsightsPanelView } from "./context-insights-view.js";
import { tokenGuardPanelView } from "./token-guard-view.js";
import { sessionBridgePanelView } from "./session-bridge-view.js";
import { skillGuardPanelView } from "./skill-guard-view.js";
import { sqlLensPanelView } from "./sql-lens-view.js";
import { agentTeamsPanelView } from "./agent-teams-view.js";
import { modlensPanelView } from "./modlens-view.js";
import { visionToolkitPanelView } from "./vision-toolkit-view.js";
import { readmeGenPanelView } from "./readme-gen-view.js";

export type { ClientApi } from "./control-room.js";

type View = "chat" | "trajectory" | "files";
type SettingsTab = "general" | "providers" | "toml";
type Page = "session" | "plugins" | "marketplace";
interface RoomData {
  status?: ClientStatus;
  session?: ClientSession;
  sessions: readonly Record<string, unknown>[];
  files: readonly ClientFile[];
  models: readonly ClientModel[];
  providers: readonly ClientProvider[];
  plugins: readonly ClientPlugin[];
  pluginPanels: readonly ClientPluginPanel[];
  marketplace: readonly ClientMarketplacePlugin[];
  marketplaceCapabilities: readonly ClientMarketplaceCapability[];
  marketplaceCategories: readonly ClientMarketplaceCategory[];
  marketplaceTotal: number;
  marketplacePage: number;
  marketplaceHasNext: boolean;
  commands: readonly ClientCommand[];
  workspaces: readonly ClientWorkspace[];
}

const value = (input: unknown, fallback = "—"): string => {
  if (input === undefined || input === null || input === "") return fallback;
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") return String(input);
  try {
    return JSON.stringify(input);
  } catch {
    return fallback;
  }
};

const dialogFocusSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function useModalFocus(open: boolean, onClose: () => void, busy = false, returnFocusSelector?: string) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    if (!open) return;
    const activeElement = document.activeElement;
    const previous =
      activeElement instanceof HTMLElement && activeElement !== document.body && activeElement !== document.documentElement ? activeElement : undefined;
    const focusable = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(dialogFocusSelector) ?? []).filter(
        (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0,
      );
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(document.activeElement)) return;
      (dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? focusable()[0])?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, true);
      const returnFocus = previous?.isConnected ? previous : returnFocusSelector ? document.querySelector<HTMLElement>(returnFocusSelector) : undefined;
      if (returnFocus) window.requestAnimationFrame(() => returnFocus.focus());
    };
  }, [open, returnFocusSelector]);
  return dialogRef;
}
const sessionSource = (status: ClientStatus | undefined, session: ClientSession | undefined): string =>
  status?.cwd ?? (typeof session?.sessionFile === "string" ? session.sessionFile : "未选择工作区");
const EVENT_LABEL_LIMIT = 120;
const eventLabel = (event: Record<string, unknown>): string => {
  const type = value(event.type, "");
  if (type === "file_diff") return "文件差异";
  if (type === "file") return "文件详情";
  if (typeof event.summary === "string" && event.summary !== "") return previewText(event.summary, EVENT_LABEL_LIMIT);
  // The whole message object used to be stringified into this cell, which filled the column with protocol and buried the one line a reader is looking for.
  const message = typeof event.message === "object" && event.message !== null ? (event.message as Record<string, unknown>) : undefined;
  if (message !== undefined) {
    const role = value(message.role, "message");
    const text = messageText(message) || messageThinking(message);
    return text ? previewText(`${role}: ${text}`, EVENT_LABEL_LIMIT) : role;
  }
  // A tool row that prints only the tool's name repeats the 产生者 column beside it; the arguments say which file was read and the result says what came back.
  if (typeof event.toolName === "string" && event.toolName !== "") {
    const detail = event.args !== undefined ? toolArgumentSummary(event.args) : previewText(eventOutputText(event.result) ?? "", EVENT_LABEL_LIMIT);
    return detail ? previewText(`${event.toolName} · ${detail}`, EVENT_LABEL_LIMIT) : event.toolName;
  }
  return eventKindLabel(type);
};
const capability = (name: string): string => {
  const entries: readonly [string, string][] = [
    ["context", "上下文"],
    ["agent-teams", "协作"],
    ["modlens", "视觉"],
    ["token-guard", "预算"],
    ["git-time-capsule", "版本控制"],
    ["dependency-checker", "工程诊断"],
    ["at-file", "文件上下文"],
    ["test-harness", "测试"],
    ["session-insights", "会话统计"],
    ["session-compare", "会话对比"],
    ["secure-audit", "安全审计"],
    ["readme-gen", "文档生成"],
    ["i18n-pair", "国际化"],
    ["cleaner", "清理"],
    ["sql-lens", "数据库"],
    ["docker-sandbox", "沙箱"],
    ["mcp-client", "工具协议"],
    ["mcp-panel", "MCP 控制台"],
    ["browser-fetch", "网页抓取"],
    ["web-research", "联网研究"],
    ["browser-session", "浏览器会话"],
    ["yaml-validator", "配置校验"],
    ["mock-server", "接口模拟"],
    ["cli-notifier", "桌面通知"],
    ["obsidian-sync", "知识库"],
    ["context-doctor", "上下文诊断"],
    ["history-compressor", "历史压缩"],
    ["reviewer-bot", "代码审查"],
    ["auto-mode", "安全执行"],
    ["plan-execute", "计划执行"],
    ["plugin-finder", "插件发现"],
    ["taskboard", "任务看板"],
    ["synapse", "会话地图"],
    ["hol-guard", "安全防护"],
    ["plugin-radar", "生态雷达"],
    ["plugin-stars", "排行榜"],
    ["plugin-check", "插件体检"],
    ["annotation", "批注上下文"],
    ["cost-meter", "成本账本"],
    ["undo-savepoint", "恢复保存点"],
    ["skill-catalog", "技能目录"],
    ["graph-memory", "知识图谱"],
    ["memory", "跨会话记忆"],
    ["canvas-draw", "流程图"],
    ["image-compressor", "图片压缩"],
    ["workspace-search", "工作区检索"],
    ["prompt-guard", "提示词防护"],
    ["code2skill", "技能打包"],
    ["tab-manager", "会话标签"],
    ["genui", "结构化界面"],
    ["anchored-standard", "轨迹锚定"],
    ["telemetry-blocker", "遥测拦截"],
    ["change-verifier", "变更门禁"],
    ["plugin-dev", "插件开发"],
    ["openpets", "桌面伙伴"],
    ["vision-toolkit", "视觉素材"],
    ["session-bridge", "会话交接"],
    ["skill-guard", "Skill 安全"],
    ["recall-unread", "会话召回"],
    ["turn-rewind", "会话回退"],
    ["session-export", "会话导出"],
    ["session-search", "会话搜索"],
    ["session-bookmarks", "会话书签"],
    ["llm-verifier", "模型校验"],
    ["module-search", "模块检索"],
    ["workspace-navigator", "工作区导航"],
    ["better-sidebar", "侧栏概览"],
    ["archify", "架构地图"],
    ["mirage-bridge", "Mirage 虚拟终端"],
    ["theme-studio", "主题"],
    ["reverse-skill", "技能隔离"],
    ["colleague-skill", "角色交接"],
    ["prompt-library", "提示词库"],
    ["model", "模型"],
    ["tool", "工具"],
    ["session", "会话"],
    ["resource", "资源"],
    ["web", "界面"],
    ["gateway", "界面"],
  ];
  return entries.find(([needle]) => name.includes(needle))?.[1] ?? "运行时";
};
// The state the gateway reports for a plugin that is installed in the profile but has no loader entry yet, which is every marketplace install until the next start.
const RESTART_REQUIRED_PLUGIN_STATE = "restart-required";
// The runtime leases the tool registry for its whole life and snapshots the tool set when it takes it, so a plugin that contributes tools joins on the next start rather than immediately. The notice names no start command because the harness is reachable through more than one of them, and it covers enabling as well as installing because both actions share it.
const RESTART_REQUIRED_NOTICE =
  "改动已写入 profile（~/.pi-harness/profiles/<profile>/cordis.yml）。控制台无法自行重启，请回到启动 Pi Harness 的终端按 Ctrl-C，再用原来的命令重新启动；在那之前这次改动不会生效，刚安装的插件也不会出现在「已安装」列表里。";

// The HTTP API answers in English because it is a public contract, while every label in this console is Chinese, so the fixed error strings the plugin endpoints can return are translated here and told what to do next. Anything else is passed through untouched.
const PLUGIN_ACTION_ERROR_TEXT = new Map([
  ["Another marketplace plugin change is already running", "已有插件操作正在进行，请等它完成后重试。"],
  ["Plugin installation is unavailable for this runtime", "当前运行时不支持安装插件：请用带 profile 的方式启动 Pi Harness 后重试。"],
  ["Plugin configuration is unavailable for this runtime", "当前运行时不支持修改插件配置：请用带 profile 的方式启动 Pi Harness 后重试。"],
  ["Plugin is already installed", "这个插件已经安装过了，可以在「已安装」列表里管理它。"],
  ["Marketplace plugin was not found", "插件市场里没有这个插件，它可能已经下架，请刷新页面。"],
  ["Installed plugin was not found", "运行配置里没有这个插件，它可能已被移除，请刷新页面。"],
  ["Built-in plugins cannot be changed", "内置插件由运行时管理，不能启用或停用。"],
  ["Only marketplace plugins can be uninstalled", "只有从插件市场安装的插件才能卸载。"],
]);

export function pluginActionErrorText(message: string): string {
  const text = message.trim();
  const mapped = PLUGIN_ACTION_ERROR_TEXT.get(text);
  if (mapped !== undefined) return mapped;
  const status = /^Request failed with status (\d+)$/u.exec(text);
  if (status !== null) return `请求失败（HTTP ${status[1]}）：请确认 Pi Harness 仍在运行，然后重试。`;
  return message;
}

// Ctrl-C is the reflex for stopping a runaway agent, but the same chord is the copy shortcut everywhere else in the browser, so it only interrupts when a run is actually in flight and nothing is selected. Cmd is excluded on purpose: matching it would swallow macOS Cmd+C. A textarea or an input keeps a selection that window.getSelection() does not report, so the focused field is asked directly.
export function shouldInterruptRun(
  event: { readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean; readonly key: string; readonly target: EventTarget | null },
  running: boolean,
  selectedText: string,
): boolean {
  if (!running || !event.ctrlKey || event.metaKey || event.shiftKey || event.key.toLowerCase() !== "c") return false;
  if (selectedText.trim().length > 0) return false;
  const field = event.target as { selectionStart?: unknown; selectionEnd?: unknown } | null;
  return !(typeof field?.selectionStart === "number" && typeof field.selectionEnd === "number" && field.selectionStart !== field.selectionEnd);
}

// Picking a command out of a palette adds to what the user already wrote instead of replacing it: the draft is the reason they went looking for the command name in the first place.
export function insertCommandDraft(draft: string, caret: number, value: string): { text: string; caret: number } {
  const position = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, position);
  const insertion = `${before && !/\s$/u.test(before) ? " " : ""}${value} `;
  return { text: `${before}${insertion}${draft.slice(position)}`, caret: before.length + insertion.length };
}

// A plugin that needs a restart is installed on disk but absent from every list the gateway builds from the loader, so the console remembers it here to keep saying so across reloads. localStorage is already scoped to the origin serving this console, and one origin is one harness process, so the set needs no key of its own; the profile path the gateway installs into is not exposed over the API.
const RESTART_PENDING_STORAGE_KEY = "pi-harness.restart-pending-plugins";

// The set is only true of the process that was running when the install happened. It is stored with that process's identity so the next start clears it: by then the plugin has either loaded, and shows up as installed, or it has not, and the card has to become installable again rather than stay disabled forever.
export interface RestartPendingState {
  readonly process: string;
  readonly packages: ReadonlySet<string>;
}

const EMPTY_RESTART_PENDING: RestartPendingState = { packages: new Set(), process: "" };

export function readRestartPendingPackages(storage: Pick<Storage, "getItem"> | undefined): RestartPendingState {
  if (storage === undefined) return EMPTY_RESTART_PENDING;
  try {
    const raw = storage.getItem(RESTART_PENDING_STORAGE_KEY);
    if (raw === null) return EMPTY_RESTART_PENDING;
    const parsed: unknown = JSON.parse(raw);
    // A value written before the process identity existed names no process, which reads as a foreign one and is therefore dropped on the first status the console receives.
    const record = (Array.isArray(parsed) ? { packages: parsed, process: "" } : parsed) as { packages?: unknown; process?: unknown };
    const packages = Array.isArray(record.packages) ? record.packages.filter((item): item is string => typeof item === "string") : [];
    return { packages: new Set(packages), process: typeof record.process === "string" ? record.process : "" };
  } catch {
    return EMPTY_RESTART_PENDING;
  }
}

export function writeRestartPendingPackages(storage: Pick<Storage, "setItem"> | undefined, state: RestartPendingState): void {
  if (storage === undefined) return;
  try {
    storage.setItem(RESTART_PENDING_STORAGE_KEY, JSON.stringify({ packages: [...state.packages], process: state.process }));
  } catch {
    // A console that cannot persist the pending set still has to run, so a full or blocked storage is not an error the user can act on.
  }
}

/** Keeps the set only while it still describes the process the console is talking to. An empty identity means the status has not arrived yet, and the set is left alone until it does. */
export function restartPendingForProcess(state: RestartPendingState, process: string): RestartPendingState {
  if (process === "" || state.process === process) return state;
  return state.packages.size === 0 ? { packages: state.packages, process } : { packages: new Set(), process };
}

// The same set instance comes back when nothing was installed since the last render, so the state that holds it does not change identity on every refresh.
export function withoutInstalledPackages(pending: ReadonlySet<string>, installed: ReadonlySet<string>): ReadonlySet<string> {
  const remaining = [...pending].filter((packageName) => !installed.has(packageName));
  return remaining.length === pending.size ? pending : new Set(remaining);
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const displayPluginName = (name: string): string => {
  const officialName = new Map([
    ["@pi-harness/plugin-context", "Context insights"],
    ["@pi-harness/plugin-agent-teams", "Agent Teams"],
    ["@pi-harness/plugin-modlens", "ModLens vision bridge"],
    ["@pi-harness/plugin-token-guard", "Token Guard"],
    ["@pi-harness/plugin-git-time-capsule", "Git Time Capsule"],
    ["@pi-harness/plugin-dependency-checker", "Dependency Checker"],
    ["@pi-harness/plugin-at-file", "@file context"],
    ["@pi-harness/plugin-fail-logger", "Failure Logger"],
    ["@pi-harness/plugin-test-harness", "Test Harness"],
    ["@pi-harness/plugin-session-insights", "Session Insights"],
    ["@pi-harness/plugin-session-compare", "Session Compare"],
    ["@pi-harness/plugin-secure-audit", "Secure Audit"],
    ["@pi-harness/plugin-readme-gen", "README Generator"],
    ["@pi-harness/plugin-i18n-pair", "I18n Pair"],
    ["@pi-harness/plugin-cleaner", "Harness Cleaner"],
    ["@pi-harness/plugin-sql-lens", "SQL Lens"],
    ["@pi-harness/plugin-docker-sandbox", "Docker Sandbox"],
    ["@pi-harness/plugin-mcp-client", "MCP Client"],
    ["@pi-harness/plugin-mcp-panel", "MCP Console"],
    ["@pi-harness/plugin-browser-fetch", "Browser Fetch"],
    ["@pi-harness/plugin-web-research", "Web Research"],
    ["@pi-harness/plugin-browser-session", "Browser Session"],
    ["@pi-harness/plugin-yaml-validator", "YAML Validator"],
    ["@pi-harness/plugin-mock-server", "Mock Server"],
    ["@pi-harness/plugin-cli-notifier", "CLI Notifier"],
    ["@pi-harness/plugin-obsidian-sync", "Obsidian Sync"],
    ["@pi-harness/plugin-context-doctor", "Context Doctor"],
    ["@pi-harness/plugin-history-compressor", "History Compressor"],
    ["@pi-harness/plugin-reviewer-bot", "Reviewer Bot"],
    ["@pi-harness/plugin-auto-mode", "Auto Mode"],
    ["@pi-harness/plugin-plan-execute", "Plan Execute"],
    ["@pi-harness/plugin-plugin-finder", "Plugin Finder"],
    ["@pi-harness/plugin-taskboard", "Taskboard"],
    ["@pi-harness/plugin-synapse", "Synapse"],
    ["@pi-harness/plugin-hol-guard", "HOL Guard"],
    ["@pi-harness/plugin-plugin-radar", "Plugin Radar"],
    ["@pi-harness/plugin-plugin-check", "Plugin Check"],
    ["@pi-harness/plugin-annotation", "Annotations"],
    ["@pi-harness/plugin-cost-meter", "Cost Meter"],
    ["@pi-harness/plugin-undo-savepoint", "Undo Savepoints"],
    ["@pi-harness/plugin-skill-catalog", "Skills Catalog"],
    ["@pi-harness/plugin-memory", "Memory"],
    ["@pi-harness/plugin-graph-memory", "Graph Memory"],
    ["@pi-harness/plugin-canvas-draw", "Canvas Draw"],
    ["@pi-harness/plugin-image-compressor", "Image Compressor"],
    ["@pi-harness/plugin-workspace-search", "Workspace Search"],
    ["@pi-harness/plugin-prompt-guard", "Prompt Guard"],
    ["@pi-harness/plugin-code2skill", "Code2Skill"],
    ["@pi-harness/plugin-tab-manager", "Session Tabs"],
    ["@pi-harness/plugin-genui", "GenUI"],
    ["@pi-harness/plugin-anchored-standard", "Anchored Standard"],
    ["@pi-harness/plugin-telemetry-blocker", "Telemetry Blocker"],
    ["@pi-harness/plugin-change-verifier", "Change Verifier"],
    ["@pi-harness/plugin-plugin-dev", "Plugin Dev"],
    ["@pi-harness/plugin-openpets", "OpenPets"],
    ["@pi-harness/plugin-vision-toolkit", "Vision Toolkit"],
    ["@pi-harness/plugin-plugin-stars", "Plugin Stars"],
    ["@pi-harness/plugin-session-bridge", "Session Bridge"],
    ["@pi-harness/plugin-skill-guard", "Skill Guard"],
    ["@pi-harness/plugin-recall-unread", "Recall Unread"],
    ["@pi-harness/plugin-turn-rewind", "Turn Rewind"],
    ["@pi-harness/plugin-session-export", "Session Export"],
    ["@pi-harness/plugin-session-search", "Session Search"],
    ["@pi-harness/plugin-session-bookmarks", "Session Bookmarks"],
    ["@pi-harness/plugin-llm-verifier", "LLM Verifier"],
    ["@pi-harness/plugin-module-search", "Module Search"],
    ["@pi-harness/plugin-workspace-navigator", "Workspace Navigator"],
    ["@pi-harness/plugin-better-sidebar", "Better Sidebar"],
    ["@pi-harness/plugin-archify", "Architecture Map"],
    ["@pi-harness/plugin-mirage-bridge", "Mirage Bridge"],
    ["@pi-harness/plugin-theme-studio", "Theme Studio"],
    ["@pi-harness/plugin-reverse-skill", "Reverse Skill Firewall"],
    ["@pi-harness/plugin-colleague-skill", "Colleague Skill"],
    ["@pi-harness/plugin-prompt-library", "Prompt Library"],
    ["@pi-harness/plugin-runtime-doctor", "Runtime Doctor"],
  ]).get(name);
  if (officialName !== undefined) return officialName;
  const packageMatch = name.match(/^@[^/]+\/cordis-plugin-(.+)$/i);
  if (packageMatch) return `官方 · ${packageMatch[1]}`;
  if (name.toLowerCase().includes("cordis")) return name.replace(/cordis/gi, "runtime");
  return name;
};
const readQueryState = (): {
  page: Page;
  view: View;
  settings?: SettingsTab;
  sessionPath?: string;
  marketplaceQuery: string;
  marketplaceCapability: string;
  marketplaceCategory: string;
  marketplacePlugin: string | undefined;
  installedPlugin: string | undefined;
  marketplacePage: number;
} => {
  if (typeof window === "undefined")
    return {
      page: "session",
      view: "chat",
      marketplaceQuery: "",
      marketplaceCapability: "",
      marketplaceCategory: "",
      marketplacePlugin: undefined,
      installedPlugin: undefined,
      marketplacePage: 0,
    };
  const params = new URLSearchParams(window.location.search);
  const page = params.get("page");
  const view = params.get("view");
  const settings = params.get("settings");
  const parsedPage = page === "plugins" || page === "marketplace" ? page : "session";
  const parsedView = view === "trajectory" || view === "files" ? view : "chat";
  const parsedSettings = settings === "providers" || settings === "toml" ? settings : settings === "general" ? settings : undefined;
  const pageNumber = Number.parseInt(params.get("marketplacePage") ?? "0", 10);
  return {
    page: parsedPage,
    view: parsedView,
    settings: parsedSettings,
    sessionPath: params.get("session") ?? undefined,
    marketplaceQuery: params.get("marketplaceQuery") ?? "",
    marketplaceCapability: params.get("capability") ?? "",
    marketplaceCategory: params.get("category") ?? "",
    marketplacePlugin: readMarketplaceDetailId(params),
    installedPlugin: readInstalledPluginDetailId(params),
    marketplacePage: Number.isFinite(pageNumber) && pageNumber >= 0 ? pageNumber : 0,
  };
};

function sessionGroups(sessions: readonly Record<string, unknown>[]): readonly [string, readonly Record<string, unknown>[]][] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = start - 86_400_000;
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const session of sessions) {
    const raw = session.modified ?? session.created;
    const timestamp = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    const label = Number.isFinite(timestamp) && timestamp >= start ? "今天" : Number.isFinite(timestamp) && timestamp >= yesterday ? "昨天" : "更早";
    groups.set(label, [...(groups.get(label) ?? []), session]);
  }
  return ["今天", "昨天", "更早"].flatMap((label) => {
    const items = groups.get(label);
    return items?.length ? [[label, items] as const] : [];
  });
}

function Workspace({
  status,
  workspaces,
  onCreate,
  onStarter,
  onToml,
}: {
  status: ClientStatus | undefined;
  workspaces: readonly ClientWorkspace[];
  onCreate: (workspace: ClientWorkspace) => void;
  onStarter: (value: string) => void;
  onToml: () => void;
}) {
  const starters: readonly [string, string][] = [
    ["定位问题", "分析当前仓库并给出根因"],
    ["修复并测试", "实现修复并运行相关测试"],
    ["审查改动", "只读检查未提交变更"],
    ["解释代码", "解释当前文件的关键逻辑"],
  ];
  return (
    <div className="new-session-screen">
      <div className="welcome-kicker">PI AGENT HARNESS · REAL RUNTIME</div>
      <div className="welcome-heading">
        <span className="pi-mark large" aria-hidden="true">
          <img src="/icons/svg/mark-white.svg" alt="" />
        </span>
        <div>
          <h2>开始一个工作会话</h2>
          <p>连接当前工作区，直接让 Pi agent 读取、修改并验证代码。</p>
        </div>
      </div>
      <div className="workspace-picker">
        {workspaces.length ? (
          workspaces.map((workspace) => (
            <button className="workspace-row" key={workspace.path} onClick={() => onCreate(workspace)} type="button">
              <span className={`workspace-status ${workspace.current ? "live" : "offline"}`}>{workspace.current ? "已连接" : "工作区"}</span>
              <span>
                <code>{workspace.path}</code>
                <small>{workspace.current && status ? `${workspace.branch} · ${status.model}` : workspace.branch}</small>
              </span>
              <span className="workspace-arrow">↗</span>
            </button>
          ))
        ) : (
          <div className="workspace-row is-empty">
            <span className="workspace-status offline">加载中</span>
            <span>
              <code>{status?.cwd ?? "加载工作区…"}</code>
              <small>正在读取 git worktree</small>
            </span>
          </div>
        )}
      </div>
      <div className="effective-config">
        <span className="config-label">当前运行时</span>
        <span>{status?.model ?? "由运行时提供"}</span>
        <span>{status ? `${status.messages} 条消息` : "—"}</span>
        <a
          href="#"
          onClick={(event) => {
            event.preventDefault();
            onToml();
          }}
        >
          改配置 ⌘,
        </a>
      </div>
      <div className="starter-grid">
        {starters.map(([title, prompt]) => (
          <button className="starter-card" key={title} onClick={() => onStarter(prompt)} type="button">
            <strong>{title}</strong>
            <small>{prompt}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function WorkspaceChooser({
  workspaces,
  onSelect,
  onPickDirectory,
  onClose,
  error,
}: {
  workspaces: readonly ClientWorkspace[];
  onSelect: (workspace: ClientWorkspace) => void;
  onPickDirectory: () => Promise<void>;
  onClose: () => void;
  error?: string;
}) {
  const dialogRef = useModalFocus(true, onClose);
  return (
    <div className="workspace-chooser" onClick={onClose}>
      <div
        aria-label="选择工作区"
        aria-modal="true"
        className="workspace-chooser-dialog"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="workspace-chooser-heading">
          <strong>新建会话</strong>
          <button aria-label="关闭工作区选择" onClick={onClose} type="button">
            ×
          </button>
        </div>
        <small>选择这个会话要使用的工作区</small>
        {error ? (
          <div className="workspace-chooser-error" role="alert">
            {error}
          </div>
        ) : null}
        <button className="workspace-pick-directory" data-dialog-initial-focus onClick={() => void onPickDirectory()} type="button">
          <span>打开目录</span>
          <small>从 Finder 选择一个新的工作目录</small>
        </button>
        <div className="workspace-chooser-divider">
          <span>或选择已有 worktree</span>
        </div>
        {workspaces.length ? (
          workspaces.map((workspace) => (
            <button className="workspace-chooser-row" key={workspace.path} onClick={() => onSelect(workspace)} type="button">
              <span className={`workspace-status ${workspace.current ? "live" : "offline"}`}>{workspace.current ? "当前" : "worktree"}</span>
              <span>
                <strong>{workspace.name}</strong>
                <code>{workspace.path}</code>
              </span>
              <small>{workspace.branch}</small>
            </button>
          ))
        ) : (
          <span className="workspace-chooser-empty">正在读取 git worktree…</span>
        )}
      </div>
    </div>
  );
}

function SessionDialog({
  kind,
  name,
  count,
  value: draft,
  busy,
  onChange,
  onClose,
  onConfirm,
}: {
  kind: "rename" | "delete" | "archive" | "batch-delete";
  name?: string;
  count?: number;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const destructive = kind === "delete" || kind === "batch-delete";
  const title = kind === "rename" ? "重命名会话" : kind === "archive" ? "归档会话" : destructive ? "删除会话" : "会话操作";
  const description =
    kind === "rename"
      ? "给这个会话一个容易识别的名称。"
      : kind === "archive"
        ? "归档后会从默认列表隐藏，之后仍可在会话工具中恢复。"
        : `将永久删除${count && count > 1 ? ` ${count} 个会话` : "这个会话"}及其本地记录，此操作不可撤销。`;
  const dialogRef = useModalFocus(true, onClose, busy, ".session-menu");
  return (
    <div
      className="session-dialog-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        aria-label={title}
        aria-modal="true"
        className="session-dialog"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="session-dialog-header">
          <div>
            <strong>{title}</strong>
            <small>{description}</small>
          </div>
          <button aria-label="关闭" disabled={busy} onClick={onClose} type="button">
            ×
          </button>
        </header>
        {kind === "rename" && (
          <label className="session-dialog-field">
            <span>名称</span>
            <input
              data-dialog-initial-focus
              disabled={busy}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && !busy && onConfirm()}
              value={draft}
            />
          </label>
        )}
        {name && kind !== "rename" && <div className="session-dialog-target">{name}</div>}
        <footer className="session-dialog-actions">
          <button data-dialog-initial-focus={kind !== "rename" ? "" : undefined} disabled={busy} onClick={onClose} type="button">
            取消
          </button>
          <button className={destructive ? "danger" : "primary"} disabled={busy || (kind === "rename" && !draft.trim())} onClick={onConfirm} type="button">
            {busy ? "处理中…" : kind === "rename" ? "保存名称" : kind === "archive" ? "归档" : "永久删除"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ConfirmDialog({
  title,
  description,
  target,
  confirmLabel,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  target?: string;
  confirmLabel: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useModalFocus(true, onClose, busy);
  return (
    <div
      className="session-dialog-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        aria-label={title}
        aria-modal="true"
        className="session-dialog"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="session-dialog-header">
          <div>
            <strong>{title}</strong>
            <small>{description}</small>
          </div>
          <button aria-label="关闭" disabled={busy} onClick={onClose} type="button">
            ×
          </button>
        </header>
        {target && <div className="session-dialog-target">{target}</div>}
        <footer className="session-dialog-actions">
          <button data-dialog-initial-focus disabled={busy} onClick={onClose} type="button">
            取消
          </button>
          <button className="danger" disabled={busy} onClick={onConfirm} type="button">
            {busy ? "处理中…" : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

function SessionActionMenu({
  busy,
  position,
  onRename,
  onFork,
  onArchive,
  onDelete,
}: {
  busy: boolean;
  position: { left: number; top: number };
  onRename: () => void;
  onFork: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return createPortal(
    <div className="session-row-menu-popover" data-session-popover onClick={(event) => event.stopPropagation()} role="menu" style={position}>
      <button autoFocus disabled={busy} onClick={onRename} role="menuitem" type="button">
        重命名
      </button>
      <button disabled={busy} onClick={onFork} role="menuitem" type="button">
        复制会话
      </button>
      <button disabled={busy} onClick={onArchive} role="menuitem" type="button">
        归档会话
      </button>
      <button className="danger" disabled={busy} onClick={onDelete} role="menuitem" type="button">
        删除会话
      </button>
    </div>,
    document.body,
  );
}

const sidebarPopoverPosition = (
  trigger: HTMLButtonElement,
  width: number,
  estimatedHeight: number,
  placement: "beside" | "below",
): { left: number; top: number } => {
  const rect = trigger.getBoundingClientRect();
  const gutter = 8;
  const spaceOnRight = window.innerWidth - rect.right - gutter;
  const left = spaceOnRight >= width ? rect.right + gutter : Math.max(gutter, rect.left - width - gutter);
  const preferredTop = placement === "below" ? rect.bottom + 6 : rect.top - 4;
  return {
    left: Math.round(left),
    top: Math.round(Math.min(Math.max(gutter, preferredTop), Math.max(gutter, window.innerHeight - estimatedHeight - gutter))),
  };
};

function PromptError({ message }: { message: string }) {
  const everyApiAuth = /No API key found for everyapi/i.test(message);
  const requiresAuth = everyApiAuth || /No API key found|authentication|未配置认证/i.test(message);
  return (
    <div className="action-error" role="alert">
      <div className="action-error-summary">
        <strong>{everyApiAuth ? "EveryAPI 认证未注入当前进程" : requiresAuth ? "模型尚未配置认证" : "发送失败"}</strong>
        <span>
          {everyApiAuth
            ? "请用 everyapi use pi-harness 启动，或设置 EVERYAPI_RELAY_KEY 后重启。"
            : requiresAuth
              ? "请在设置 → 提供商中配置 API key，然后重试。"
              : "运行时没有接受这次请求，请重试或查看错误详情。"}
        </span>
      </div>
      <details>
        <summary>查看原始错误</summary>
        <code>{message}</code>
      </details>
    </div>
  );
}

function UserMessageBubble({ text }: { text: string }) {
  const parsed = parseAnnotationPrompt(text);
  return (
    <div className="user-bubble">
      <span>{parsed.question}</span>
      {parsed.count > 0 ? (
        <span className="ml-2 inline-flex rounded-md bg-[#edf3fe] px-1.5 py-0.5 text-[10px] text-[#315fb8]">批注 ×{parsed.count}</span>
      ) : null}
    </div>
  );
}

function Details({ event, onClose, onCopy }: { event: Record<string, unknown> | undefined; onClose: () => void; onCopy: () => void }) {
  if (!event)
    return (
      <aside className="details-panel">
        <header>
          <strong>事件详情</strong>
          <button aria-label="关闭事件详情" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div className="details-body">
          <div className="empty-state">选择轨迹中的事件查看原始数据。</div>
        </div>
      </aside>
    );
  const output = event.output ?? event.result ?? event.message;
  const outputText = eventOutputText(output);
  const fileDetail = event.type === "file" || event.type === "file_diff";
  const stats: readonly [string, string][] = fileDetail
    ? [
        ["来源", "/api/files"],
        ["文件", value(event.path)],
      ]
    : [
        ["类型", eventKindLabel(event.type)],
        ["产生者", eventOrigin(event)],
        ["耗时", formatEventDuration(event)],
        ["时间", formatEventClock(event)],
      ];
  return (
    <aside className="details-panel">
      <header>
        <strong>{eventLabel(event)}</strong>
        <button aria-label={fileDetail ? "关闭文件差异" : "关闭事件详情"} onClick={onClose} type="button">
          ×
        </button>
      </header>
      <div className="details-body">
        <div className={`detail-stats ${fileDetail ? "is-file" : ""}`}>
          {stats.map(([key, item]) => (
            <div key={key}>
              <small>{key}</small>
              <b>{item}</b>
            </div>
          ))}
        </div>
        {output !== undefined && (
          <div className="detail-section">
            <small>输出</small>
            {/* A tool result is text wrapped in a content envelope, and printing the envelope made the panel show JSON where the file the tool read should be. The raw payload is still one disclosure below. */}
            <pre className="tool-output">{outputText ?? JSON.stringify(output, null, 2)}</pre>
          </div>
        )}
        <div className="detail-section">
          <small>{fileDetail ? "数据来源" : "经过的插件"}</small>
          <div className="detail-plugin">{fileDetail ? "Git workspace · /api/files" : "Runtime loader · event"}</div>
        </div>
        <div className="detail-actions">
          <button onClick={onCopy} type="button">
            复制 JSON
          </button>
          <button disabled title="当前 API 未提供重放接口" type="button">
            重放
          </button>
        </div>
        <details className="raw-json">
          <summary>原始 JSON</summary>
          <pre className="raw-json-body">{JSON.stringify(event, null, 2)}</pre>
        </details>
      </div>
    </aside>
  );
}

export function Trajectory({
  events,
  sessionMessages,
  onSelect,
}: {
  events: readonly Record<string, unknown>[];
  sessionMessages: number;
  onSelect: (event: Record<string, unknown>) => void;
}) {
  // The trace is a live stream, not session history: reopening a session leaves it empty forever, and "暂无轨迹事件" alone reads as a console that failed to load rather than one that was not watching.
  const resumed = events.length === 0 && sessionMessages > 0;
  const [filter, setFilter] = useState("all");
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    events.forEach((event) => {
      const type = value(event.type, "event");
      map.set(type, (map.get(type) ?? 0) + 1);
    });
    return map;
  }, [events]);
  const visible = events.filter((event) => filter === "all" || value(event.type, "event") === filter);
  return (
    <section className="view-panel trajectory-view">
      <div className="trajectory-summary">
        <span>按轮次</span>
        <b>{events.length} 个事件</b>
        <div className="timeline">
          {events.length ? (
            events.map((event, index) => (
              <span className="timeline-turn" key={index}>
                <i className="timeline-strip" title={eventLabel(event)}></i>
              </span>
            ))
          ) : (
            <span className="timeline-empty">{resumed ? "本次打开后还没有事件" : "等待真实事件…"}</span>
          )}
        </div>
      </div>
      <div className="source-filters">
        <button className={`filter ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")} type="button">
          全部 {events.length}
        </button>
        {[...counts].map(([type, count]) => (
          <button className={`filter ${filter === type ? "active" : ""}`} key={type} onClick={() => setFilter(type)} title={type} type="button">
            {eventKindLabel(type)} {count}
          </button>
        ))}
      </div>
      <div className="event-table">
        <div className="event-head">
          <span>时间</span>
          <span>类型</span>
          <span>事件</span>
          <span>产生者</span>
          <span>耗时</span>
        </div>
        {visible.map((event, index) => (
          <button className="event-row" key={index} onClick={() => onSelect(event)} type="button">
            <span>{formatEventClock(event)}</span>
            <span title={value(event.type, "event")}>
              <i className="event-dot"></i>
              {eventKindLabel(event.type)}
            </span>
            <strong>{eventLabel(event)}</strong>
            <span>{eventOrigin(event)}</span>
            <span>{formatEventDuration(event)}</span>
          </button>
        ))}
        {!visible.length && (
          <div className="empty-state">
            {resumed ? `轨迹只记录控制台连上之后发生的事件，这条会话已有的 ${sessionMessages} 条消息请看「对话」。` : "暂无轨迹事件。"}
          </div>
        )}
      </div>
    </section>
  );
}

export function Files({
  files,
  api,
  onDiff,
  onRefresh,
}: {
  files: readonly ClientFile[];
  api: ClientApi;
  onDiff: (path: string) => Promise<void>;
  onRefresh: () => void;
}) {
  const additions = files.filter((file) => file.status.includes("A") || file.status === "??").length;
  const deletions = files.filter((file) => file.status.includes("D")).length;
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [diffPending, setDiffPending] = useState<string>();
  const [error, setError] = useState("");
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const commit = () => {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    void api
      .commitFiles(
        files.map((file) => file.path),
        text,
      )
      .then(() => {
        setMessage("");
        onRefresh();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const revert = () => {
    if (!files.length || busy) return;
    setRevertConfirmOpen(false);
    setBusy(true);
    setError("");
    void api
      .revertFiles(files.map((file) => file.path))
      .then(onRefresh)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const openDiff = (path: string) => {
    if (busy || diffPending) return;
    setDiffPending(path);
    setError("");
    void onDiff(path)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setDiffPending(undefined));
  };
  return (
    <section className="view-panel files-view">
      <div className="files-content">
        <div className="files-title">
          <strong>本次会话改动</strong>
          <span>由 /api/files 提供</span>
        </div>
        <div className="file-summary">{`${files.length} 个文件 · ${additions} 个新增文件 · ${deletions} 个删除文件`}</div>
        <div className="file-list">
          {files.length ? (
            files.map((file) => (
              <div className="file-row" key={file.path}>
                <b className={`file-kind ${file.label === "untracked" ? "new" : ""}`}>{file.label}</b>
                <code>{file.path}</code>
                <span className={file.status.includes("D") ? "del" : "add"}>{file.status}</span>
                <button
                  aria-label={`${diffPending === file.path ? "正在读取" : "查看"}${file.path}的差异`}
                  className="diff-button"
                  disabled={busy || diffPending !== undefined}
                  onClick={() => openDiff(file.path)}
                  type="button"
                >
                  {diffPending === file.path ? "读取中…" : "查看差异"}
                </button>
              </div>
            ))
          ) : (
            <div className="empty-state">工作区没有未提交改动。</div>
          )}
        </div>
        {files.length > 0 && (
          <div className="file-actions">
            <input aria-label="提交说明" onChange={(event) => setMessage(event.target.value)} placeholder="提交说明" value={message} />
            <button className="primary" disabled={busy || !message.trim()} onClick={commit} type="button">
              {busy ? "处理中…" : "提交这些改动"}
            </button>
            <button disabled={busy} onClick={() => setRevertConfirmOpen(true)} type="button">
              全部撤销
            </button>
          </div>
        )}
        {error && <p className="files-error">{error}</p>}
      </div>
      {revertConfirmOpen && (
        <ConfirmDialog
          busy={busy}
          confirmLabel="确认撤销"
          description="这会丢弃当前工作区的全部未提交改动，此操作不可恢复。"
          onClose={() => setRevertConfirmOpen(false)}
          onConfirm={revert}
          target={`${files.length} 个文件`}
          title="撤销全部改动"
        />
      )}
    </section>
  );
}

function pluginPanelValue(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? value(input);
  } catch {
    return value(input);
  }
}

function pluginPanelData(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

export function PluginPanelCard({ panel, inline = false }: { panel: ClientPluginPanel; inline?: boolean }) {
  const data = pluginPanelData(panel.data);
  const entries = data ? Object.entries(data) : [["内容", panel.data] as const];
  const items = data && Array.isArray(data.items) ? data.items : [];
  const pluginEntries = data && Array.isArray(data.entries) ? data.entries : [];
  const capabilities = data && Array.isArray(data.capabilities) ? data.capabilities : [];
  return (
    <div className={`plugin-panel-card ${inline ? "pt-1" : "rounded-[10px] border border-[#e3e7ee] bg-white p-4 shadow-[0_8px_24px_rgba(27,39,64,0.04)]"}`}>
      <header className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#edf3fe] font-mono text-[15px] text-[#3565c5]">
          {panel.icon ?? "◈"}
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-[13px] font-semibold text-[#20252b]">{panel.title}</strong>
          <p className="mt-1 text-[11px] leading-4 text-[#687381]">{panel.description ?? panel.pluginId.replace(/cordis/gi, "runtime")}</p>
        </div>
      </header>
      {panel.error ? (
        <div className="mt-3 rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-2 text-[12px] text-[#b42318]">{panel.error}</div>
      ) : panel.id === "console-logger-panel" ? (
        <div className="mt-3 grid gap-2">
          <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
            <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-[#687381]">最近日志</span>
            <strong className="mt-1 block text-[20px] font-semibold text-[#20252b]">{value(data?.total ?? 0)}</strong>
          </div>
          <div className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3]">
            {items.length ? (
              items.map((item, index) => {
                const message = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div
                    className="grid grid-cols-[auto_1fr] gap-2 border-b border-[#edf0f3] px-3 py-2 last:border-b-0"
                    key={`${value(message.time ?? "log")}-${index}`}
                  >
                    <span className="font-mono text-[10px] text-[#687381]">{value(message.level ?? "log")}</span>
                    <div className="min-w-0">
                      <strong className="block truncate text-[11px] text-[#30343b]">{value(message.source ?? "runtime")}</strong>
                      <span className="block whitespace-pre-wrap break-words text-[11px] leading-4 text-[#65707b]">{pluginPanelValue(message.args ?? "")}</span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-4 text-[12px] text-[#687381]">暂无日志输出。</div>
            )}
          </div>
        </div>
      ) : panel.id === "plugin-group-panel" ? (
        <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-[#edf0f3]">
          {pluginEntries.length ? (
            pluginEntries.map((item, index) => {
              const entry = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
              return (
                <div className="flex items-center gap-3 border-b border-[#edf0f3] px-3 py-2 last:border-b-0" key={`${value(entry.id ?? "plugin")}-${index}`}>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${entry.enabled === false ? "bg-[#a0a8b2]" : "bg-[#22c55e]"}`}></span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#30343b]">{value(entry.name ?? "plugin")}</span>
                  <span className="text-[10px] text-[#687381]">{value(entry.state ?? "unknown")}</span>
                </div>
              );
            })
          ) : (
            <div className="px-3 py-4 text-[12px] text-[#687381]">暂无插件条目。</div>
          )}
        </div>
      ) : panel.id === "timer-service-panel" ? (
        <div className="mt-3 grid gap-3 rounded-lg bg-[#f6f8fa] px-3 py-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#687381]">服务状态</span>
            <span
              className={`rounded-full px-2 py-1 text-[10px] font-semibold ${data?.registered === true ? "bg-[#e8f8ee] text-[#14733f]" : "bg-[#fff4e5] text-[#8a5a00]"}`}
            >
              {data?.registered === true ? "已注册" : "未注册"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {capabilities.map((capability, index) => (
              <span
                className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]"
                key={`${value(capability)}-${index}`}
              >
                {value(capability)}
              </span>
            ))}
          </div>
        </div>
      ) : panel.id === "agent-teams-panel" ? (
        (() => {
          const view = agentTeamsPanelView(data);
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid gap-2 sm:grid-cols-4">
                {[
                  ["成员", view.inventory.members.total],
                  ["任务", view.inventory.tasks.total],
                  ["未读消息", view.inventory.messages.unread],
                  ["可执行任务", view.inventory.tasks.ready],
                ].map(([label, item]) => (
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                    <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{value(item)}</strong>
                  </div>
                ))}
              </div>
              {view.dependencyCycle !== null && view.dependencyCycle.length > 1 ? (
                <div className="rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-2 text-[11px] text-[#b42318]">
                  依赖循环：{view.dependencyCycle.join(" → ")}
                </div>
              ) : null}
              <div className="grid gap-2">
                {view.members.length > 0 ? (
                  view.members.map((member) => (
                    <div className="flex items-center gap-3 rounded-lg border border-[#edf0f3] px-3 py-2" key={member.id}>
                      <span className={`h-2 w-2 rounded-full ${member.status === "working" ? "bg-[#22c55e]" : "bg-[#a0a8b2]"}`}></span>
                      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[#30343b]">{member.name}</span>
                      <span className="truncate text-[10px] text-[#687381]">{member.role}</span>
                      <span className="font-mono text-[10px] text-[#3565c5]">{member.status}</span>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-3 text-[12px] text-[#687381]">暂无协作角色。</div>
                )}
              </div>
              <div className="grid gap-2">
                {view.tasks.length > 0 ? (
                  view.tasks.map((task) => (
                    <div className="flex items-center gap-3 rounded-lg border border-[#edf0f3] px-3 py-2" key={task.id}>
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] text-[#30343b]">{task.title}</span>
                        {task.dependsOn.length > 0 ? (
                          <span className="mt-0.5 block truncate font-mono text-[9px] text-[#687381]">依赖：{task.dependsOn.join(", ")}</span>
                        ) : null}
                      </div>
                      <span className="text-[10px] text-[#687381]">{task.assignee}</span>
                      <span
                        className={`rounded-full px-2 py-1 text-[10px] ${task.status === "blocked" ? "bg-[#fff4e5] text-[#8a5a00]" : task.status === "done" ? "bg-[#e8f8ee] text-[#14733f]" : "bg-[#edf3fe] text-[#3565c5]"}`}
                      >
                        {task.status}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-3 text-[12px] text-[#687381]">还没有任务。可让 Agent 使用 team_task 创建。</div>
                )}
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[#30343b]">会话内邮箱备注</span>
                  <span className="font-mono text-[10px] text-[#687381]">
                    {view.inventory.messages.shown} / {view.inventory.messages.total}
                  </span>
                </div>
                {view.messages.length > 0 ? (
                  [...view.messages].reverse().map((message) => (
                    <div
                      className={`rounded-lg border px-3 py-2 ${message.read ? "border-[#edf0f3] bg-white" : "border-[#cfe0ff] bg-[#f4f8ff]"}`}
                      key={message.id}
                    >
                      <div className="flex items-center gap-2 text-[10px] text-[#687381]">
                        <span className="font-mono text-[#3565c5]">
                          {message.from} → {message.to}
                        </span>
                        <span className="ml-auto">{message.read ? "已读" : "未读"}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-[#30343b]">{message.body}</p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-3 text-[12px] text-[#687381]">暂无邮箱备注。</div>
                )}
              </div>
              {view.truncated || view.inventory.members.truncated || view.inventory.tasks.truncated || view.inventory.messages.truncated ? (
                <p className="text-[10px] leading-4 text-[#8a6200]">面板按固定安全上限展示；完整计数保留在上方。</p>
              ) : null}
              <p className="text-[10px] leading-4 text-[#687381]">这是当前 Pi 会话的协作账本，不会启动其他 Agent、创建进程或向外部发送消息。</p>
            </div>
          );
        })()
      ) : panel.id === "modlens-panel" ? (
        (() => {
          const view = modlensPanelView(panel.data);
          const stateLabel =
            view.status.state === "running"
              ? "正在读取视觉内容"
              : view.status.state === "failed"
                ? "视觉检查失败"
                : view.status.state === "cancelled"
                  ? "视觉检查已取消"
                  : view.status.state === "completed"
                    ? "视觉检查完成"
                    : "等待图片";
          const mode = view.status.state === "idle" ? view.image?.mode : view.status.mode;
          const path = view.status.state === "idle" ? view.image?.path : view.status.path;
          const stateStyle =
            view.status.state === "failed"
              ? "border-[#f4caca] bg-[#fff5f5]"
              : view.status.state === "cancelled"
                ? "border-[#f1d7a8] bg-[#fff9ed]"
                : view.status.state === "running"
                  ? "border-[#c9d9f7] bg-[#f4f8ff]"
                  : view.attached
                    ? "border-[#b9e6c9] bg-[#f0fbf4]"
                    : "border-[#e3e7ee] bg-[#f6f8fa]";
          return (
            <div className="mt-3 grid gap-3">
              <div className={`rounded-lg border px-3 py-3 ${stateStyle}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[#30343b]">{stateLabel}</span>
                  <span className="rounded-full border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[9px] text-[#3565c5]">
                    {mode === "native" ? "原生直传" : mode === "evidence" ? "ModLens 证据" : "vision_inspect"}
                  </span>
                </div>
                {path !== undefined ? <p className="mt-2 truncate font-mono text-[10px] text-[#65707b]">{path}</p> : null}
                {view.image !== null ? (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#687381]">
                    <span>{view.image.mimeType}</span>
                    <span>{view.image.bytes.toLocaleString()} bytes</span>
                    {view.image.cached ? <span className="font-semibold text-[#14733f]">缓存命中</span> : null}
                  </div>
                ) : view.status.state === "idle" ? (
                  <p className="mt-2 text-[11px] text-[#687381]">让 Agent 调用 vision_inspect，并提供工作区内的图片路径。</p>
                ) : null}
                {view.status.state === "failed" || view.status.state === "cancelled" ? (
                  <p className="mt-2 break-words text-[10px] leading-4 text-[#9b2c24]">{view.status.error}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {view.supportedTypes.map((type) => (
                  <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]" key={type}>
                    {type}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 font-mono text-[9px] text-[#687381]">
                <span>image:{Math.round(view.limits.imageBytes / 1_048_576)}MiB</span>
                <span>evidence:{Math.round(view.limits.evidenceBytes / 1_024)}KiB</span>
                <span>timeout:{Math.round(view.limits.timeoutMs / 1_000)}s</span>
                <span>cache:{view.limits.cacheEntries}</span>
              </div>
              {view.truncated ? <p className="text-[10px] leading-4 text-[#8a6200]">异常面板数据已按固定安全边界丢弃或截断。</p> : null}
              <p className="rounded-lg border border-[#dce5f5] bg-[#f7f9fd] px-3 py-2 text-[10px] leading-4 text-[#566273]">
                纯文本模型会启动外部 ModLens 引擎，可能使用网络和 provider 配额并产生费用。视觉证据是不可信数据，不构成指令或用户授权。
              </p>
            </div>
          );
        })()
      ) : panel.id === "vision-toolkit-panel" ? (
        (() => {
          const view = visionToolkitPanelView(panel.data);
          const report = view.report;
          const stateLabel =
            view.status.state === "running"
              ? view.status.operation === "catalog"
                ? "正在盘点视觉素材"
                : "正在读取图片元数据"
              : view.status.state === "failed"
                ? "视觉素材检查失败"
                : view.status.state === "cancelled"
                  ? "视觉素材检查已取消"
                  : view.status.state === "completed"
                    ? "视觉素材检查完成"
                    : "等待检查";
          const stateStyle =
            view.status.state === "failed"
              ? "border-[#f4caca] bg-[#fff5f5]"
              : view.status.state === "cancelled"
                ? "border-[#f1d7a8] bg-[#fff9ed]"
                : view.status.state === "running"
                  ? "border-[#c9d9f7] bg-[#f4f8ff]"
                  : view.status.state === "completed"
                    ? "border-[#b9e6c9] bg-[#f0fbf4]"
                    : "border-[#e3e7ee] bg-[#f6f8fa]";
          const shownAssets = report?.assets.slice(0, 20) ?? [];
          const shownIssues = report?.issues.slice(0, 10) ?? [];
          return (
            <div className="mt-3 grid gap-3">
              <div className={`rounded-lg border px-3 py-3 ${stateStyle}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[#30343b]">{stateLabel}</span>
                  <span className="rounded-full border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[9px] text-[#3565c5]">
                    {view.status.state === "idle" ? "vision_catalog" : view.status.operation === "catalog" ? "catalog" : "image info"}
                  </span>
                </div>
                {view.status.state !== "idle" && view.status.path !== undefined ? (
                  <p className="mt-2 truncate font-mono text-[10px] text-[#65707b]">{view.status.path}</p>
                ) : null}
                {view.status.state === "failed" || view.status.state === "cancelled" ? (
                  <p className="mt-2 break-words text-[10px] leading-4 text-[#9b2c24]">{view.status.error}</p>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["已扫描", report?.scannedEntries ?? 0],
                  ["候选图片", report?.inspectedCandidates ?? 0],
                  ["有效素材", report?.assets.length ?? 0],
                  ["问题", report?.issues.length ?? 0],
                ].map(([label, count]) => (
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={label}>
                    <span className="block text-[10px] text-[#687381]">{label}</span>
                    <strong className="mt-1 block font-mono text-[16px] text-[#30343b]">{count}</strong>
                  </div>
                ))}
              </div>
              {shownAssets.length > 0 ? (
                <div className="max-h-52 overflow-auto rounded-lg border border-[#edf0f3] bg-[#fbfcfd]">
                  {shownAssets.map((asset, index) => (
                    <div className="border-b border-[#edf0f3] px-3 py-2 last:border-b-0" key={`${asset.path}-${index}`}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate font-mono text-[10px] text-[#30343b]" title={asset.path}>
                          {asset.path}
                        </span>
                        <span className="shrink-0 font-mono text-[9px] text-[#3565c5]">{asset.width === null ? "?×?" : `${asset.width}×${asset.height}`}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-[9px] text-[#687381]">
                        <span>{asset.mimeType}</span>
                        <span>{asset.bytes.toLocaleString()} B</span>
                        {asset.headerTruncated ? <span className="text-[#8a6200]">仅扫描前 256 KiB</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  {report === null ? "让 Agent 调用 vision_catalog 盘点工作区图片，或调用 vision_image_info 检查单张图片。" : "未发现有效的受支持图片。"}
                </div>
              )}
              {shownIssues.length > 0 ? (
                <div className="rounded-lg border border-[#f1d7a8] bg-[#fff9ed] px-3 py-3">
                  <p className="text-[10px] font-semibold text-[#8a6200]">图片问题（显示 {shownIssues.length} 条）</p>
                  <div className="mt-2 grid gap-1.5">
                    {shownIssues.map((issue, index) => (
                      <p className="break-words font-mono text-[9px] leading-4 text-[#6f5730]" key={`${issue.path}-${index}`}>
                        {issue.path}: {issue.reason}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {view.supportedTypes.map((type) => (
                  <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[9px] text-[#3565c5]" key={type}>
                    {type}
                  </span>
                ))}
                <span className="rounded-md border border-[#e3e7ee] bg-[#f6f8fa] px-2 py-1 font-mono text-[9px] text-[#687381]">
                  file≤{Math.round(view.limits.imageBytes / 1_048_576)}MiB
                </span>
                <span className="rounded-md border border-[#e3e7ee] bg-[#f6f8fa] px-2 py-1 font-mono text-[9px] text-[#687381]">
                  assets≤{view.limits.assets}
                </span>
              </div>
              {view.truncated ||
              report?.truncated === true ||
              report?.issuesTruncated === true ||
              (report !== null && (report.assets.length > shownAssets.length || report.issues.length > shownIssues.length)) ? (
                <p className="text-[10px] leading-4 text-[#8a6200]">面板或扫描结果已按固定安全上限截断；计数与警告会保留可见。</p>
              ) : null}
              <p className="rounded-lg border border-[#dce5f5] bg-[#f7f9fd] px-3 py-2 text-[10px] leading-4 text-[#566273]">
                仅在当前 workspace 内本地读取图片头部，不上传图片、不调用外部视觉服务；这里展示的是元数据，不是完整图像解码结果。
              </p>
            </div>
          );
        })()
      ) : panel.id === "at-file-panel" ? (
        (() => {
          const view = atFilePanelView(panel.data);
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[#30343b]">最近附加</span>
                  <span className="font-mono text-[10px] text-[#687381]">file_context</span>
                </div>
                {view.lastFile !== null ? (
                  <p className="mt-2 min-w-0 whitespace-normal break-all text-[11px] leading-4 text-[#65707b]">
                    {view.lastFile.path} · {view.lastFile.bytes} bytes
                  </p>
                ) : (
                  <p className="mt-2 text-[11px] text-[#687381]">还没有附加文件。可使用 @file 或让 Agent 调用 file_context。</p>
                )}
              </div>
              <div className="flex items-center justify-between text-[11px] text-[#687381]">
                <span>单文件上限</span>
                <strong className="font-mono text-[#3565c5]">{view.maxBytes} bytes</strong>
              </div>
              {view.truncated ? <p className="text-[10px] leading-4 text-[#8a6200]">面板数据不完整或已按固定安全上限调整。</p> : null}
            </div>
          );
        })()
      ) : panel.id === "git-time-capsule-panel" ? (
        (() => {
          const report = gitTimeCapsulePanelView(data);
          const latest = report.latest;
          const statusLabel = latest?.status === "completed" ? "已完成" : latest?.status === "cancelled" ? "已取消" : "失败";
          const statusStyle =
            latest?.status === "completed"
              ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#147a43]"
              : latest?.status === "cancelled"
                ? "border-[#f1ddb1] bg-[#fff9eb] text-[#996515]"
                : "border-[#f4caca] bg-[#fff5f5] text-[#b42318]";
          return (
            <div className="mt-3 grid gap-3">
              <div className={`rounded-lg border px-3 py-3 ${latest === null ? "border-[#e3e7ee] bg-[#f6f8fa]" : statusStyle}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[#30343b]">{latest?.action === "restore" ? "最近撤销" : "最近捕获"}</span>
                  {latest === null ? (
                    <span className="font-mono text-[10px] text-[#687381]">git_snapshot</span>
                  ) : (
                    <span className="rounded-full border border-current px-2 py-0.5 text-[9px] font-semibold">{statusLabel}</span>
                  )}
                </div>
                {latest === null ? (
                  <p className="mt-2 text-[11px] leading-4 text-[#687381]">当前没有撤销胶囊。先产生 unstaged tracked 改动，再让 Agent 调用 git_snapshot。</p>
                ) : (
                  <div className="mt-2 grid gap-1 text-[11px] text-[#65707b]">
                    {latest.name !== null ? <p className="truncate font-mono text-[10px] text-[#30343b]">{latest.name}</p> : null}
                    <p>
                      {latest.files} 个文件 · {latest.bytes} bytes · <time dateTime={latest.at}>{latest.at.replace("T", " ")}</time>
                    </p>
                    {latest.error !== null ? <p className="break-words text-[#b42318]">{latest.error}</p> : null}
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[#30343b]">最近胶囊</span>
                  <span className="font-mono text-[10px] text-[#3565c5]">
                    {report.inventory.shown} / {report.inventory.total}
                  </span>
                </div>
                {report.capsules.length > 0 ? (
                  <div className="mt-2 max-h-44 overflow-y-auto border-l-2 border-[#cbd8ef] pl-3">
                    {report.capsules.map((capsule) => (
                      <div className="flex min-w-0 items-center gap-2 border-b border-[#eef1f5] py-1.5 last:border-b-0" key={capsule.name}>
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[#30343b]">{capsule.name}</span>
                        <span className="shrink-0 font-mono text-[9px] text-[#687381]">{capsule.bytes} B</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-[#687381]">尚未保存 tracked diff。</p>
                )}
                {report.inventory.truncated || report.truncated ? (
                  <p className="mt-2 text-[10px] text-[#996515]">列表已按安全上限截断，仅展示最近 {report.inventory.displayLimit} 条有效记录。</p>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2 text-[10px] text-[#687381]">
                <span className="rounded-md bg-[#f6f8fa] px-2 py-1.5">Git 超时：{report.timeoutMs} ms</span>
                <span className="rounded-md bg-[#f6f8fa] px-2 py-1.5">单胶囊：{report.limits.capsuleBytes} B</span>
              </div>
              <p className="text-[10px] leading-4 text-[#687381]">
                git_snapshot 捕获当前 unstaged tracked 改动；git_restore 会反向应用该 patch。staged 与未跟踪文件不包含在内，恢复必须传入 confirm=true。
              </p>
            </div>
          );
        })()
      ) : panel.id === "dependency-checker-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const report = dependencyCheckerPanelView(data);
            const hasProblems = report.missingCount > 0 || report.invalidCount > 0 || report.conflictCount > 0;
            const isIndeterminate = report.unresolvedCount > 0 || report.truncated;
            return (
              <>
                <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-2 text-[10px]">
                  <span className="min-w-0 truncate font-mono text-[#65707b]">{report.manifest}</span>
                  <strong className="shrink-0 font-mono uppercase text-[#315fb8]">{report.ecosystem}</strong>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {[
                    ["声明", report.declared],
                    ["已安装", report.installed],
                    ["问题", report.missingCount + report.invalidCount],
                    ["可选缺席", report.optionalMissingCount],
                    ["未决", report.unresolvedCount],
                  ].map(([label, item]) => (
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                      <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                      <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{value(item)}</strong>
                    </div>
                  ))}
                </div>
                <div
                  className={`min-w-0 break-words rounded-lg border px-3 py-3 text-[11px] [overflow-wrap:anywhere] ${hasProblems ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" : isIndeterminate ? "border-[#f3dfab] bg-[#fffaf0] text-[#8a6200]" : "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"}`}
                >
                  {report.missingCount || report.invalidCount
                    ? `缺失 ${report.missingCount}、无效 ${report.invalidCount}：${[...report.missing, ...report.invalid].join(", ")}`
                    : report.conflictCount
                      ? `本地安装存在 ${report.conflictCount} 组声明约束冲突。`
                      : report.unresolvedCount
                        ? `${report.unresolvedCount} 组声明约束无法离线判定。`
                        : report.truncated
                          ? "报告不完整，无法确认依赖状态。"
                          : "依赖声明与本地安装一致。"}
                </div>
                {report.optionalMissingCount > 0 ? (
                  <div className="min-w-0 break-words rounded-lg border border-[#f3dfab] bg-[#fffaf0] px-3 py-2 text-[10px] text-[#8a6200] [overflow-wrap:anywhere]">
                    可选依赖未安装（{report.optionalMissingCount}）：{report.optionalMissing.join(", ")}
                  </div>
                ) : null}
                {report.conflicts.length > 0 ? (
                  <div className="rounded-lg border border-[#f3dfab] bg-[#fffaf0] px-3 py-3 text-[11px] text-[#8a6200]">
                    <strong>版本冲突</strong>
                    <ul className="mt-1 grid gap-1 pl-4">
                      {report.conflicts.map((conflict, index) => (
                        <li className="min-w-0 break-words [overflow-wrap:anywhere]" key={`${conflict.name}-${index}`}>
                          <code>{conflict.name}</code>：{conflict.constraints.join(" · ") || "—"}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {report.unresolved.length > 0 ? (
                  <div className="rounded-lg border border-[#f3dfab] bg-[#fffaf0] px-3 py-3 text-[11px] text-[#8a6200]">
                    <strong>未决约束</strong>
                    <ul className="mt-1 grid gap-1 pl-4">
                      {report.unresolved.map((constraint, index) => (
                        <li className="min-w-0 break-words [overflow-wrap:anywhere]" key={`${constraint.name}-${index}`}>
                          <code>{constraint.name}</code>：{constraint.constraints.join(" · ") || "—"}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="flex items-center justify-between text-[10px] text-[#687381]">
                  <span>本地只读扫描 · 上限 {report.scanLimit} 项</span>
                  {report.truncated ? <span>面板明细已截断</span> : null}
                </div>
              </>
            );
          })()}
        </div>
      ) : panel.id === "token-guard-panel" ? (
        (() => {
          const view = tokenGuardPanelView(data);
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className={`rounded-lg border px-3 py-3 ${view.exceeded ? "border-[#f4caca] bg-[#fff5f5]" : "border-[#e3eaf8] bg-[#f6f8ff]"}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold text-[#30343b]">上下文预算</span>
                    <strong className="font-mono text-[12px] text-[#315fb8]">
                      {view.percent === null ? "—" : view.percent}% / {view.maxPercent}%
                    </strong>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#dfe8fb]">
                    <div
                      className={`h-full rounded-full ${view.exceeded ? "bg-[#d64545]" : "bg-[#5d8bea]"}`}
                      style={{ width: `${Math.min(100, view.percent ?? 0)}%` }}
                    />
                  </div>
                  <p className="mt-2 text-[11px] text-[#5d6d82]">
                    {view.tokens === null ? "上下文 token 未知" : `${view.tokens.toLocaleString()} / ${view.contextWindow?.toLocaleString() ?? "—"} tokens`}
                    {` · 已请求停止 ${view.aborts} 次`}
                  </p>
                </div>
                <div className={`rounded-lg border px-3 py-3 ${view.runExceeded ? "border-[#f4caca] bg-[#fff5f5]" : "border-[#e3eaf8] bg-[#f6f8ff]"}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold text-[#30343b]">单次任务</span>
                    <strong className="font-mono text-[12px] text-[#315fb8]">
                      {view.runTokens === null ? "—" : view.runTokens.toLocaleString()} / {view.maxRunTokens === 0 ? "—" : view.maxRunTokens.toLocaleString()}
                    </strong>
                  </div>
                  <p className="mt-2 text-[11px] text-[#5d6d82]">
                    {view.maxRunTokens > 0 ? "按 agent_start 后新增的已结算 token 熔断。" : "未启用绝对 Token 上限。"}
                  </p>
                </div>
              </div>
              {view.lastError === null ? null : (
                <div className="rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-2 text-[10px] leading-4 text-[#b42318]">
                  保护器错误：{view.lastError}
                </div>
              )}
            </div>
          );
        })()
      ) : panel.id === "test-harness-panel" ? (
        (() => {
          const view = testHarnessPanelView(panel.data);
          const run = view.latest;
          const statusLabel =
            run?.status === "passed"
              ? "验证通过"
              : run?.status === "failed"
                ? "验证失败"
                : run?.status === "timed-out"
                  ? "验证超时"
                  : run?.status === "cancelled"
                    ? "验证已取消"
                    : "等待验证";
          const statusStyle =
            run?.status === "passed"
              ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"
              : run?.status === "failed"
                ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]"
                : run?.status === "timed-out" || run?.status === "cancelled"
                  ? "border-[#f1d7a8] bg-[#fff9ed] text-[#8a6200]"
                  : "border-[#e3e7ee] bg-[#f6f8fa] text-[#687381]";
          return (
            <div className="mt-3 grid min-w-0 gap-3">
              <div className={`min-w-0 rounded-lg border px-3 py-3 ${statusStyle}`}>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="break-all font-mono text-[11px] font-semibold text-[#30343b]">{run?.command ?? "npm run test"}</span>
                  <span className="rounded-full border border-current px-2 py-0.5 text-[9px] font-semibold">{statusLabel}</span>
                </div>
                {run === null ? (
                  <p className="mt-2 text-[11px] leading-4 text-[#687381]">还没有执行验证脚本。可让 Agent 调用 run_project_tests。</p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#65707b]">
                    <span>exit {run.exitCode ?? "—"}</span>
                    {run.signal === null ? null : <span>{run.signal}</span>}
                    <span>{run.durationMs} ms</span>
                    <span>{run.outputBytes.toLocaleString()} output bytes</span>
                  </div>
                )}
              </div>
              {run !== null && run.output !== "" ? (
                <div className="min-w-0 rounded-lg border border-[#e3e7ee] bg-[#111318] p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[9px] text-[#9ba6b2]">
                    <span className="font-semibold uppercase tracking-[0.08em]">输出末尾</span>
                    <span>最多 {view.limits.outputBytes} bytes</span>
                  </div>
                  <pre className="max-h-52 min-w-0 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-4 text-[#e6edf3]">
                    {run.output}
                  </pre>
                </div>
              ) : null}
              {run?.outputTruncated || run?.outputSanitized ? (
                <p className="text-[10px] leading-4 text-[#8a6200]">
                  {run.outputTruncated ? "输出只保留最后 12 KiB。" : ""}
                  {run.outputSanitized ? "终端控制字符已清理。" : ""}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {view.allowedScripts.map((script) => (
                  <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]" key={script}>
                    {script}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-[#687381]">
                <span>timeout {view.limits.timeoutMs} ms</span>
                <span>output {view.limits.outputBytes} bytes</span>
              </div>
              {view.truncated ? <p className="text-[10px] leading-4 text-[#8a6200]">面板数据不完整或已按固定安全上限调整。</p> : null}
              <p className="rounded-lg border border-[#f1d7a8] bg-[#fff9ed] px-3 py-2 text-[10px] leading-4 text-[#6f5730]">
                npm scripts 会执行当前项目定义的代码；仅在可信 workspace 中使用。Test Harness 不是沙箱，也不会把脚本输出当作用户授权。
              </p>
            </div>
          );
        })()
      ) : panel.id === "session-insights-panel" ? (
        (() => {
          const view = sessionInsightsPanelView(panel.data);
          const report = view.report;
          if (report === null)
            return (
              <div className="mt-3 rounded-lg border border-[#f3c4c4] bg-[#fff4f4] px-3 py-3 text-[11px] leading-5 text-[#a23b3b]">
                会话统计数据无效，已停止展示指标，避免把损坏数据误报为健康状态。
              </div>
            );
          const contextUsage = report.contextUsage;
          const compactionLabels = {
            idle: "尚未请求压缩",
            queued: "等待 Agent 空闲",
            running: "正在压缩",
            completed: "压缩已完成",
            failed: "压缩失败",
            cancelled: "压缩已取消",
            unknown: "压缩状态数据无效",
          } as const;
          const compactionStyles = {
            idle: "border-[#e3e7ee] bg-[#f6f8fa] text-[#687381]",
            queued: "border-[#f1d7a8] bg-[#fff9ed] text-[#8a6200]",
            running: "border-[#cbdaf6] bg-[#f3f7ff] text-[#315fb8]",
            completed: "border-[#bfe4cb] bg-[#f1fbf4] text-[#287a43]",
            failed: "border-[#f3c4c4] bg-[#fff4f4] text-[#a23b3b]",
            cancelled: "border-[#f1d7a8] bg-[#fff9ed] text-[#8a6200]",
            unknown: "border-[#f3c4c4] bg-[#fff4f4] text-[#a23b3b]",
          } as const;
          return (
            <div className="mt-3 grid min-w-0 gap-3">
              <div className="min-w-0 rounded-lg border border-[#e3e7ee] bg-white px-3 py-2">
                <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-[#7a8490]">Session</span>
                <p className="mt-1 min-w-0 break-all font-mono text-[10px] leading-4 text-[#3d4650]">{report.sessionId}</p>
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-2 min-[360px]:grid-cols-3">
                {[
                  ["消息", report.totalMessages.toLocaleString("en-US")],
                  ["工具调用 / 结果", `${report.toolCalls.toLocaleString("en-US")} / ${report.toolResults.toLocaleString("en-US")}`],
                  ["成本", `$${report.cost.toFixed(4)}`],
                ].map(([label, item]) => (
                  <div className="min-w-0 rounded-lg bg-[#f6f8fa] px-3 py-2" key={label}>
                    <span className="block text-[10px] text-[#687381]">{label}</span>
                    <strong className="mt-1 block break-all text-[16px] font-semibold text-[#30343b]">{item}</strong>
                  </div>
                ))}
              </div>
              <div className="min-w-0 rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-[#30343b]">累计 token</span>
                  <strong className="break-all font-mono text-[14px] text-[#315fb8]">{report.tokens.total.toLocaleString("en-US")}</strong>
                </div>
                <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[10px] leading-4 text-[#5d6d82]">
                  <span>输入 {report.tokens.input.toLocaleString("en-US")}</span>
                  <span>输出 {report.tokens.output.toLocaleString("en-US")}</span>
                  <span>缓存读取 {report.tokens.cacheRead.toLocaleString("en-US")}</span>
                  <span>缓存写入 {report.tokens.cacheWrite.toLocaleString("en-US")}</span>
                </div>
              </div>
              <div className="min-w-0 rounded-lg border border-[#e3e7ee] bg-white px-3 py-3">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-[#30343b]">当前上下文</span>
                  {contextUsage === null ? null : contextUsage.percent === null ? (
                    <strong className="text-[11px] font-semibold text-[#8a6200]">待下一次模型响应</strong>
                  ) : (
                    <strong className="font-mono text-[12px] text-[#315fb8]">{contextUsage.percent.toFixed(1)}%</strong>
                  )}
                </div>
                {contextUsage === null ? (
                  <p className="mt-2 text-[10px] leading-4 text-[#687381]">当前模型未提供上下文窗口。</p>
                ) : contextUsage.tokens === null ? (
                  <p className="mt-2 text-[10px] leading-4 text-[#687381]">
                    压缩后 token 暂不可估算 · 上下文窗口 {contextUsage.contextWindow.toLocaleString("en-US")}
                  </p>
                ) : (
                  <p className="mt-2 text-[10px] leading-4 text-[#687381]">
                    {contextUsage.tokens.toLocaleString("en-US")} / {contextUsage.contextWindow.toLocaleString("en-US")} tokens
                  </p>
                )}
              </div>
              <div className={`min-w-0 rounded-lg border px-3 py-3 ${compactionStyles[view.compaction.status]}`}>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em]">会话压缩</span>
                  <strong className="text-[11px] font-semibold">{compactionLabels[view.compaction.status]}</strong>
                </div>
                {view.compaction.error === null ? null : <p className="mt-2 break-words text-[10px] leading-4">{view.compaction.error}</p>}
              </div>
              {view.malformed && view.compaction.status !== "unknown" ? <p className="text-[10px] leading-4 text-[#a23b3b]">面板数据不完整或不一致。</p> : null}
            </div>
          );
        })()
      ) : panel.id === "session-bridge-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const view = sessionBridgePanelView(data);
            const sections: readonly [string, string][] = [
              ["目标", view.preview.goal],
              ["当前状态", view.preview.currentState],
              ["下一步", view.preview.nextStep],
            ];
            const lists: readonly (readonly [string, readonly string[]])[] = [
              ["关键决策", view.preview.decisions],
              ["关键文件", view.preview.keyFiles],
            ];
            return (
              <>
                <div className="rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3 text-[11px] leading-5 text-[#315fb8]">
                  预览不会创建目标会话，也不会修改源会话。
                </div>
                {view.status.state === "failed" || view.status.state === "cancelled" ? (
                  <div
                    className={`rounded-lg border px-3 py-3 text-[11px] leading-5 ${
                      view.status.state === "failed" ? "border-[#f3c4c4] bg-[#fff4f4] text-[#a23b3b]" : "border-[#f4d8a8] bg-[#fff9ed] text-[#9a6700]"
                    }`}
                  >
                    {view.status.operation === "import" ? "导入" : view.status.operation === "export" ? "导出" : "预览"}
                    {view.status.state === "failed" ? "失败" : "已取消"}
                    {view.status.error === null ? "" : `：${view.status.error}`}
                  </div>
                ) : null}
                {sections.map(([label, item]) => (
                  <div className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-3" key={label}>
                    <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[#687381]">{label}</span>
                    <p className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-5 text-[#30343b]">{item || "暂无"}</p>
                  </div>
                ))}
                <div className="grid gap-2 sm:grid-cols-2">
                  {lists.map(([label, items]) => (
                    <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3" key={value(label)}>
                      <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[#687381]">{value(label)}</span>
                      {items.length > 0 ? (
                        <ul className="mt-2 grid gap-1 text-[10px] leading-4 text-[#65707b]">
                          {items.map((item, index) => (
                            <li className="break-words" key={`${item}-${index}`}>
                              {item}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-[10px] text-[#687381]">暂无</p>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 text-[10px] text-[#687381]">
                  <span>格式 v{view.formatVersion}</span>
                  <span>最多 {view.limits.messages} 条消息</span>
                  <span>正文 {view.limits.totalMessageCharacters} 字符</span>
                  <span>附件标记 {view.limits.attachments} 个</span>
                  {view.source !== null ? <span className="max-w-full truncate">来源 {view.source.sessionId}</span> : null}
                  {view.latest !== null ? <span>{view.latest.direction === "import" ? "最近导入" : "最近导出"}</span> : null}
                </div>
              </>
            );
          })()}
        </div>
      ) : panel.id === "session-compare-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.left && typeof data.left === "object" && data?.right && typeof data.right === "object" ? (
            (() => {
              const left = data.left as Record<string, unknown>;
              const right = data.right as Record<string, unknown>;
              return (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[
                      ["左侧会话", left],
                      ["右侧会话", right],
                    ].map(([label, session]) => {
                      const item = session as Record<string, unknown>;
                      return (
                        <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3" key={value(label)}>
                          <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[#687381]">{value(label)}</span>
                          <strong className="mt-2 block truncate text-[12px] text-[#30343b]">{value(item.name ?? item.id)}</strong>
                          <code className="mt-1 block truncate text-[10px] text-[#315fb8]">{value(item.id)}</code>
                          <span className="mt-1 block text-[10px] text-[#65707b]">{value(item.messageCount, "0")} 条消息</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      ["共享", data.shared ?? 0],
                      ["右侧新增", Array.isArray(data.added) ? data.added.length : 0],
                      ["左侧删除", Array.isArray(data.removed) ? data.removed.length : 0],
                    ].map(([label, item]) => (
                      <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                        <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                        <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{value(item)}</strong>
                      </div>
                    ))}
                  </div>
                  <div
                    className={`rounded-lg border px-3 py-3 text-[11px] ${data.changed === true ? "border-[#f4d8a8] bg-[#fff9ed] text-[#9a6700]" : "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"}`}
                  >
                    {data.changed === true ? "两个会话存在消息差异。" : "两个会话内容一致。"}
                  </div>
                  {Array.isArray(data.added) && data.added.length > 0 ? (
                    <div className="rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
                      <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[#687381]">右侧新增消息</span>
                      <ul className="mt-2 grid gap-1 text-[10px] leading-4 text-[#65707b]">
                        {data.added.slice(0, 4).map((item, index) => {
                          const message = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                          return (
                            <li key={`${value(message.role)}-${index}`}>
                              [{value(message.role)}] {value(message.text)}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              执行 session_compare 后显示两个会话的差异。
            </div>
          )}
        </div>
      ) : panel.id === "secure-audit-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="grid grid-cols-4 gap-2">
            {[
              ["扫描文件", data?.scanned ?? 0],
              ["严重", data?.critical ?? 0],
              ["高风险", data?.high ?? 0],
              ["总发现", data?.total ?? 0],
            ].map(([label, item]) => (
              <div className="rounded-lg bg-[#f6f8fa] px-2 py-2 text-center" key={value(label)}>
                <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                <strong className="mt-1 block text-[16px] font-semibold text-[#30343b]">{value(item)}</strong>
              </div>
            ))}
          </div>
          <div
            className={`rounded-lg border px-3 py-3 text-[11px] ${Number(data?.total ?? 0) > 0 ? "border-[#f4d8a8] bg-[#fff9ed] text-[#9a6700]" : "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"}`}
          >
            {Number(data?.total ?? 0) > 0 ? "发现需要人工确认的安全风险。" : "未发现凭据泄露或危险命令。"}
          </div>
          {Array.isArray(data?.findings) && data.findings.length > 0 ? (
            <div className="grid gap-2">
              {data.findings.slice(0, 6).map((item, index) => {
                const finding = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                const severity = value(finding.severity, "medium");
                return (
                  <div className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(finding.path)}-${value(finding.line)}-${index}`}>
                    <div className="flex items-center justify-between gap-2">
                      <code className="min-w-0 truncate text-[10px] text-[#315fb8]">{value(finding.path)}</code>
                      <span className={`shrink-0 text-[10px] font-semibold ${severity === "critical" ? "text-[#b42318]" : "text-[#9a6700]"}`}>{severity}</span>
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-[#65707b]">
                      第 {value(finding.line)} 行 · {value(finding.message)}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">运行 security_audit 后显示脱敏结果。</div>
          )}
        </div>
      ) : panel.id === "context-doctor-panel" ? (
        (() => {
          const view = contextDoctorPanelView(data);
          const compactionLabel = {
            idle: "尚未请求",
            queued: "已排队",
            running: "压缩中",
            completed: "已完成",
            failed: "失败",
            cancelled: "已取消",
            unknown: "未知",
          } as const;
          const compactionTone =
            view.compaction.status === "completed"
              ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"
              : view.compaction.status === "failed"
                ? "border-[#f3c4c4] bg-[#fff4f4] text-[#a23b3b]"
                : view.compaction.status === "cancelled"
                  ? "border-[#f4d8a8] bg-[#fff9ed] text-[#9a6700]"
                  : "border-[#dce5f5] bg-[#f6f8ff] text-[#3565c5]";
          return (
            <div className="mt-3 grid gap-3">
              <div
                className={`rounded-lg border px-3 py-3 text-[11px] ${
                  view.status === "warning"
                    ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]"
                    : view.status === "ok"
                      ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"
                      : "border-[#e3e7ee] bg-[#f6f8fa] text-[#687381]"
                }`}
              >
                {view.status === "warning" ? "需要关注上下文风险。" : view.status === "ok" ? "上下文状态正常。" : "上下文状态不可用。"}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["占用", view.usagePercent === null ? "—" : `${view.usagePercent}%`],
                  ["超限/不可测", view.oversizedMessages],
                  ["无法安全检查", view.uninspectableMessages],
                  ["工具错误", view.toolErrors],
                ].map(([label, item]) => (
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={String(label)}>
                    <span className="block text-[10px] text-[#687381]">{label}</span>
                    <strong className="mt-1 block text-[17px] text-[#30343b]">{item}</strong>
                  </div>
                ))}
              </div>
              {view.compaction.status === "idle" || view.compaction.status === "unknown" ? null : (
                <div className={`rounded-lg border px-3 py-3 text-[11px] ${compactionTone}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span>最近压缩</span>
                    <strong>{compactionLabel[view.compaction.status]}</strong>
                  </div>
                  {view.compaction.error === null ? null : <p className="mt-2 break-words text-[10px] leading-4">{view.compaction.error}</p>}
                </div>
              )}
              {view.recommendations.length > 0 ? (
                <ul className="grid gap-1 rounded-lg border border-[#e3e7ee] bg-white px-4 py-3 text-[10px] text-[#65707b]">
                  {view.recommendations.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                  {view.recommendationsTruncated ? <li>部分建议因浏览器显示上限被省略。</li> : null}
                </ul>
              ) : null}
              <div className="flex flex-wrap gap-2 text-[10px] text-[#687381]">
                <span className="rounded bg-[#f6f8fa] px-2 py-1">
                  扫描 {view.scannedMessages} / {view.messageCount} 条消息{view.messagesTruncated ? "（已截断）" : ""}
                </span>
                <span className="rounded bg-[#f6f8fa] px-2 py-1">告警阈值 {view.warnPercent}%</span>
                <span className="rounded bg-[#f6f8fa] px-2 py-1">大消息阈值 {view.maxMessageBytes}B</span>
                <span className="rounded bg-[#f6f8fa] px-2 py-1">
                  结构预算 {view.limits.jsonNodesPerAudit} 节点 / 深度 {view.limits.jsonDepth}
                </span>
              </div>
            </div>
          );
        })()
      ) : panel.id === "history-compressor-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <span className="font-mono text-[11px] text-[#30343b]">{data?.enabled === true ? "自动压缩已启用" : "自动压缩已停用"}</span>
            <strong className="font-mono text-[11px] text-[#3565c5]">阈值 {value(data?.thresholdPercent ?? "—")}%</strong>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              <span className="block text-[10px] text-[#687381]">已压缩</span>
              <strong className="mt-1 block text-[17px] text-[#30343b]">{value(data?.compactions ?? 0)}</strong>
            </div>
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              <span className="block text-[10px] text-[#687381]">当前占用</span>
              <strong className="mt-1 block text-[17px] text-[#30343b]">{value(data?.lastUsagePercent ?? "—")}%</strong>
            </div>
          </div>
          {data?.lastError ? <p className="text-[11px] text-[#b42318]">最近错误：{value(data.lastError)}</p> : null}
        </div>
      ) : panel.id === "session-export-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const latest = data.latest as Record<string, unknown>;
              return (
                <div className="rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[#687381]">最近导出</span>
                  <code className="mt-2 block truncate text-[11px] text-[#315fb8]">{value(latest.path ?? "pi-session.md")}</code>
                  <p className="mt-1 text-[10px] text-[#65707b]">
                    {value(latest.messages ?? 0)} 条消息 · {value(latest.bytes ?? 0)} bytes
                  </p>
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">还没有导出当前会话。</div>
          )}
          <p className="text-[10px] leading-4 text-[#687381]">导出文件只允许写入当前工作区内的 .md 路径，覆盖已有文件需要显式确认。</p>
        </div>
      ) : panel.id === "session-search-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.query ? (
            <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
              <code className="min-w-0 truncate text-[11px] text-[#315fb8]">{value(data.query)}</code>
              <strong className="ml-3 shrink-0 text-[11px] text-[#3565c5]">{value(data.total ?? 0)} 个会话</strong>
            </div>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">输入查询后显示匹配的历史会话。</div>
          )}
          {Array.isArray(data?.items) && data.items.length > 0 ? (
            <div className="grid gap-2">
              {data.items.slice(0, 8).map((item, index) => {
                const session = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                const hits = Array.isArray(session.hits) ? session.hits : [];
                return (
                  <div className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(session.id ?? "session")}-${index}`}>
                    <strong className="block truncate text-[11px] text-[#30343b]">{value(session.name ?? session.id ?? "未命名会话")}</strong>
                    <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-[#65707b]">
                      {hits
                        .map((hit) => (hit !== null && typeof hit === "object" ? value((hit as Record<string, unknown>).text ?? "") : value(hit)))
                        .join(" | ")}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : data?.query ? (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">没有找到匹配的历史会话。</div>
          ) : null}
        </div>
      ) : panel.id === "session-bookmarks-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
            <span className="text-[11px] text-[#65707b]">当前会话的持久化书签</span>
            <strong className="font-mono text-[11px] text-[#3565c5]">{value(data?.total ?? 0)} 个书签</strong>
          </div>
          {Array.isArray(data?.bookmarks) && data.bookmarks.length > 0 ? (
            <div className="grid gap-2">
              {data.bookmarks.slice(0, 12).map((item, index) => {
                const bookmark = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(bookmark.id ?? "bookmark")}-${index}`}>
                    <strong className="block truncate text-[11px] text-[#30343b]">{value(bookmark.label ?? "未命名书签")}</strong>
                    <code className="mt-1 block truncate text-[10px] text-[#687381]">entry: {value(bookmark.entryId ?? "—")}</code>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">还没有标记重要节点。</div>
          )}
          <p className="text-[10px] leading-4 text-[#687381]">书签独立保存在 agent 目录，不会改写 Pi 原生会话记录。</p>
        </div>
      ) : panel.id === "llm-verifier-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
            <span className="text-[11px] text-[#65707b]">校验模型</span>
            <code className="max-w-[65%] truncate text-[11px] text-[#315fb8]">
              {value(data?.provider ?? "—")}/{value(data?.model ?? "—")}
            </code>
          </div>
          {data?.history && typeof data.history === "object"
            ? (() => {
                const history = data.history as Record<string, unknown>;
                const counts = history.counts && typeof history.counts === "object" ? (history.counts as Record<string, unknown>) : {};
                return (
                  <div className="grid grid-cols-4 gap-2">
                    <div className="rounded-lg bg-[#f6f8fa] px-2 py-2 text-center">
                      <span className="block text-[10px] text-[#687381]">累计</span>
                      <strong className="mt-1 block text-[15px] text-[#30343b]">{value(history.total ?? 0)}</strong>
                    </div>
                    <div className="rounded-lg bg-[#f0fbf4] px-2 py-2 text-center">
                      <span className="block text-[10px] text-[#14733f]">通过</span>
                      <strong className="mt-1 block text-[15px] text-[#14733f]">{value(counts.pass ?? 0)}</strong>
                    </div>
                    <div className="rounded-lg bg-[#fff5f5] px-2 py-2 text-center">
                      <span className="block text-[10px] text-[#b42318]">失败</span>
                      <strong className="mt-1 block text-[15px] text-[#b42318]">{value(counts.fail ?? 0)}</strong>
                    </div>
                    <div className="rounded-lg bg-[#fffaf0] px-2 py-2 text-center">
                      <span className="block text-[10px] text-[#9a6700]">未知</span>
                      <strong className="mt-1 block text-[15px] text-[#9a6700]">{value(counts.unknown ?? 0)}</strong>
                    </div>
                  </div>
                );
              })()
            : null}
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const latest = data.latest as Record<string, unknown>;
              const verdict = value(latest.verdict ?? "unknown");
              return (
                <div
                  className={`rounded-lg border px-3 py-3 text-[11px] ${verdict === "pass" ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]" : verdict === "fail" ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" : "border-[#f3dfab] bg-[#fffaf0] text-[#9a6700]"}`}
                >
                  <div className="flex items-center justify-between">
                    <strong className="uppercase">{verdict}</strong>
                    <span className="font-mono text-[10px]">{value(latest.evidenceChars ?? 0)} chars</span>
                  </div>
                  <p className="mt-2 leading-4">{value(latest.rationale ?? "没有返回校验理由。")}</p>
                  <p className="mt-2 truncate text-[10px] opacity-70">声明：{value(latest.claim ?? "—")}</p>
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">还没有执行模型校验。</div>
          )}
          <p className="text-[10px] leading-4 text-[#687381]">证据按不可信数据处理，输入有长度上限；模型返回非结构化结果时显示 unknown。</p>
        </div>
      ) : panel.id === "module-search-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const latest = data.latest as Record<string, unknown>;
              const matches = Array.isArray(latest.matches) ? latest.matches : [];
              return (
                <>
                  <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
                    <code className="min-w-0 truncate text-[11px] text-[#315fb8]">{value(latest.query ?? "")}</code>
                    <strong className="ml-3 shrink-0 text-[11px] text-[#3565c5]">{value(matches.length)} 个结果</strong>
                  </div>
                  {matches.length > 0 ? (
                    <div className="grid gap-2">
                      {matches.slice(0, 10).map((item, index) => {
                        const match = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                        return (
                          <div
                            className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2"
                            key={`${value(match.path ?? "module")}:${value(match.line ?? index)}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <code className="min-w-0 truncate text-[10px] text-[#315fb8]">
                                {value(match.path ?? "—")}:{value(match.line ?? "—")}
                              </code>
                              <span className="shrink-0 text-[10px] uppercase text-[#687381]">{value(match.kind ?? "symbol")}</span>
                            </div>
                            <p className="mt-1 truncate text-[10px] text-[#65707b]">{value(match.name ?? "未命名符号")}</p>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">没有找到匹配的模块符号。</div>
                  )}
                  <p className="text-[10px] leading-4 text-[#687381]">扫描 {value(latest.scannedFiles ?? 0)} 个源码文件，跳过依赖和构建目录。</p>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">输入符号名后显示模块检索结果。</div>
          )}
        </div>
      ) : panel.id === "better-sidebar-panel" ? (
        (() => {
          const changedFiles = Array.isArray(data?.changedFiles) ? data.changedFiles : [];
          const clean = data?.clean === true;
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <code className="min-w-0 truncate text-[11px] text-[#315fb8]">{value(data?.cwd ?? "当前工作区")}</code>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${clean ? "bg-[#eaf8f0] text-[#14733f]" : "bg-[#fff0f0] text-[#b42318]"}`}
                  >
                    {clean ? "clean" : `${value(data?.changedCount ?? changedFiles.length)} 个变更`}
                  </span>
                </div>
                <p className="mt-2 font-mono text-[10px] text-[#65707b]">{value(data?.summary ?? "等待工作区扫描")}</p>
                <p className="mt-1 text-[10px] text-[#687381]">
                  会话 {value(data?.sessionId ?? "—")} · 目录 {value(data?.directoryCount ?? 0)} · 文件 {value(data?.fileCount ?? 0)}
                </p>
              </div>
              {changedFiles.length > 0 ? (
                <div className="grid gap-1 rounded-lg border border-[#edf0f3] bg-white px-3 py-2">
                  {changedFiles.slice(0, 8).map((item, index) => {
                    const entry = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                    return (
                      <code className="truncate py-0.5 text-[10px] text-[#65707b]" key={`${value(entry.path ?? "file")}-${index}`}>
                        {value(entry.status ?? "??")} {value(entry.path ?? "未命名")}
                      </code>
                    );
                  })}
                </div>
              ) : null}
              {data?.truncated === true ? <p className="text-[10px] text-[#687381]">目录摘要已截断，执行 sidebar_overview 获取最新概览。</p> : null}
            </div>
          );
        })()
      ) : panel.id === "workspace-navigator-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const latest = data.latest as Record<string, unknown>;
              const nodes = Array.isArray(latest.nodes) ? latest.nodes : [];
              return (
                <>
                  <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
                    <code className="min-w-0 truncate text-[11px] text-[#315fb8]">{value(latest.path ?? ".")}</code>
                    <strong className="ml-3 shrink-0 text-[11px] text-[#3565c5]">{value(nodes.length)} 个节点</strong>
                  </div>
                  {nodes.length > 0 ? (
                    <div className="grid gap-1 rounded-lg border border-[#edf0f3] bg-white px-3 py-2">
                      {nodes.slice(0, 36).map((item, index) => {
                        const node = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                        const depth = typeof node.depth === "number" ? Math.min(6, Math.max(1, node.depth)) : 1;
                        return (
                          <div className="flex items-center gap-2 truncate py-1 text-[10px] text-[#65707b]" key={`${value(node.path ?? "node")}-${index}`}>
                            <span className="shrink-0 text-[#687381]">
                              {"· ".repeat(depth - 1)}
                              {node.kind === "directory" ? "▾" : "·"}
                            </span>
                            <code className="truncate">{value(node.name ?? node.path ?? "未命名")}</code>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">当前目录为空。</div>
                  )}
                  <p className="text-[10px] leading-4 text-[#687381]">
                    目录 {value(latest.directoryCount ?? 0)} 个，文件 {value(latest.fileCount ?? 0)} 个；跳过依赖和构建目录。
                  </p>
                  {data?.git && typeof data.git === "object"
                    ? (() => {
                        const git = data.git as Record<string, unknown>;
                        const entries = Array.isArray(git.entries) ? git.entries : [];
                        const available = git.available === true;
                        return (
                          <div className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-3">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-medium text-[#253044]">Git 状态</span>
                              <span className={`text-[10px] ${!available ? "text-[#687381]" : git.clean === true ? "text-[#14733f]" : "text-[#b42318]"}`}>
                                {!available ? "不可用" : git.clean === true ? "clean" : `${entries.length} 个变更`}
                              </span>
                            </div>
                            {available ? <p className="mt-1 font-mono text-[10px] text-[#65707b]">{value(git.branch ?? "detached HEAD")}</p> : null}
                            {entries.length > 0 ? (
                              <div className="mt-2 grid gap-1">
                                {entries.slice(0, 12).map((item, index) => {
                                  const entry = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                                  return (
                                    <code className="truncate text-[10px] text-[#65707b]" key={`${value(entry.path ?? "file")}-${index}`}>
                                      {value(entry.status ?? "??")} {value(entry.path ?? "未命名")}
                                    </code>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      })()
                    : null}
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">执行 workspace_tree 后显示工作区结构。</div>
          )}
        </div>
      ) : panel.id === "prompt-library-panel" ? (
        <div className="mt-3 grid gap-3">
          {Array.isArray(data?.templates) && data.templates.length > 0 ? (
            <div className="grid gap-2">
              {data.templates.slice(0, 12).map((item, index) => {
                const template = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                const tags = Array.isArray(template.tags) ? template.tags.filter((tag): tag is string => typeof tag === "string") : [];
                return (
                  <div className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-3" key={`${value(template.id ?? "prompt")}-${index}`}>
                    <div className="flex items-center justify-between gap-2">
                      <strong className="truncate text-[11px] text-[#253044]">{value(template.title ?? "未命名提示词")}</strong>
                      <code className="shrink-0 text-[10px] text-[#687381]">{value(template.id ?? "—")}</code>
                    </div>
                    <p className="mt-2 line-clamp-2 text-[10px] leading-4 text-[#65707b]">{value(template.prompt ?? "")}</p>
                    {tags.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {tags.slice(0, 6).map((tag) => (
                          <span className="rounded bg-[#f6f8ff] px-1.5 py-0.5 text-[9px] text-[#315fb8]" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              还没有保存的提示词。可让 Agent 调用 prompt_library 保存模板。
            </div>
          )}
          <p className="text-[10px] leading-4 text-[#687381]">共 {value(data?.total ?? 0)} 个模板，数据跟随当前会话。</p>
        </div>
      ) : panel.id === "colleague-skill-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const handoff = data.latest as Record<string, unknown>;
              const list = (key: string): string[] =>
                Array.isArray(handoff[key]) ? handoff[key].filter((item): item is string => typeof item === "string") : [];
              const constraints = list("constraints");
              const files = list("files");
              const acceptance = list("acceptance");
              return (
                <>
                  <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
                    <span className="text-[11px] text-[#65707b]">交接给</span>
                    <strong className="text-[11px] text-[#315fb8]">{value(handoff.toRole)}</strong>
                  </div>
                  <div className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-3 text-[11px] text-[#253044]">{value(handoff.objective)}</div>
                  {handoff.context ? <p className="rounded-lg bg-[#f6f8fa] px-3 py-2 text-[10px] leading-4 text-[#65707b]">{value(handoff.context)}</p> : null}
                  {files.length > 0 ? (
                    <div className="grid gap-1 rounded-lg border border-[#edf0f3] bg-white px-3 py-2">
                      {files.slice(0, 8).map((file) => (
                        <code className="truncate text-[10px] text-[#65707b]" key={file}>
                          {file}
                        </code>
                      ))}
                    </div>
                  ) : null}
                  {constraints.length > 0 ? (
                    <div className="rounded-lg border border-[#edf0f3] bg-[#fffaf0] px-3 py-2">
                      <strong className="text-[10px] text-[#9a6700]">约束</strong>
                      <ul className="mt-1 grid gap-1 text-[10px] text-[#65707b]">
                        {constraints.slice(0, 8).map((constraint, index) => (
                          <li key={`${constraint}-${index}`}>• {constraint}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {acceptance.length > 0 ? (
                    <div className="rounded-lg border border-[#edf0f3] bg-[#f0fbf4] px-3 py-2">
                      <strong className="text-[10px] text-[#14733f]">验收条件</strong>
                      <ul className="mt-1 grid gap-1 text-[10px] text-[#65707b]">
                        {acceptance.slice(0, 8).map((criterion, index) => (
                          <li key={`${criterion}-${index}`}>• {criterion}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2 text-[10px] text-[#65707b]">
                    <span>约束 {constraints.length} 条</span>
                    <span>验收 {acceptance.length} 条</span>
                  </div>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              执行 colleague_handoff 后显示角色交接包。
            </div>
          )}
        </div>
      ) : panel.id === "reverse-skill-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
            <span className="text-[11px] text-[#65707b]">复核风险内容</span>
            <strong className="font-mono text-[11px] text-[#3565c5]">{data?.allowReviewByDefault === true ? "已允许" : "默认阻断"}</strong>
          </div>
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const latest = data.latest as Record<string, unknown>;
              const risk = value(latest.risk ?? "safe");
              const findings = Array.isArray(latest.findings) ? latest.findings : [];
              return (
                <div
                  className={`rounded-lg border px-3 py-3 text-[11px] ${risk === "blocked" ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" : risk === "review" ? "border-[#f3dfab] bg-[#fffaf0] text-[#9a6700]" : "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"}`}
                >
                  <div className="flex items-center justify-between">
                    <strong className="uppercase">{risk}</strong>
                    <span className="font-mono text-[10px]">{latest.contentIncluded === true ? "可注入" : "已隔离"}</span>
                  </div>
                  <p className="mt-2">
                    {value(latest.name ?? "未命名 Skill")} · {value(findings.length)} 个风险项
                  </p>
                  {findings.length > 0 ? (
                    <p className="mt-1 text-[10px] opacity-80">
                      {findings
                        .slice(0, 2)
                        .map((item) => value(item))
                        .join("；")}
                    </p>
                  ) : null}
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">执行 skill_inject 后显示隔离结果。</div>
          )}
          <p className="text-[10px] leading-4 text-[#687381]">安全内容会被包裹为不可信数据；review 风险默认不注入，blocked 内容永不返回原文。</p>
        </div>
      ) : panel.id === "reviewer-bot-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
              const status = value(report.status ?? "pass");
              const findings = Array.isArray(report.findings) ? report.findings : [];
              return (
                <>
                  <div
                    className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${status === "error" ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" : status === "warning" ? "border-[#f3dfab] bg-[#fffaf0] text-[#9a6700]" : "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"}`}
                  >
                    <span>{status === "error" ? "发现阻断风险" : status === "warning" ? "需要关注" : "审查通过"}</span>
                    <strong className="font-mono">{value(findings.length)} findings</strong>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      ["文件", report.changedFiles ?? 0],
                      ["新增", report.addedLines ?? 0],
                      ["删除", report.removedLines ?? 0],
                    ].map(([label, item]) => (
                      <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                        <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                        <strong className="mt-1 block text-[17px] text-[#30343b]">{value(item)}</strong>
                      </div>
                    ))}
                  </div>
                  {findings.length > 0 ? (
                    <ul className="grid gap-1 rounded-lg border border-[#e3e7ee] bg-white px-4 py-3 text-[10px] text-[#65707b]">
                      {findings.slice(0, 4).map((finding, index) => (
                        <li key={index}>
                          {value(typeof finding === "object" && finding !== null ? ((finding as Record<string, unknown>).message ?? "finding") : finding)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              还没有审查当前改动。可让 Agent 调用 review_changes。
            </div>
          )}
        </div>
      ) : panel.id === "auto-mode-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px]">
            <span className="font-medium text-[#30343b]">{data?.mode === "confirm" ? "确认模式" : "安全模式"}</span>
            <span className="font-mono text-[#65707b]">超时 {value(data?.timeoutMs ?? "—")} ms</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              <span className="block text-[10px] text-[#687381]">阻断次数</span>
              <strong className="mt-1 block text-[17px] text-[#30343b]">{value(data?.blocked ?? 0)} 次</strong>
            </div>
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              <span className="block text-[10px] text-[#687381]">最近命令</span>
              <strong className="mt-1 block truncate font-mono text-[11px] text-[#30343b]">
                {data?.last && typeof data.last === "object" ? value((data.last as Record<string, unknown>).command ?? "—") : "—"}
              </strong>
            </div>
          </div>
          {data?.last && typeof data.last === "object" ? (
            <pre className="max-h-32 overflow-auto rounded-lg border border-[#edf0f3] bg-[#fbfcfd] p-3 text-[10px] leading-4 text-[#65707b]">
              {value((data.last as Record<string, unknown>).stdout, "") || value((data.last as Record<string, unknown>).stderr ?? "无输出")}
            </pre>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              尚未执行命令。Agent 可调用 auto_mode_exec。
            </div>
          )}
        </div>
      ) : panel.id === "plan-execute-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <span className="truncate text-[11px] font-medium text-[#30343b]">{data?.title ? value(data.title) : "尚未创建计划"}</span>
            <span className="font-mono text-[11px] text-[#3565c5]">
              {value(data?.completed ?? 0)} / {value(data?.total ?? 0)}
            </span>
          </div>
          {Array.isArray(data?.steps) && data.steps.length > 0 ? (
            <ol className="grid gap-1.5">
              {data.steps.map((step, index) => {
                const item = step && typeof step === "object" ? (step as Record<string, unknown>) : {};
                const status = value(item.status ?? "pending");
                return (
                  <li className="flex items-center gap-2 rounded-lg border border-[#edf0f3] bg-white px-3 py-2 text-[11px]" key={value(item.id ?? index)}>
                    <span
                      className={`h-2 w-2 rounded-full ${status === "done" ? "bg-[#32a35a]" : status === "in_progress" ? "bg-[#3565c5]" : status === "skipped" ? "bg-[#a0a7b0]" : "bg-[#d7dce2]"}`}
                    />
                    <span className={`min-w-0 flex-1 truncate ${status === "done" ? "text-[#14733f]" : "text-[#30343b]"}`}>{value(item.title ?? "步骤")}</span>
                    {Array.isArray(item.dependsOn) && item.dependsOn.length > 0 && (
                      <span className="text-[10px] text-[#687381]">依赖步骤 {item.dependsOn.map((id) => value(id)).join(", ")}</span>
                    )}
                    <span className="font-mono text-[10px] text-[#687381]">{status}</span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">Agent 可调用 plan_create 创建执行计划。</div>
          )}
        </div>
      ) : panel.id === "plugin-stars-panel" ? (
        (() => {
          const view = pluginStarsPanelView(data);
          if (view.malformed) {
            return (
              <div className="rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-3 text-[11px] text-[#b42318]">
                <strong className="block text-[12px]">Plugin Stars 面板数据异常</strong>
                <span className="mt-1 block">面板数据不完整或不可信，请重新加载排行榜。</span>
              </div>
            );
          }
          const latest = view.latest;
          const rows = latest?.results ?? [];
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px]">
                <span className="font-medium text-[#30343b]">社区排行榜</span>
                <span className="font-mono text-[#65707b]">结果上限 {view.limit}</span>
              </div>
              {latest !== null ? (
                <>
                  <div className="flex items-center justify-between text-[11px] text-[#65707b]">
                    <span>查询：{latest.query || "全部"}</span>
                    <strong className="font-mono text-[#3565c5]">
                      显示 {view.inventory.shown}/{view.inventory.total}
                    </strong>
                  </div>
                  {rows.length > 0 ? (
                    <ol className="grid gap-1.5">
                      {rows.map((row) => (
                        <li className="flex items-center gap-2 rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={row.fullName}>
                          <span className="w-5 shrink-0 text-center font-mono text-[10px] text-[#9a6700]">#{row.rank}</span>
                          <div className="min-w-0 flex-1">
                            <a
                              className="block truncate font-mono text-[11px] text-[#315fb8] hover:underline"
                              href={row.htmlUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {row.fullName}
                            </a>
                            <span className="block truncate text-[10px] text-[#687381]">更新于 {row.updatedAt || "未知"}</span>
                          </div>
                          <span className="shrink-0 font-mono text-[10px] text-[#8a5a00]">★ {row.stars.toLocaleString()}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">没有找到匹配的社区插件。</div>
                  )}
                  <p className="text-[10px] leading-4 text-[#687381]">来源：{latest.source || "dsh-plugin-stars"} · 仅展示公开仓库信息，不会自动安装。</p>
                </>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  Agent 可调用 plugin_stars_search 拉取并筛选社区排行榜。
                </div>
              )}
            </div>
          );
        })()
      ) : panel.id === "plugin-finder-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px]">
            <span className="font-medium text-[#30343b]">只读 Registry 搜索</span>
            <span className="font-mono text-[#65707b]">
              关键词 {value(data?.keyword ?? "pi-harness")} · 上限 {value(data?.limit ?? "—")}
            </span>
          </div>
          {data?.query ? (
            <>
              <div className="flex items-center justify-between text-[11px] text-[#65707b]">
                <span>查询：{value(data.query)}</span>
                <strong className="font-mono text-[#3565c5]">{value(data.total ?? 0)} 个结果</strong>
              </div>
              {data?.truncated === true && <p className="text-[10px] text-[#687381]">仅显示部分匹配结果，请缩小查询范围。</p>}
              {Array.isArray(data?.results) && data.results.length > 0 ? (
                <ul className="grid gap-1.5">
                  {data.results.slice(0, 5).map((result, index) => {
                    const item = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
                    return (
                      <li className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(item.name ?? "plugin")}-${index}`}>
                        <div className="flex items-center justify-between gap-2">
                          <strong className="truncate font-mono text-[11px] text-[#30343b]">{value(item.name ?? "未知插件")}</strong>
                          <span className="font-mono text-[10px] text-[#687381]">v{value(item.version ?? "—")}</span>
                        </div>
                        <p className="mt-1 truncate text-[10px] text-[#687381]">{value(item.description, "")}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">没有找到匹配插件。</div>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              Agent 可调用 plugin_search 搜索 npm Registry。
            </div>
          )}
        </div>
      ) : panel.id === "memory-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px]">
            <span className="font-medium text-[#30343b]">跨会话记忆</span>
            <span className="font-mono text-[#3565c5]">{value(data?.count ?? 0)} 条</span>
          </div>
          {Array.isArray(data?.memories) && data.memories.length > 0 ? (
            <ul className="grid gap-1.5">
              {data.memories.slice(0, 5).map((memory, index) => {
                const item = memory && typeof memory === "object" ? (memory as Record<string, unknown>) : {};
                return (
                  <li className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(item.key ?? "memory")}-${index}`}>
                    <strong className="block truncate font-mono text-[11px] text-[#30343b]">{value(item.key ?? "未知键")}</strong>
                    <p className="mt-1 truncate text-[10px] text-[#687381]">{value(item.value, "")}</p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              尚未保存记忆。Agent 可调用 memory_set 明确写入。
            </div>
          )}
        </div>
      ) : panel.id === "graph-memory-panel" ? (
        (() => {
          const report = graphMemoryPanelView(data);
          const kinds = report.kinds;
          const recent = report.recent;
          const recentRelations = report.recentRelations;
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["任务", kinds.task ?? 0, "bg-[#3565c5]"],
                  ["技能", kinds.skill ?? 0, "bg-[#22a06b]"],
                  ["事件", kinds.event ?? 0, "bg-[#d97706]"],
                ].map(([label, count, color]) => (
                  <div className="rounded-lg border border-[#edf0f3] bg-[#f8fafc] px-3 py-2" key={value(label)}>
                    <div className="flex items-center gap-1.5 text-[10px] text-[#687381]">
                      <span className={`h-1.5 w-1.5 rounded-full ${value(color)}`}></span>
                      {value(label)}
                    </div>
                    <strong className="mt-1 block font-mono text-[17px] text-[#30343b]">{value(count)}</strong>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2 text-[10px]">
                <span className="text-[#65707b]">本地关系图</span>
                <span className="font-mono text-[#3565c5]">
                  {report.nodes} 节点 · {report.relations} 关系
                </span>
              </div>
              {recent.length > 0 ? (
                <ul className="grid gap-1.5">
                  <li className="text-[9px] uppercase tracking-[0.08em] text-[#687381]">
                    最近节点 {Math.min(recent.length, 5)} / {report.nodes}
                  </li>
                  {recent.slice(0, 5).map((entry, index) => {
                    const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    const kind = item.kind === "task" || item.kind === "skill" || item.kind === "event" ? item.kind : "unknown";
                    const kindLabel = kind === "task" ? "任务" : kind === "skill" ? "技能" : kind === "event" ? "事件" : "未知";
                    const kindClass =
                      kind === "task"
                        ? "bg-[#edf3fe] text-[#315fb8]"
                        : kind === "skill"
                          ? "bg-[#eaf8f0] text-[#14733f]"
                          : kind === "event"
                            ? "bg-[#fff4e5] text-[#a15c00]"
                            : "bg-[#f2f3f5] text-[#65707b]";
                    return (
                      <li className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(item.id ?? "node")}-${index}`}>
                        <div className="flex items-center gap-2">
                          <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${kindClass}`}>{kindLabel}</span>
                          <strong className="min-w-0 flex-1 truncate text-[11px] text-[#30343b]">{value(item.label ?? "未命名节点")}</strong>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-[#65707b]">{value(item.summary, "")}</p>
                        {item.source ? <p className="mt-1 truncate font-mono text-[9px] text-[#687381]">来源：{value(item.source)}</p> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  尚未记录图记忆。Agent 可调用 graph_memory_record 创建任务、技能或事件节点。
                </div>
              )}
              {recentRelations.length > 0 ? (
                <div className="grid gap-1 rounded-lg border border-[#edf0f3] bg-[#fbfcfd] px-3 py-2">
                  <span className="text-[9px] uppercase tracking-[0.08em] text-[#687381]">
                    最近关系 {Math.min(recentRelations.length, 3)} / {report.relations}
                  </span>
                  {recentRelations.slice(0, 3).map((entry, index) => {
                    const relation = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <div
                        className="flex min-w-0 items-center gap-1.5 font-mono text-[9px] text-[#65707b]"
                        key={`${value(relation.id ?? "relation")}-${index}`}
                      >
                        <span className="truncate">{value(relation.fromLabel ?? relation.from ?? "节点")}</span>
                        <span className="shrink-0 text-[#3565c5]">—{value(relation.relation ?? "RELATED_TO")}→</span>
                        <span className="truncate">{value(relation.toLabel ?? relation.to ?? "节点")}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {report.lastSearch !== null ? (
                <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2 text-[10px]">
                  <span className="min-w-0 truncate text-[#65707b]">最近搜索：{report.lastSearch.query}</span>
                  <span className="shrink-0 font-mono text-[#3565c5]">
                    {report.lastSearch.shown} / {report.lastSearch.total}
                  </span>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2 font-mono text-[9px] text-[#687381]">
                <span className="rounded bg-[#f6f8fa] px-2 py-1">节点 ≤ {report.limits.nodes}</span>
                <span className="rounded bg-[#f6f8fa] px-2 py-1">关系 ≤ {report.limits.relations}</span>
                <span className="rounded bg-[#f6f8fa] px-2 py-1">文件 ≤ {report.limits.fileBytes} B</span>
              </div>
              {report.truncated ? <p className="text-[10px] text-[#996515]">面板内容已按安全显示上限截断。</p> : null}
            </div>
          );
        })()
      ) : panel.id === "taskboard-panel" ? (
        (() => {
          const counts = data?.counts !== null && typeof data?.counts === "object" ? (data.counts as Record<string, unknown>) : {};
          const recent = Array.isArray(data?.recent) ? data.recent : [];
          const lanes = [
            ["待办", "todo", "bg-[#edf3fe] text-[#315fb8]"],
            ["进行中", "in_progress", "bg-[#fff4e5] text-[#a15c00]"],
            ["待验收", "in_review", "bg-[#f0edff] text-[#6b4fc3]"],
            ["已完成", "done", "bg-[#eaf8f0] text-[#14733f]"],
          ] as const;
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2 text-[10px]">
                <span className="text-[#65707b]">当前工作区任务</span>
                <strong className="font-mono text-[#3565c5]">{value(data?.total ?? 0)} 个</strong>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {lanes.map(([label, key, color]) => (
                  <div className="rounded-lg border border-[#edf0f3] bg-[#f8fafc] px-3 py-2" key={key}>
                    <div className="flex items-center justify-between text-[10px] text-[#687381]">
                      <span>{label}</span>
                      <span className={`rounded px-1.5 py-0.5 ${color}`}>{value(counts[key] ?? 0)}</span>
                    </div>
                  </div>
                ))}
              </div>
              {recent.length > 0 ? (
                <ul className="grid gap-1.5">
                  <li className="text-[9px] uppercase tracking-[0.08em] text-[#687381]">
                    最近任务 {Math.min(recent.length, 5)} / {value(data?.total ?? recent.length)}
                  </li>
                  {recent.slice(0, 5).map((entry, index) => {
                    const task = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    const status = typeof task.status === "string" ? task.status : "unknown";
                    const priority = typeof task.priority === "string" ? task.priority : "medium";
                    const statusLabel =
                      status === "backlog"
                        ? "待规划"
                        : status === "todo"
                          ? "待办"
                          : status === "in_progress"
                            ? "进行中"
                            : status === "in_review"
                              ? "待验收"
                              : status === "blocked"
                                ? "阻塞"
                                : status === "canceled"
                                  ? "已取消"
                                  : status === "done"
                                    ? "已完成"
                                    : "未知";
                    const statusClass =
                      status === "done"
                        ? "bg-[#eaf8f0] text-[#14733f]"
                        : status === "blocked" || status === "canceled"
                          ? "bg-[#fff5f5] text-[#b42318]"
                          : status === "unknown"
                            ? "bg-[#f2f3f5] text-[#65707b]"
                            : "bg-[#edf3fe] text-[#315fb8]";
                    return (
                      <li className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(task.id ?? "task")}-${index}`}>
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-[10px] text-[#3565c5]">{value(task.key ?? "PIH-?")}</code>
                          <strong className="min-w-0 flex-1 truncate text-[11px] text-[#30343b]">{value(task.title ?? "未命名任务")}</strong>
                          <span className={`rounded px-1.5 py-0.5 text-[9px] ${statusClass}`}>{statusLabel}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[9px] text-[#687381]">
                          <span>优先级 {priority}</span>
                          {task.dueDate ? <span>截止 {value(task.dueDate)}</span> : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  尚未创建任务。Agent 可调用 taskboard_create 创建带稳定编号的任务。
                </div>
              )}
            </div>
          );
        })()
      ) : panel.id === "skill-catalog-panel" ? (
        (() => {
          const skills = Array.isArray(data?.skills) ? data.skills : [];
          const servers = Array.isArray(data?.mcpServers) ? data.mcpServers : [];
          const diagnostics = Array.isArray(data?.diagnostics) ? data.diagnostics : [];
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2">
                  <span className="block text-[10px] text-[#687381]">Skills</span>
                  <strong className="mt-1 block font-mono text-[17px] text-[#315fb8]">{value(data?.skillCount ?? 0)}</strong>
                </div>
                <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2">
                  <span className="block text-[10px] text-[#687381]">MCP 服务器</span>
                  <strong className="mt-1 block font-mono text-[17px] text-[#315fb8]">{value(data?.mcpCount ?? 0)}</strong>
                </div>
              </div>
              {skills.length > 0 ? (
                <ul className="grid gap-1.5">
                  {skills.slice(0, 8).map((entry, index) => {
                    const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <li className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(item.name ?? "skill")}-${index}`}>
                        <div className="flex items-center gap-2">
                          <strong className="min-w-0 flex-1 truncate text-[11px] text-[#30343b]">{value(item.name, "未命名技能")}</strong>
                          <span className="rounded bg-[#f2f3f5] px-1.5 py-0.5 text-[9px] text-[#65707b]">{value(item.scope, "unknown")}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[10px] text-[#687381]">{value(item.description, "无描述")}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">当前运行时没有加载 Skill。</div>
              )}
              {servers.length > 0 ? (
                <div>
                  <div className="mb-1 text-[10px] font-semibold text-[#65707b]">MCP 状态</div>
                  <ul className="grid gap-1.5">
                    {servers.slice(0, 6).map((entry, index) => {
                      const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                      const running = item.status === "running";
                      return (
                        <li
                          className="flex items-center justify-between rounded-lg border border-[#edf0f3] bg-white px-3 py-2 text-[10px]"
                          key={`${value(item.id ?? "server")}-${index}`}
                        >
                          <span className="truncate font-mono text-[#65707b]">{value(item.id, "未命名服务器")}</span>
                          <span className={`rounded px-1.5 py-0.5 ${running ? "bg-[#eaf8f0] text-[#14733f]" : "bg-[#f2f3f5] text-[#65707b]"}`}>
                            {value(item.status, "unknown")}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              {diagnostics.length > 0 ? (
                <div className="rounded-lg border border-[#fff0c2] bg-[#fffaf0] px-3 py-2 text-[10px] text-[#8a5a00]">
                  资源诊断：{diagnostics.length} 条警告
                </div>
              ) : null}
              <div className="text-[10px] text-[#687381]">只读查看 runtime 已加载的 Skill 与 MCP 状态；配置写入仍由各自插件负责。</div>
            </div>
          );
        })()
      ) : panel.id === "cost-meter-panel" ? (
        (() => {
          const budget = typeof data?.budget === "number" ? data.budget : null;
          const budgetPercent = typeof data?.budgetPercent === "number" ? data.budgetPercent : null;
          const meterView = costMeterPanelView(data);
          const budgetClass =
            budgetPercent !== null && budgetPercent >= 100
              ? "text-[#b42318]"
              : budgetPercent !== null && budgetPercent >= 80
                ? "text-[#a15c00]"
                : "text-[#14733f]";
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["今日（UTC）", `$${Number(data?.todayCost ?? 0).toFixed(4)}`],
                  ["当前会话", `$${Number(data?.sessionCost ?? 0).toFixed(4)}`],
                  ["累计", `$${Number(data?.lifetimeCost ?? 0).toFixed(4)}`],
                ].map(([label, item]) => (
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                    <strong className="mt-1 block font-mono text-[15px] font-semibold text-[#30343b]">{value(item)}</strong>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[#65707b]">每日预算（UTC）</span>
                  <strong className={budgetClass}>{budget === null ? "未设置" : `$${budget.toFixed(4)} · ${budgetPercent?.toFixed(2) ?? "0.00"}%`}</strong>
                </div>
                {budget !== null ? (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#dfe8f7]">
                    <div
                      className={`h-full ${budgetPercent !== null && budgetPercent >= 100 ? "bg-[#d64545]" : "bg-[#4c83e8]"}`}
                      style={{ width: `${Math.min(100, budgetPercent ?? 0)}%` }}
                    />
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2 text-[10px] text-[#687381]">
                <span className="rounded bg-[#f6f8fa] px-2 py-1">{meterView.dayBasis} 日账本</span>
                <span className="rounded bg-[#f6f8fa] px-2 py-1">展示上限 {meterView.entryLimit ?? "—"} 条</span>
              </div>
              {meterView.lastError !== null ? (
                <div className="rounded-lg border border-[#f0c8c4] bg-[#fff5f4] px-3 py-2 text-[10px] text-[#b42318]">最近写入错误：{meterView.lastError}</div>
              ) : null}
              {meterView.entries.length > 0 ? (
                <ul className="grid gap-1.5">
                  {meterView.entries.map((entry, index) => (
                    <li className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2 text-[10px]" key={`${entry.sessionId}-${entry.utcDate}-${index}`}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate font-mono text-[#65707b]">{entry.sessionId}</span>
                        <strong className="shrink-0 font-mono text-[#30343b]">${entry.dailyCost.toFixed(4)} 当日增量</strong>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[#7a8490]">
                        <span>UTC {entry.utcDate}</span>
                        <span>会话累计 ${entry.sessionCost.toFixed(4)}</span>
                        <span>{entry.tokens} tokens</span>
                        <span>{entry.messages} 消息</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  尚未记录已完成会话。Agent 可调用 cost_report 的 refresh 操作写入账本。
                </div>
              )}
              <div className="text-[10px] text-[#687381]">仅记录运行时报告的实际成本，不内置或猜测模型价格。</div>
            </div>
          );
        })()
      ) : panel.id === "undo-savepoint-panel" ? (
        (() => {
          const savepoints = Array.isArray(data?.savepoints) ? data.savepoints : [];
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2">
                  <span className="block text-[10px] text-[#687381]">保存点</span>
                  <strong className="mt-1 block font-mono text-[17px] text-[#315fb8]">{value(data?.count ?? savepoints.length)}</strong>
                </div>
                <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2">
                  <span className="block text-[10px] text-[#687381]">跟踪路径</span>
                  <strong className="mt-1 block font-mono text-[17px] text-[#315fb8]">
                    {value(Array.isArray(data?.trackedPaths) ? data.trackedPaths.length : 0)}
                  </strong>
                </div>
              </div>
              {savepoints.length > 0 ? (
                <ul className="grid gap-1.5">
                  {savepoints.slice(0, 6).map((entry, index) => {
                    const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <li className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(item.id ?? "savepoint")}-${index}`}>
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-[10px] text-[#3565c5]">{value(item.id, "unknown")}</code>
                          <strong className="min-w-0 flex-1 truncate text-[11px] text-[#30343b]">{value(item.reason, "manual savepoint")}</strong>
                          <span className="text-[9px] text-[#687381]">{value(item.fileCount, "0")} 文件</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  尚未创建保存点。修改配置或插件代码前，让 Agent 调用 undo_savepoint 的 save 操作。
                </div>
              )}
              <div className="text-[10px] text-[#687381]">恢复操作要求 confirm=true；敏感文件、二进制文件和依赖目录不会进入保存点。</div>
            </div>
          );
        })()
      ) : panel.id === "annotation-panel" ? (
        (() => {
          const annotations = Array.isArray(data?.annotations) ? data.annotations : [];
          const lastPrompt = typeof data?.lastPrompt === "string" ? data.lastPrompt : "";
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2 text-[10px]">
                <span className="text-[#65707b]">待发送批注</span>
                <strong className="font-mono text-[#3565c5]">{value(data?.count ?? 0)} 条</strong>
              </div>
              {annotations.length > 0 ? (
                <ol className="grid gap-1.5">
                  {annotations.slice(0, 8).map((entry, index) => {
                    const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <li className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(item.id ?? index)}-${index}`}>
                        <div className="flex items-start gap-2 text-[10px]">
                          <span className="rounded bg-[#edf3fe] px-1.5 py-0.5 font-mono text-[#315fb8]">#{value(item.id ?? index + 1)}</span>
                          <p className="min-w-0 flex-1 whitespace-pre-wrap text-[#30343b]">{value(item.quote, "")}</p>
                        </div>
                        {item.note ? <p className="mt-1 pl-8 text-[10px] text-[#687381]">{value(item.note)}</p> : null}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  尚未收集批注。Agent 可调用 annotation_manage 的 add 操作记录回复片段。
                </div>
              )}
              {lastPrompt ? (
                <details className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-2 text-[10px]">
                  <summary className="cursor-pointer text-[#65707b]">最近生成的提问上下文</summary>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] text-[#30343b]">{lastPrompt}</pre>
                </details>
              ) : null}
              <div className="text-[10px] text-[#687381]">批注按编号累积；生成上下文不会改写原会话消息。</div>
            </div>
          );
        })()
      ) : panel.id === "runtime-doctor-panel" ? (
        (() => {
          const status = value(data?.status ?? "unknown");
          const checks = Array.isArray(data?.checks) ? data.checks : [];
          const recommendations = Array.isArray(data?.recommendations) ? data.recommendations : [];
          const statusClass =
            status === "ok" ? "bg-[#eaf8f0] text-[#14733f]" : status === "warning" ? "bg-[#fff7e8] text-[#a15c00]" : "bg-[#fff0f0] text-[#b42318]";
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2">
                <span className="text-[11px] text-[#65707b]">运行时边界检查</span>
                <span className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase ${statusClass}`}>{status}</span>
              </div>
              <div className="grid gap-1.5">
                {checks.map((entry, index) => {
                  const check = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                  const checkStatus = value(check.status ?? "unknown");
                  const checkClass =
                    checkStatus === "ok"
                      ? "bg-[#eaf8f0] text-[#14733f]"
                      : checkStatus === "warning"
                        ? "bg-[#fff7e8] text-[#a15c00]"
                        : "bg-[#fff0f0] text-[#b42318]";
                  return (
                    <div
                      className="flex items-center gap-2 rounded-lg border border-[#edf0f3] bg-white px-3 py-2 text-[10px]"
                      key={`${value(check.id ?? "check")}-${index}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${checkStatus === "ok" ? "bg-[#22c55e]" : checkStatus === "warning" ? "bg-[#e6a21a]" : "bg-[#d64545]"}`}
                      ></span>
                      <code className="w-20 shrink-0 text-[#65707b]">{value(check.id ?? "check")}</code>
                      <span className="min-w-0 flex-1 truncate text-[#30343b]">{value(check.detail ?? "—")}</span>
                      <span className={`rounded px-1.5 py-0.5 font-mono ${checkClass}`}>{checkStatus}</span>
                    </div>
                  );
                })}
              </div>
              {recommendations.length > 0 ? (
                <div className="rounded-lg border border-[#f3dfab] bg-[#fffaf0] px-3 py-2 text-[10px] text-[#8a6200]">
                  <strong>建议</strong>
                  <ul className="mt-1 grid gap-1 pl-4">
                    {recommendations.slice(0, 5).map((item, index) => (
                      <li key={`${value(item)}-${index}`}>{value(item)}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        })()
      ) : panel.id === "plugin-check-panel" ? (
        (() => {
          const latest = data?.latest !== null && typeof data?.latest === "object" ? (data.latest as Record<string, unknown>) : undefined;
          const checks = latest?.checks !== null && typeof latest?.checks === "object" ? (latest.checks as Record<string, unknown>) : undefined;
          const errors: unknown[] = Array.isArray(latest?.errors) ? latest.errors : [];
          const warnings: unknown[] = Array.isArray(latest?.warnings) ? latest.warnings : [];
          const reports: unknown[] = Array.isArray(latest?.reports) ? latest.reports : [];
          const schema: unknown[] = Array.isArray(latest?.checks) ? latest.checks : [];
          const verdict = value(latest?.verdict ?? "—");
          const verdictClass =
            verdict === "pass" ? "bg-[#eaf8f0] text-[#14733f]" : verdict === "warn" ? "bg-[#fff7e8] text-[#a15c00]" : "bg-[#fff0f0] text-[#b42318]";
          return (
            <div className="mt-3 grid gap-3">
              {latest?.scanned !== undefined ? (
                <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2 text-[10px]">
                  <span className="text-[#65707b]">目录扫描</span>
                  <strong className="font-mono text-[#3565c5]">{value(latest.scanned)} 个仓库</strong>
                </div>
              ) : latest?.verdict !== undefined ? (
                <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f8fafc] px-3 py-2 text-[10px]">
                  <span className="truncate text-[#65707b]">{value(latest.repo ?? "当前插件")}</span>
                  <span className={`rounded px-1.5 py-0.5 font-mono ${verdictClass}`}>{verdict}</span>
                </div>
              ) : schema.length > 0 ? (
                <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2 text-[10px] text-[#65707b]">检查清单：{schema.length} 项</div>
              ) : null}
              {checks ? (
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["通过", checks.passed ?? 0],
                    ["失败", checks.failed ?? 0],
                    ["警告", checks.warned ?? 0],
                  ].map(([label, count]) => (
                    <div className="rounded-lg border border-[#edf0f3] bg-[#f8fafc] px-3 py-2" key={value(label)}>
                      <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                      <strong className="mt-1 block font-mono text-[17px] text-[#30343b]">{value(count)}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
              {reports.length > 0 ? (
                <ul className="grid gap-1.5">
                  {reports.slice(0, 6).map((entry, index) => {
                    const report = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    const state = value(report.verdict ?? "—");
                    return (
                      <li
                        className="flex items-center justify-between rounded-lg border border-[#edf0f3] bg-white px-3 py-2 text-[10px]"
                        key={`${value(report.repo ?? "repo")}-${index}`}
                      >
                        <span className="truncate font-mono text-[#65707b]">{value(report.repo ?? "未知仓库")}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 ${state === "pass" ? "bg-[#eaf8f0] text-[#14733f]" : state === "warn" ? "bg-[#fff7e8] text-[#a15c00]" : "bg-[#fff0f0] text-[#b42318]"}`}
                        >
                          {state}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : errors.length > 0 || warnings.length > 0 ? (
                <ul className="grid gap-1.5">
                  {[...errors, ...warnings].slice(0, 5).map((entry, index) => {
                    const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <li className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2 text-[10px]" key={`${value(item.code ?? "issue")}-${index}`}>
                        <strong className="font-mono text-[#b42318]">{value(item.code ?? "issue")}</strong>
                        <p className="mt-1 text-[#65707b]">{value(item.message, "")}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  尚未检查插件。Agent 可调用 plugin_check 执行 check、scan 或 schema。
                </div>
              )}
              <div className="text-[10px] text-[#687381]">只读检查，不修改、不构建被检仓库。</div>
            </div>
          );
        })()
      ) : panel.id === "plugin-radar-panel" ? (
        (() => {
          const results = Array.isArray(data?.results) ? data.results : [];
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-2 text-[10px]">
                <span className="text-[#65707b]">GitHub Pi Harness 生态</span>
                <span className="font-mono text-[#3565c5]">
                  {value(data?.total ?? 0)} 个仓库 · {Array.isArray(data?.sources) ? data.sources.length : 0} 个来源
                </span>
              </div>
              {data?.query ? <div className="text-[11px] text-[#65707b]">查询：{value(data.query)}</div> : null}
              {results.length > 0 ? (
                <ol className="grid gap-1.5">
                  {results.slice(0, 8).map((entry, index) => {
                    const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    const topics = Array.isArray(item.topics) ? item.topics.filter((topic): topic is string => typeof topic === "string").slice(0, 3) : [];
                    const url = typeof item.url === "string" ? item.url : undefined;
                    return (
                      <li className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(item.fullName ?? "repo")}-${index}`}>
                        <div className="flex items-center gap-2">
                          <span className="w-4 shrink-0 text-right font-mono text-[10px] text-[#687381]">{index + 1}</span>
                          {url ? (
                            <a
                              className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#315fb8] hover:underline"
                              href={url}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {value(item.fullName ?? item.name ?? "未知仓库")}
                            </a>
                          ) : (
                            <strong className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#30343b]">
                              {value(item.fullName ?? item.name ?? "未知仓库")}
                            </strong>
                          )}
                          <span className="shrink-0 font-mono text-[10px] text-[#a15c00]">★ {value(item.stars ?? 0)}</span>
                        </div>
                        <p className="mt-1 truncate pl-6 text-[10px] text-[#65707b]">{value(item.description, "暂无描述")}</p>
                        <div className="mt-1 flex min-w-0 items-center gap-2 pl-6 text-[9px] text-[#687381]">
                          {item.language ? <span>{value(item.language)}</span> : null}
                          {item.updatedAt ? <span className="font-mono">更新 {value(item.updatedAt)}</span> : null}
                          {topics.length > 0 ? <span className="truncate">{topics.map((topic) => `#${topic}`).join(" ")}</span> : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  {data?.fetchedAt ? "未找到匹配的 Pi Harness 仓库。" : "尚未搜索插件。Agent 可调用 plugin_radar_search 从 GitHub 发现 Pi Harness 插件。"}
                </div>
              )}
              {data?.truncated || results.length > 8 ? (
                <p className="text-[10px] text-[#687381]">仅展示部分结果，可缩小查询范围；GitHub 可能返回不完整结果。</p>
              ) : null}
              <div className="text-[10px] text-[#687381]">按 Star 排序的 Topic 匹配仓库，尚未验证插件可安装性；不会安装或执行仓库代码。</div>
            </div>
          );
        })()
      ) : panel.id === "hol-guard-panel" ? (
        (() => {
          const receipts = Array.isArray(data?.receipts) ? data.receipts : [];
          const latest = data?.latest !== null && typeof data?.latest === "object" ? (data.latest as Record<string, unknown>) : undefined;
          const riskLabel = (risk: unknown): string => (risk === "blocked" ? "高风险" : risk === "review" ? "需复核" : "安全");
          const riskClass = (risk: unknown): string =>
            risk === "blocked" ? "bg-[#fff0f0] text-[#b42318]" : risk === "review" ? "bg-[#fff7e8] text-[#a15c00]" : "bg-[#eaf8f0] text-[#14733f]";
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["高风险", data?.blocked ?? 0],
                  ["需复核", data?.review ?? 0],
                  ["安全", data?.safe ?? 0],
                ].map(([label, count]) => (
                  <div className="rounded-lg border border-[#edf0f3] bg-[#f8fafc] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                    <strong className="mt-1 block font-mono text-[17px] text-[#30343b]">{value(count)}</strong>
                  </div>
                ))}
              </div>
              {latest ? (
                <div className={`flex items-center justify-between rounded-lg border border-[#e3e7ee] px-3 py-2 text-[10px] ${riskClass(latest.risk)}`}>
                  <span>最近一次：{value(latest.source, "unknown")}</span>
                  <strong>
                    {riskLabel(latest.risk)} · {value(latest.findings && Array.isArray(latest.findings) ? latest.findings.length : 0)} 项
                  </strong>
                </div>
              ) : null}
              {receipts.length > 0 ? (
                <ul className="grid gap-1.5">
                  <li className="text-[9px] uppercase tracking-[0.08em] text-[#687381]">最近风险摘要</li>
                  {receipts.slice(0, 8).map((entry, index) => {
                    const receipt = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    const findings = Array.isArray(receipt.findings) ? receipt.findings : [];
                    return (
                      <li
                        className="flex items-center gap-2 rounded-lg border border-[#edf0f3] bg-white px-3 py-2 text-[10px]"
                        key={`${value(receipt.source)}-${index}`}
                      >
                        <span className={`rounded px-1.5 py-0.5 ${riskClass(receipt.risk)}`}>{riskLabel(receipt.risk)}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[#65707b]">{value(receipt.source, "unknown")}</span>
                        <span className="text-[#687381]">{findings.length} 项</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  尚未收到工具调用。Agent 可调用 hol_guard_scan 预检命令或文本。
                </div>
              )}
              <div className="text-[10px] text-[#687381]">
                仅保存风险摘要和计数，不保存命令、路径或凭据原文；风险等级仅供审计，HOL Guard 不会阻止任何工具执行。
              </div>
            </div>
          );
        })()
      ) : panel.id === "synapse-panel" ? (
        (() => {
          const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
          const edges = Array.isArray(data?.edges) ? data.edges : [];
          const nodeById = new Map(
            nodes.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object").map((entry) => [value(entry.id), entry]),
          );
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["会话", data?.nodes ?? 0],
                  ["分支", data?.edges ?? 0],
                  ["孤儿", data?.orphanCount ?? 0],
                ].map(([label, count]) => (
                  <div className="rounded-lg border border-[#edf0f3] bg-[#f8fafc] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                    <strong className="mt-1 block font-mono text-[17px] text-[#30343b]">{value(count)}</strong>
                  </div>
                ))}
              </div>
              {data?.activeSessionId ? (
                <div className="rounded-lg border border-[#b9d0ff] bg-[#f1f6ff] px-3 py-2 text-[10px] text-[#315fb8]">
                  当前会话：<code className="font-mono">{value(data.activeSessionId)}</code>
                </div>
              ) : null}
              {nodes.length > 0 ? (
                <ul className="grid gap-1.5">
                  <li className="text-[9px] uppercase tracking-[0.08em] text-[#687381]">
                    最近会话 {Math.min(nodes.length, 8)} / {nodes.length}
                  </li>
                  {nodes.slice(0, 8).map((entry, index) => {
                    const node = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <li
                        className={`rounded-lg border px-3 py-2 ${node.active === true ? "border-[#b9d0ff] bg-[#f7faff]" : "border-[#edf0f3] bg-white"}`}
                        key={`${value(node.id ?? "session")}-${index}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${node.active === true ? "bg-[#3565c5]" : "bg-[#c4ccd6]"}`}></span>
                          <strong className="min-w-0 flex-1 truncate text-[11px] text-[#30343b]">{value(node.label ?? node.sessionId ?? "未命名会话")}</strong>
                          <span className="font-mono text-[9px] text-[#687381]">{value(node.messageCount ?? 0)} 条消息</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[9px] text-[#687381]">
                          <span className="min-w-0 flex-1 truncate font-mono">{value(node.cwd ?? "未知工作区")}</span>
                          <span>{value(node.branchCount ?? 0)} 个分支</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">当前工作区还没有可投影的持久化会话。</div>
              )}
              {edges.length > 0 ? (
                <div className="grid gap-1 rounded-lg border border-[#edf0f3] bg-[#fbfcfd] px-3 py-2">
                  <span className="text-[9px] uppercase tracking-[0.08em] text-[#687381]">Fork 关系</span>
                  {edges.slice(0, 5).map((entry, index) => {
                    const edge = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    const from = nodeById.get(value(edge.from));
                    const to = nodeById.get(value(edge.to));
                    return (
                      <div
                        className="flex min-w-0 items-center gap-1.5 font-mono text-[9px] text-[#65707b]"
                        key={`${value(edge.from)}-${value(edge.to)}-${index}`}
                      >
                        <span className="truncate">{value(from?.label ?? edge.from)}</span>
                        <span className="shrink-0 text-[#3565c5]">→ fork →</span>
                        <span className="truncate">{value(to?.label ?? edge.to)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <div className="text-[10px] text-[#687381]">数据来源：Pi 原生 JSONL 会话；Agent 可调用 synapse_session_map 刷新。</div>
            </div>
          );
        })()
      ) : panel.id === "archify-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
              const components = Array.isArray(report.components) ? report.components : [];
              const dependencies = Array.isArray(report.dependencies) ? report.dependencies : [];
              return (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                      <span className="block text-[10px] text-[#687381]">组件</span>
                      <strong className="mt-1 block text-[17px] text-[#30343b]">{value(components.length)}</strong>
                    </div>
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                      <span className="block text-[10px] text-[#687381]">外部依赖</span>
                      <strong className="mt-1 block text-[17px] text-[#30343b]">{value(dependencies.length)}</strong>
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    {components.slice(0, 8).map((entry, index) => {
                      const component = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                      return (
                        <div
                          className="flex items-center gap-2 rounded-lg border border-[#edf0f3] bg-white px-3 py-2 text-[11px]"
                          key={`${value(component.path ?? "component")}-${index}`}
                        >
                          <span className="h-2 w-2 rounded-full bg-[#3565c5]"></span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[#30343b]">{value(component.path ?? "组件")}</span>
                          <span className="font-mono text-[10px] text-[#687381]">{value(component.files ?? 0)} files</span>
                        </div>
                      );
                    })}
                  </div>
                  {dependencies.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {dependencies.slice(0, 12).map((dependency, index) => (
                        <span
                          className="rounded-md border border-[#dce5f5] bg-[#f6f8ff] px-2 py-1 font-mono text-[10px] text-[#315fb8]"
                          key={`${value(dependency)}-${index}`}
                        >
                          {value(dependency)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <pre className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3] bg-[#fbfcfd] p-3 text-[10px] leading-4 text-[#65707b]">
                    {value(report.mermaid, "")}
                  </pre>
                  {report.truncated === true ? <p className="text-[10px] text-[#8a5a00]">扫描达到节点上限，架构图可能不完整。</p> : null}
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              Agent 可调用 architecture_map 生成当前工作区架构图。
            </div>
          )}
        </div>
      ) : panel.id === "canvas-draw-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px]">
            <span className="font-medium text-[#30343b]">Mermaid 流程图</span>
            <span className="font-mono text-[#3565c5]">
              {value(data?.nodeCount ?? 0)} 节点 · {value(data?.edgeCount ?? 0)} 连线
            </span>
          </div>
          {data?.latest && typeof data.latest === "object" ? (
            <pre className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3] bg-[#fbfcfd] p-3 text-[10px] leading-4 text-[#65707b]">
              {value((data.latest as Record<string, unknown>).mermaid, "")}
            </pre>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              Agent 可调用 canvas_draw 生成流程图源码。
            </div>
          )}
        </div>
      ) : panel.id === "image-compressor-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px]">
            <span className="font-medium text-[#30343b]">PNG 无损压缩</span>
            <span className="font-mono text-[#65707b]">上限 32 MiB</span>
          </div>
          {data?.last && typeof data.last === "object" ? (
            (() => {
              const report = data.last as Record<string, unknown>;
              return (
                <div className="rounded-lg border border-[#b9e6c9] bg-[#f0fbf4] px-3 py-3 text-[11px] text-[#14733f]">
                  {value(report.inputPath ?? "图片")} → {value(report.outputPath ?? "输出")}，节省 {value(report.savedBytes ?? 0)} bytes
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              Agent 可调用 image_compress，写入前必须 confirm=true。
            </div>
          )}
        </div>
      ) : panel.id === "workspace-search-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px]">
            <span className="font-medium text-[#30343b]">工作区文本检索</span>
            <span className="font-mono text-[#3565c5]">{value(data?.matchCount ?? 0)} 个匹配</span>
          </div>
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
              const matches = Array.isArray(report.matches) ? report.matches : [];
              return matches.length > 0 ? (
                <ul className="grid gap-1.5">
                  {matches.slice(0, 5).map((match, index) => {
                    const item = match && typeof match === "object" ? (match as Record<string, unknown>) : {};
                    return (
                      <li className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(item.path ?? "match")}-${index}`}>
                        <strong className="block truncate font-mono text-[10px] text-[#3565c5]">
                          {value(item.path ?? "未知文件")}:{value(item.line ?? "?")}
                        </strong>
                        <p className="mt-1 truncate font-mono text-[10px] text-[#65707b]">{value(item.text, "")}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">没有找到匹配内容。</div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              Agent 可调用 workspace_search 检索当前工作区。
            </div>
          )}
        </div>
      ) : panel.id === "recall-unread-panel" ? (
        (() => {
          const view = recallUnreadPanelView(data);
          const visible = view.items.slice(0, 8);
          return (
            <div className="mt-3 grid gap-3">
              {view.status.state === "failed" || view.status.state === "cancelled" ? (
                <div
                  className={`rounded-lg border px-3 py-3 text-[11px] leading-5 ${
                    view.status.state === "failed" ? "border-[#f3c4c4] bg-[#fff4f4] text-[#a23b3b]" : "border-[#f4d8a8] bg-[#fff9ed] text-[#9a6700]"
                  }`}
                >
                  扫描{view.status.state === "failed" ? "失败" : "已取消"}
                  {view.status.error === null ? "" : `：${view.status.error}`}
                </div>
              ) : null}
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["候选", view.inventory.candidates],
                  ["已扫描", view.inventory.scanned],
                  ["未回答", view.total],
                ].map(([label, item]) => (
                  <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                    <strong className="mt-1 block font-mono text-[17px] text-[#30343b]">{value(item)}</strong>
                  </div>
                ))}
              </div>
              {visible.length > 0 ? (
                <div className="grid gap-2">
                  {visible.map((session, index) => (
                    <div className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${session.id}-${index}`}>
                      <div className="flex items-center justify-between gap-2">
                        <strong className="min-w-0 flex-1 truncate text-[11px] text-[#30343b]">{session.name}</strong>
                        <span className="shrink-0 font-mono text-[9px] text-[#687381]">{session.messageCount} 条消息</span>
                      </div>
                      <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[10px] leading-4 text-[#65707b]">{session.message}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">没有以未回答用户消息结束的会话。</div>
              )}
              <p className="text-[10px] leading-4 text-[#687381]">
                已扫描 {view.inventory.scanned}/{view.inventory.available} 个会话文件，界面显示 {visible.length}/{view.inventory.unread}{" "}
                个；只读扫描，不会修改会话。
                {view.inventory.truncated ? " 部分结果因发现、扫描或展示上限被截断。" : ""}
              </p>
            </div>
          );
        })()
      ) : panel.id === "turn-rewind-panel" ? (
        (() => {
          const view = turnRewindPanelView(data);
          const statusLabel = {
            queued: "已排队",
            running: "执行中",
            completed: "已回退",
            failed: "失败",
            cancelled: "已取消",
          } as const;
          const statusTone = {
            queued: "border-[#dce5f5] bg-[#f6f8ff] text-[#3565c5]",
            running: "border-[#dce5f5] bg-[#f6f8ff] text-[#3565c5]",
            completed: "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]",
            failed: "border-[#f3c4c4] bg-[#fff4f4] text-[#a23b3b]",
            cancelled: "border-[#f4d8a8] bg-[#fff9ed] text-[#9a6700]",
          } as const;
          return (
            <div className="mt-3 grid gap-3">
              {view.latest === null ? (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">还没有执行回退操作。</div>
              ) : (
                <div className={`rounded-lg border px-3 py-3 ${statusTone[view.latest.status]}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em]">最近操作</span>
                    <span className="rounded-full bg-white/70 px-2 py-1 text-[10px] font-semibold">{statusLabel[view.latest.status]}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-[#30343b]">{view.latest.target.text}</p>
                  {view.latest.error === null ? null : <p className="mt-2 break-words text-[10px] leading-4">{view.latest.error}</p>}
                  {view.latest.summarized ? <p className="mt-2 text-[10px] leading-4">已请求分支摘要；该选项可能调用模型并产生费用。</p> : null}
                </div>
              )}
              <div className="grid gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#687381]">可回退轮次</span>
                {view.candidates.length > 0 ? (
                  view.candidates.map((candidate, index) => (
                    <div className="flex items-start gap-2 rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${candidate.entryId}-${index}`}>
                      <span className="mt-0.5 font-mono text-[10px] text-[#3565c5]">{view.candidates.length - index}</span>
                      <span className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-4 text-[#65707b]">{candidate.text}</span>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-[#edf0f3] bg-white px-3 py-3 text-[11px] text-[#687381]">当前会话还没有可回退的用户轮次。</div>
                )}
              </div>
              <p className="text-[10px] leading-4 text-[#687381]">
                已检查当前分支 {view.inventory.scannedEntries} 个条目；后端保留 {view.inventory.shown} 个候选，界面显示 {view.candidates.length} 个。
                {view.inventory.truncated ? " 部分结果因扫描、候选或显示上限被截断。" : ""}
              </p>
            </div>
          );
        })()
      ) : panel.id === "skill-guard-panel" ? (
        (() => {
          const view = skillGuardPanelView(data);
          return (
            <div className="mt-3 grid gap-3">
              {view.status.state === "failed" || view.status.state === "cancelled" ? (
                <div
                  className={`rounded-lg border px-3 py-3 text-[11px] leading-5 ${
                    view.status.state === "failed" ? "border-[#f3c4c4] bg-[#fff4f4] text-[#a23b3b]" : "border-[#f4d8a8] bg-[#fff9ed] text-[#9a6700]"
                  }`}
                >
                  扫描{view.status.state === "failed" ? "失败" : "已取消"}
                  {view.status.error === null ? "" : `：${view.status.error}`}
                </div>
              ) : null}
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["已扫描", view.total],
                  ["高风险", view.blocked],
                  ["待复核", view.review],
                ].map(([label, item]) => (
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                    <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{value(item)}</strong>
                  </div>
                ))}
              </div>
              <div className="grid gap-2">
                {view.reports.length > 0 ? (
                  view.reports.slice(0, 8).map((report, index) => (
                    <div className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${report.name}-${index}`}>
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${report.risk === "blocked" ? "bg-[#d64545]" : report.risk === "review" ? "bg-[#e0a11a]" : "bg-[#22a06b]"}`}
                        ></span>
                        <strong className="min-w-0 flex-1 truncate text-[11px] text-[#30343b]">{report.name}</strong>
                        <span className="text-[10px] text-[#687381]">{report.risk === "blocked" ? "高风险" : report.risk === "review" ? "复核" : "安全"}</span>
                      </div>
                      {report.findings.length > 0 ? (
                        <p className="mt-1 truncate text-[10px] text-[#65707b]">{report.findings.map((finding) => finding.code).join(" · ")}</p>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                    暂无 Skill 扫描结果，可让 Agent 调用 skill_guard_scan。
                  </div>
                )}
              </div>
              <p className="text-[10px] text-[#687381]">
                已扫描 {view.inventory.scanned}/{view.inventory.available} 个入口，面板显示 {Math.min(view.reports.length, 8)} 个；风险等级仅供审计，不会禁用
                Skill。
              </p>
            </div>
          );
        })()
      ) : panel.id === "prompt-guard-panel" ? (
        (() => {
          // The headline follows the highest risk seen in this session so a flagged tool result is not hidden by a later benign user message; data.risk (the latest report) is the fallback for older backends.
          const highest = data?.highest && typeof data.highest === "object" ? (data.highest as Record<string, unknown>) : undefined;
          const highlighted = highest ?? (data?.latest && typeof data.latest === "object" ? (data.latest as Record<string, unknown>) : undefined);
          const risk = highest?.risk ?? data?.risk;
          return (
            <div className="mt-3 grid gap-3">
              <div
                className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${risk === "blocked" ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" : risk === "review" ? "border-[#f3dfab] bg-[#fffaf0] text-[#9a6700]" : "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"}`}
              >
                <span>
                  {risk === "blocked" ? "高风险，需阻断" : risk === "review" ? "需要人工复核" : "未发现风险"}
                  {highlighted && risk !== "safe" && risk !== undefined ? (
                    <span className="ml-2 font-mono text-[10px]">{value(highlighted.source, "unknown")}</span>
                  ) : null}
                </span>
                <strong className="font-mono">{value(data?.scans ?? 0)} 次扫描</strong>
              </div>
              {highlighted ? (
                (() => {
                  const report = highlighted;
                  const findings = Array.isArray(report.findings) ? report.findings : [];
                  return findings.length > 0 ? (
                    <ul className="grid gap-1 rounded-lg border border-[#e3e7ee] bg-white px-4 py-3 text-[10px] text-[#65707b]">
                      {findings.slice(0, 4).map((finding, index) => {
                        const item = finding && typeof finding === "object" ? (finding as Record<string, unknown>) : {};
                        return (
                          <li key={`${value(item.code ?? "finding")}-${index}`}>
                            <strong className="font-mono text-[#30343b]">{value(item.code ?? "finding")}</strong>：{value(item.message, "")}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                      已扫描的用户消息和工具输出均未发现风险。
                    </div>
                  );
                })()
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  尚未扫描任何内容。用户消息和工具输出会自动扫描，Agent 也可调用 prompt_guard_scan 检查不可信文本。
                </div>
              )}
            </div>
          );
        })()
      ) : panel.id === "code2skill-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[#30343b]">已生成技能</span>
              <strong className="font-mono text-[12px] text-[#315fb8]">{value(data?.generated ?? 0)}</strong>
            </div>
            {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
              <p className="mt-2 truncate text-[11px] text-[#65707b]">
                {value((data.latest as Record<string, unknown>).slug ?? "skill")} ·{" "}
                {value(
                  Array.isArray((data.latest as Record<string, unknown>).files) ? ((data.latest as Record<string, unknown>).files as unknown[]).length : 0,
                )}{" "}
                个参考文件
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-[#687381]">还没有生成技能。可让 Agent 调用 skill_pack_create。</p>
            )}
          </div>
          <p className="text-[10px] text-[#687381]">输出目录：项目 .pi/skills/&lt;name&gt;，包含 SKILL.md 和原始参考文件。</p>
        </div>
      ) : panel.id === "genui-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const view = genUiPanelView(data);
            const toneClass: Record<string, string> = {
              neutral: "border-[#e3e7ee] bg-[#f6f8fa] text-[#65707b]",
              info: "border-[#d9e4f7] bg-[#f6f8ff] text-[#315fb8]",
              success: "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]",
              warning: "border-[#f3dfab] bg-[#fffaf0] text-[#9a6700]",
              danger: "border-[#f4caca] bg-[#fff5f5] text-[#b42318]",
            };
            return view.latest !== null ? (
              <div className="grid gap-2">
                <div className="flex items-start justify-between gap-3 text-[11px]">
                  <strong className="min-w-0 break-words text-[#30343b]">{view.latest.title}</strong>
                  <span className="shrink-0 font-mono text-[10px] text-[#687381]">{view.rendered} 次</span>
                </div>
                {view.latest.blocks.map((block, index) =>
                  block.type === "progress" ? (
                    <div className={`rounded-lg border px-3 py-2 ${toneClass[block.tone]}`} key={`${block.label}-${index}`}>
                      <div className="flex items-center justify-between gap-2 text-[10px]">
                        <span className="min-w-0 break-words">{block.label}</span>
                        <strong className="shrink-0">{block.value}%</strong>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/70">
                        <div className="h-full rounded-full bg-current" style={{ width: `${block.value}%` }} />
                      </div>
                    </div>
                  ) : block.type === "text" ? (
                    <div className={`rounded-lg border px-3 py-2 text-[11px] ${toneClass[block.tone]}`} key={`${block.label}-${index}`}>
                      <strong className="block text-[10px]">{block.label}</strong>
                      <p className="mt-1 whitespace-pre-wrap break-words leading-4">{block.value}</p>
                    </div>
                  ) : (
                    <div
                      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[11px] ${toneClass[block.tone]}`}
                      key={`${block.label}-${index}`}
                    >
                      <span className="min-w-0 break-words">{block.label}</span>
                      <strong className="min-w-0 break-words text-right">{block.value}</strong>
                    </div>
                  ),
                )}
                <div className="flex flex-wrap gap-2 text-[10px] text-[#687381]">
                  <span>最多 {view.limits.blocks} 块</span>
                  <span>总文本上限 {view.limits.totalText} 字符</span>
                  {view.latest.renderedAt !== null ? <span>{view.latest.renderedAt.slice(11, 19)} UTC</span> : null}
                  {view.latest.truncated ? <span>面板明细已截断</span> : null}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                还没有结构化卡片。可让 Agent 调用 genui_render。
              </div>
            );
          })()}
          <p className="text-[10px] text-[#687381]">仅渲染结构化文本、徽标和进度块；HTML 与脚本按普通文本显示。</p>
        </div>
      ) : panel.id === "anchored-standard-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const violations = Array.isArray(data?.violations) ? data.violations : [];
            const violated = data?.status === "violated";
            return (
              <>
                <div
                  className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${violated ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" : "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"}`}
                >
                  <span>{violated ? "轨迹存在违规" : data?.status === "anchored" ? "运行已锚定" : "等待 Agent 运行"}</span>
                  <strong className="font-mono">{value(data?.events ?? 0)} 事件</strong>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[10px] text-[#65707b]">
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                    工具调用 <strong className="ml-1 text-[#30343b]">{value(data?.toolCalls ?? 0)}</strong>
                  </div>
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                    违规项 <strong className="ml-1 text-[#30343b]">{value(violations.length)}</strong>
                  </div>
                </div>
                {violations.length > 0 ? (
                  <ul className="grid gap-1 rounded-lg border border-[#f4caca] bg-[#fffafa] px-3 py-2 text-[10px] text-[#b42318]">
                    {violations.slice(0, 4).map((item, index) => (
                      <li key={`${value(item)}-${index}`}>
                        {value(item && typeof item === "object" ? ((item as Record<string, unknown>).message ?? "违规") : item)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            );
          })()}
          <p className="text-[10px] text-[#687381]">可让 Agent 调用 trajectory_anchor_check 审计当前执行轨迹。</p>
        </div>
      ) : panel.id === "telemetry-blocker-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#b9e6c9] bg-[#f0fbf4] px-3 py-3 text-[11px] text-[#14733f]">
            <span>遥测已关闭</span>
            <strong className="font-mono">拦截 {value(data?.blocked ?? 0)} 次</strong>
          </div>
          <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[10px] text-[#65707b]">
            {Array.isArray(data?.names) && data.names.length > 0 ? `事件名：${data.names.slice(0, 8).map(String).join("、")}` : "尚未收到遥测事件。"}
          </div>
          <p className="text-[10px] text-[#687381]">只记录事件名和计数，不保留事件属性，也不会发起网络请求。</p>
        </div>
      ) : panel.id === "plugin-dev-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const view = pluginDevPanelView(data);
            const presentation = {
              idle: { label: "等待重载", style: "border-[#e3e7ee] bg-[#f6f8fa] text-[#65707b]" },
              queued: { label: "等待当前运行结束", style: "border-[#d9e4f7] bg-[#f6f8ff] text-[#315fb8]" },
              running: { label: "正在重载会话资源", style: "border-[#d9e4f7] bg-[#f6f8ff] text-[#315fb8]" },
              reloaded: { label: "会话资源已重载", style: "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]" },
              failed: { label: "会话资源重载失败", style: "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" },
              cancelled: { label: "会话资源重载已取消", style: "border-[#f3dfab] bg-[#fffaf0] text-[#9a6700]" },
            }[view.status];
            return (
              <>
                <div className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${presentation.style}`}>
                  <span>{presentation.label}</span>
                  <strong className="font-mono">{view.status}</strong>
                </div>
                <p className="break-words text-[10px] text-[#687381]">{view.reason || "修改本地扩展后调用 plugin_dev_reload"}</p>
                {view.error !== null ? <p className="break-words rounded-lg bg-[#fff5f5] px-3 py-2 text-[10px] text-[#b42318]">{view.error}</p> : null}
                <div className="flex flex-wrap gap-2 text-[10px] text-[#687381]">
                  <span>原因上限 {view.limits.reasonCharacters} 字符</span>
                  <span>错误上限 {view.limits.errorCharacters} 字符</span>
                  {view.reloadedAt !== null ? <span>{view.reloadedAt.slice(11, 19)} UTC</span> : null}
                </div>
              </>
            );
          })()}
        </div>
      ) : panel.id === "openpets-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const view = openPetsPanelView(data);
            const moodLabel = { idle: "休息", focused: "专注", happy: "开心", concerned: "担心" }[view.mood];
            return (
              <>
                <div className="flex items-center gap-3 rounded-lg border border-[#e3e7ee] bg-[#f8fafc] px-3 py-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#dceaff] text-[20px] text-[#3565c5]">◉</span>
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-[13px] text-[#30343b]">{view.name}</strong>
                    <span className="text-[10px] text-[#687381]">{view.lastEvent}</span>
                  </div>
                  <span className="rounded-full bg-[#edf3fe] px-2 py-1 text-[10px] text-[#3565c5]">{moodLabel}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[10px] text-[#65707b]">
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                    能量 <strong className="ml-1 text-[#30343b]">{view.energy}%</strong>
                  </div>
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                    互动 <strong className="ml-1 text-[#30343b]">{view.interactions}</strong>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-[10px] text-[#687381]">
                  <span>
                    恢复扫描 {view.recovery.scanned} / {view.recovery.sessionEntries}
                  </span>
                  <span>{view.recovery.restored ? "已恢复状态" : "使用初始状态"}</span>
                  <span>
                    持久化 {view.persistence.attempts - view.persistence.failures} / {view.persistence.attempts}
                  </span>
                  {view.updatedAt !== null ? <span>{view.updatedAt.slice(11, 19)} UTC</span> : null}
                </div>
                {view.persistence.lastError !== null ? (
                  <p className="break-words rounded-lg bg-[#fff5f5] px-3 py-2 text-[10px] text-[#b42318]">{view.persistence.lastError}</p>
                ) : null}
                <p className="text-[10px] text-[#687381]">根据真实 Pi 会话事件自动反应，也可让 Agent 调用 pet_react 进行互动。</p>
              </>
            );
          })()}
        </div>
      ) : panel.id === "change-verifier-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
              const tests = report.tests && typeof report.tests === "object" ? (report.tests as Record<string, unknown>) : {};
              const review = report.review && typeof report.review === "object" ? (report.review as Record<string, unknown>) : {};
              const status = value(report.status ?? "fail");
              return (
                <>
                  <div
                    className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${status === "pass" ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]" : status === "warning" ? "border-[#f3dfab] bg-[#fffaf0] text-[#9a6700]" : "border-[#f4caca] bg-[#fff5f5] text-[#b42318]"}`}
                  >
                    <span>{status === "pass" ? "门禁通过" : status === "warning" ? "门禁有警告" : "门禁失败"}</span>
                    <strong className="font-mono">{value(data.runs ?? 0)} 次</strong>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10px] text-[#65707b]">
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                      测试 exit <strong className="ml-1 text-[#30343b]">{value(tests.exitCode ?? "—")}</strong>
                    </div>
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                      审查 <strong className="ml-1 text-[#30343b]">{value(review.status ?? "—")}</strong>
                    </div>
                  </div>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              还没有执行发布门禁。可让 Agent 调用 verify_change_gate。
            </div>
          )}
          <p className="text-[10px] text-[#687381]">复用 run_project_tests 和 review_changes，不重复实现测试或审查逻辑。</p>
        </div>
      ) : panel.id === "readme-gen-panel" ? (
        (() => {
          const view = readmeGenPanelView(data);
          if (view.malformed)
            return (
              <div className="mt-3 rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-3 text-[11px] leading-5 text-[#b42318]">
                README 面板数据无效，暂不展示生成或写入结果。
              </div>
            );
          const statusLabel =
            view.status.state === "idle"
              ? "等待生成"
              : view.status.state === "running"
                ? view.status.operation === "write"
                  ? "正在写入"
                  : "正在生成"
                : view.status.state === "completed"
                  ? view.status.operation === "write"
                    ? "写入已完成"
                    : "草稿已生成"
                  : view.status.state === "failed"
                    ? view.status.operation === "write"
                      ? "写入失败"
                      : "生成失败"
                    : view.status.operation === "write"
                      ? "写入已取消"
                      : "生成已取消";
          const statusTone =
            view.status.state === "failed" || view.status.state === "cancelled"
              ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]"
              : view.status.state === "completed"
                ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"
                : "border-[#dce5f5] bg-[#f6f8ff] text-[#315fb8]";
          return (
            <div className="mt-3 grid min-w-0 gap-3">
              <div className={`flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[10px] ${statusTone}`}>
                <strong className="font-semibold">{statusLabel}</strong>
                {view.status.at !== null ? <time className="shrink-0 font-mono">{view.status.at.slice(11, 19)} UTC</time> : null}
              </div>
              {view.generated === null ? (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] leading-5 text-[#687381]">
                  还没有生成 README 草稿。让 Agent 调用 <code className="font-mono text-[#3565c5]">readme_report</code> 先检查内容。
                </div>
              ) : (
                <div className="min-w-0 border-l-2 border-[#7aa2e8] bg-[#f8faff] px-3 py-3">
                  <p className="break-all text-[12px] font-semibold leading-5 text-[#20252b]">{view.generated.name}</p>
                  <p className="mt-1 text-[10px] text-[#687381]">
                    {view.generated.scripts} 个脚本 · {view.generated.plugins} 个运行时插件
                  </p>
                </div>
              )}
              {view.lastWrite !== null ? (
                <div className="min-w-0 rounded-lg border border-[#dce5f5] bg-white px-3 py-2 text-[#315fb8]">
                  <p className="break-all font-mono text-[10px] leading-4">{view.lastWrite.path}</p>
                  <p className="mt-1 text-[10px] text-[#687381]">
                    {new Intl.NumberFormat("en-US").format(view.lastWrite.bytes)} bytes · {view.lastWrite.overwritten ? "已覆盖" : "新文件"}
                  </p>
                </div>
              ) : null}
              {view.status.error !== null ? (
                <p className="break-words rounded-lg bg-[#fff5f5] px-3 py-2 text-[10px] leading-4 text-[#b42318]">{view.status.error}</p>
              ) : null}
              <p className="text-[10px] leading-4 text-[#687381]">
                写入需要 <code className="font-mono">confirm=true</code>；覆盖已有 README 还需要 <code className="font-mono">overwrite=true</code>。
              </p>
            </div>
          );
        })()
      ) : panel.id === "sql-lens-panel" ? (
        (() => {
          const view = sqlLensPanelView(data);
          if (view.malformed) {
            return (
              <div className="mt-3 rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-3 text-[11px] text-[#b42318]">
                <strong className="block text-[12px]">SQL Lens 面板数据异常</strong>
                <span className="mt-1 block">面板数据不完整或不可信，请重新加载后再查询。</span>
              </div>
            );
          }
          const report = view.latest;
          const statusLabel =
            view.status.state === "running"
              ? "查询中"
              : view.status.state === "completed"
                ? "已完成"
                : view.status.state === "failed"
                  ? "查询失败"
                  : view.status.state === "cancelled"
                    ? "已取消"
                    : "等待查询";
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between gap-3 text-[10px] text-[#687381]">
                <span className="rounded-full border border-[#dce5f5] bg-[#f6f8fa] px-2 py-1 font-semibold text-[#3565c5]">{statusLabel}</span>
                {view.status.at !== null ? <time className="font-mono">{new Date(view.status.at).toLocaleString()}</time> : null}
              </div>
              {view.status.error !== null ? (
                <div className="rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-2 text-[10px] leading-4 text-[#b42318]">{view.status.error}</div>
              ) : null}
              {report !== null ? (
                <>
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-[11px] text-[#30343b]" title={report.database}>
                        {report.database}
                      </span>
                      <strong className="shrink-0 font-mono text-[12px] text-[#3565c5]">{report.rowInventory.returned} rows</strong>
                    </div>
                    <code className="mt-2 block max-h-16 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-[#687381]">
                      {report.query}
                    </code>
                  </div>
                  <pre className="max-h-56 overflow-auto rounded-lg border border-[#edf0f3] bg-[#fbfcfd] p-3 text-[10px] leading-4 text-[#65707b]">
                    {JSON.stringify(report.rows, null, 2)}
                  </pre>
                  {report.rowInventory.truncated ? (
                    <p className="text-[10px] text-[#9a6700]">
                      面板显示 {report.rowInventory.shown} / {report.rowInventory.returned} 行；查询共扫描 {report.rowInventory.scanned}{" "}
                      行，结果已按安全边界截断。
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  还没有查询数据库。可让 Agent 调用 sql_readonly。
                </div>
              )}
              <div className="flex flex-wrap gap-2 font-mono text-[10px] text-[#3565c5]">
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1">timeout:{view.timeoutMs}ms</span>
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1">rows:{view.limits.rows}</span>
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1">result:{Math.round(view.limits.resultBytes / 1_024)}KiB</span>
              </div>
            </div>
          );
        })()
      ) : panel.id === "theme-studio-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
            <div className="min-w-0">
              <strong className="block text-[12px] text-[#30343b]">{value(data?.label ?? "Light")}</strong>
              <p className="mt-1 truncate text-[10px] text-[#65707b]">{value(data?.description ?? "")}</p>
            </div>
            <span className="shrink-0 rounded-full bg-[#edf3fe] px-2 py-1 font-mono text-[10px] text-[#3565c5]">{value(data?.theme ?? "light")}</span>
          </div>
          {Array.isArray(data?.presets) ? (
            <div className="grid grid-cols-2 gap-2">
              {data.presets.map((preset, index) => {
                const item = preset !== null && typeof preset === "object" ? (preset as Record<string, unknown>) : {};
                const selected = item.id === data.theme;
                return (
                  <div
                    className={`rounded-lg border px-3 py-2 ${selected ? "border-[#9bbcff] bg-[#f6f8ff]" : "border-[#edf0f3] bg-white"}`}
                    key={`${value(item.id ?? "theme")}-${index}`}
                  >
                    <strong className="block text-[11px] text-[#30343b]">{value(item.label ?? item.id ?? "主题")}</strong>
                    <span className="mt-1 block truncate text-[10px] text-[#687381]">{value(item.description ?? "")}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
          <p className="text-[10px] leading-4 text-[#687381]">可让 Agent 调用 theme_set 切换预设；选择会保存到当前 session，并由 React 根节点应用 token。</p>
        </div>
      ) : panel.id === "mirage-bridge-panel" ? (
        <div className="mt-3 grid gap-3">
          <div
            className={`rounded-lg border px-3 py-3 ${data?.available === true ? "border-[#b9e6c9] bg-[#f0fbf4]" : data?.available === false ? "border-[#f3dfab] bg-[#fffaf0]" : "border-[#e3e7ee] bg-[#f6f8fa]"}`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[#30343b]">官方 Mirage CLI</span>
              <strong
                className={`text-[11px] ${data?.available === true ? "text-[#14733f]" : data?.available === false ? "text-[#9a6700]" : "text-[#687381]"}`}
              >
                {data?.available === true ? "已连接" : data?.available === false ? "未检测到" : "未检查"}
              </strong>
            </div>
            <p className="mt-2 truncate font-mono text-[10px] text-[#65707b]">{value(data?.version ?? data?.executable ?? "mirage")}</p>
            <p className="mt-1 text-[11px] text-[#65707b]">虚拟工作区：{value(data?.workspaceId ?? "未配置")}</p>
          </div>
          {data?.lastRun && typeof data.lastRun === "object" ? (
            (() => {
              const run = data.lastRun as Record<string, unknown>;
              return (
                <div className={`rounded-lg border px-3 py-3 ${run.exitCode === 0 ? "border-[#b9e6c9] bg-[#f0fbf4]" : "border-[#f4caca] bg-[#fff5f5]"}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-[10px] text-[#30343b]">{value(run.command ?? "")}</span>
                    <strong className={`shrink-0 text-[11px] ${run.exitCode === 0 ? "text-[#14733f]" : "text-[#b42318]"}`}>
                      exit {value(run.exitCode ?? "—")}
                    </strong>
                  </div>
                  <p className="mt-1 text-[10px] text-[#65707b]">耗时 {value(run.durationMs ?? 0)} ms</p>
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              先调用 mirage_doctor 检查 CLI，再调用 mirage_execute。
            </div>
          )}
          {data?.lastError ? <p className="text-[10px] leading-4 text-[#9a6700]">{value(data.lastError)}</p> : null}
        </div>
      ) : panel.id === "docker-sandbox-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const view = dockerSandboxPanelView(data);
            if (view.malformed) {
              return (
                <div className="rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-3 text-[11px] text-[#b42318]">
                  <strong className="block text-[12px]">Docker Sandbox 面板数据异常</strong>
                  <span className="mt-1 block">面板数据不完整或不可信，请重新加载后再运行。</span>
                </div>
              );
            }
            const run = view.latest;
            const successful = run?.status === "completed" && run.exitCode === 0;
            return (
              <>
                {run !== null ? (
                  <div className={`rounded-lg border px-3 py-3 ${successful ? "border-[#b9e6c9] bg-[#f0fbf4]" : "border-[#f4caca] bg-[#fff5f5]"}`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-[11px] text-[#30343b]">{run.image}</span>
                      <strong className={`shrink-0 font-mono text-[12px] ${successful ? "text-[#14733f]" : "text-[#b42318]"}`}>
                        {run.status === "timed_out" ? "超时" : `exit ${run.exitCode}`}
                      </strong>
                    </div>
                    <p className="mt-2 break-all font-mono text-[10px] leading-4 text-[#65707b]">
                      {run.command.map((argument) => JSON.stringify(argument)).join(" ")}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-[#687381]">
                      <span>{run.write ? "工作区可写（已确认）" : "工作区只读"}</span>
                      <span>{run.commandCount} 个 argv 参数</span>
                      {run.truncated ? <span>面板明细已截断</span> : null}
                    </div>
                    {run.output ? (
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-white/70 px-2 py-2 text-[10px] leading-4 text-[#4c5663]">
                        {run.output}
                      </pre>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                    还没有沙箱运行。仅使用本地镜像，默认无网络、工作区只读。
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {[
                    [`image:${view.defaults.image}`, "image"],
                    [`pull:${view.defaults.pull}`, "pull"],
                    [`network:${view.defaults.network}`, "network"],
                    [`rootfs:${view.defaults.rootFilesystem}`, "rootfs"],
                    [`workspace:${view.defaults.workspace}`, "workspace"],
                    [`memory:${view.defaults.memory}`, "memory"],
                    [`cpus:${view.defaults.cpus}`, "cpus"],
                    [`pids:${view.defaults.pids}`, "pids"],
                    [`timeout:${view.defaults.timeoutMs}ms`, "timeout"],
                  ].map(([label, key]) => (
                    <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]" key={key}>
                      {label}
                    </span>
                  ))}
                </div>
              </>
            );
          })()}
        </div>
      ) : panel.id === "yaml-validator-panel" ? (
        (() => {
          const view = yamlValidatorPanelView(data);
          const report = view.latest;
          return (
            <div className="mt-3 grid gap-3">
              {view.status.state === "failed" || view.status.state === "cancelled" ? (
                <div className="rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-2 text-[11px] text-[#b42318]">
                  最近一次校验{view.status.state === "cancelled" ? "已取消" : "失败"}。{view.status.error ?? ""}
                </div>
              ) : null}
              {report !== null ? (
                <>
                  <div
                    className={`rounded-lg border px-3 py-3 text-[11px] ${report.valid ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]" : "border-[#f4caca] bg-[#fff5f5] text-[#b42318]"}`}
                  >
                    {report.valid ? "YAML 语法有效。" : `发现 ${report.errorCount} 个语法错误。`}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      ["文档", report.documents],
                      ["错误", report.errorCount],
                      ["警告", report.warningCount],
                    ].map(([label, entryValue]) => (
                      <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={label}>
                        <span className="block text-[10px] text-[#687381]">{label}</span>
                        <strong className="mt-1 block text-[17px] text-[#30343b]">{entryValue}</strong>
                      </div>
                    ))}
                  </div>
                  {!report.valid && report.errors.length > 0 ? (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[#f4caca] bg-[#fffafa] p-3 text-[10px] leading-4 text-[#b42318]">
                      {report.errors.map((error) => `${error.line ?? "?"}:${error.column ?? "?"} ${error.message}`).join("\n")}
                    </pre>
                  ) : null}
                  {report.diagnosticsTruncated ? <p className="text-[10px] text-[#8a5a00]">诊断预览已截断，完整计数保留在摘要中。</p> : null}
                </>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  还没有校验 YAML。可让 Agent 调用 yaml_validate。
                </div>
              )}
              <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]">
                max:{Math.round(view.limits.fileBytes / 1024)}KiB · read-only
              </span>
            </div>
          );
        })()
      ) : panel.id === "browser-session-panel" ? (
        (() => {
          const view = browserSessionPanelView(data);
          if (view.malformed) {
            return (
              <div className="rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-3 text-[11px] text-[#b42318]">
                <strong className="block text-[12px]">Browser Session 面板数据异常</strong>
                <span className="mt-1 block">面板数据不完整或不可信，请重新连接后再试。</span>
              </div>
            );
          }
          const tabs = view.tabs;
          const latest = view.latest;
          const latestAction = latest?.screenshot
            ? "已截图"
            : latest?.clicked === true
              ? "已点击"
              : latest?.status === "read" || typeof latest?.text === "string"
                ? "已读取"
                : latest?.status === "navigated"
                  ? "已导航"
                  : undefined;
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-[11px] text-[#30343b]">{view.endpoint || "本地浏览器未连接"}</span>
                  <span
                    className={`rounded-full px-2 py-1 text-[10px] font-semibold ${view.connected ? "bg-[#e8f8ee] text-[#14733f]" : "bg-[#fff4e5] text-[#8a5a00]"}`}
                  >
                    {view.connected ? "已连接" : "未连接"}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-[#687381]">
                  Chrome DevTools Protocol · 显示 {view.inventory.shown}/{view.inventory.total} 个可调试页面
                </p>
                {!view.connected ? <p className="mt-2 text-[11px] text-[#b42318]">请使用 remote-debugging-port 启动 Chrome。{view.error ?? ""}</p> : null}
              </div>
              {latestAction ? (
                <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-2 text-[11px]">
                  <span className="text-[#65707b]">最近动作</span>
                  <strong className="font-mono text-[#315fb8]">{latestAction}</strong>
                </div>
              ) : null}
              {latest?.text !== undefined ? (
                <div className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-3">
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-[#4c5663]">{latest.text}</pre>
                  {latest.previewTruncated ? <p className="mt-2 text-[10px] text-[#8a5a00]">面板正文预览已截断。</p> : null}
                </div>
              ) : null}
              {latest?.screenshot !== undefined ? (
                <div className="rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-2 text-[10px] text-[#315fb8]">
                  截图元数据：{latest.screenshot.mimeType} · {latest.screenshot.bytes.toLocaleString()} bytes
                </div>
              ) : null}
              {tabs.length > 0 ? (
                <div className="grid gap-2">
                  {tabs.map((tab) => (
                    <div className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-2" key={tab.targetId}>
                      <strong className="block truncate text-[11px] text-[#30343b]">{tab.title}</strong>
                      <span className="mt-1 block truncate font-mono text-[10px] text-[#687381]">{tab.url}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">没有可调试的浏览器页面。</div>
              )}
              <div className="flex flex-wrap gap-2 text-[10px] text-[#687381]">
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[#3565c5]">tabs</span>
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[#3565c5]">read</span>
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[#3565c5]">click</span>
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[#3565c5]">screenshot</span>
              </div>
            </div>
          );
        })()
      ) : panel.id === "mcp-client-panel" ? (
        (() => {
          const view = mcpClientPanelView(data);
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-[11px] text-[#30343b]">{value(view.server ?? "尚未连接 MCP 服务器")}</span>
                  <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-[#3565c5]">
                    <span>{view.inventory.tools.total} 工具</span>
                    <span className="text-[#687381]">·</span>
                    <span>{view.inventory.resources.total} 资源</span>
                    <span className="text-[#687381]">·</span>
                    <span>{view.inventory.prompts.total} 提示</span>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-[#687381]">
                  {view.lastCall === null ? "使用 mcp_list_tools 发现 stdio 工具。" : `最近调用：${view.lastCall}`}
                </p>
              </div>
              {view.tools.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {view.tools.map((tool, index) => (
                    <span
                      className="max-w-full truncate rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]"
                      key={`${tool.name}-${index}`}
                      title={tool.description}
                    >
                      {tool.name}
                    </span>
                  ))}
                </div>
              ) : null}
              {view.resources.length > 0 ? (
                <div className="grid gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#687381]">资源</span>
                  <div className="flex flex-wrap gap-2">
                    {view.resources.map((resource, index) => (
                      <span
                        className="max-w-full truncate rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#65707b]"
                        key={`${resource.uri}-${index}`}
                        title={resource.uri}
                      >
                        {resource.name ?? resource.uri}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {view.prompts.length > 0 ? (
                <div className="grid gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#687381]">提示模板</span>
                  <div className="flex flex-wrap gap-2">
                    {view.prompts.map((prompt, index) => (
                      <span
                        className="max-w-full truncate rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#65707b]"
                        key={`${prompt.name}-${index}`}
                        title={prompt.description}
                      >
                        {prompt.name}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {view.servers.length > 0 ? (
                <div className="grid gap-2">
                  {view.servers.map((server, index) => (
                    <div
                      className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-white px-3 py-2 text-[10px]"
                      key={`${server.id}-${index}`}
                    >
                      <span className="truncate font-mono text-[#30343b]">{server.id}</span>
                      <span className={server.status === "running" ? "text-[#14733f]" : "text-[#687381]"}>{server.status}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {view.inventory.tools.truncated || view.inventory.resources.truncated || view.inventory.prompts.truncated || view.inventory.servers.truncated ? (
                <p className="text-[10px] text-[#687381]">面板仅显示受限预览；完整清单请使用对应 MCP 列表工具。</p>
              ) : null}
              <p className="font-mono text-[9px] text-[#8a94a1]">
                响应上限 {Math.round(view.limits.responseBytes / 1024)} KiB · 请求超时 {Math.round(view.limits.requestTimeoutMs / 1000)} 秒
              </p>
            </div>
          );
        })()
      ) : panel.id === "mcp-panel" ? (
        (() => {
          const servers = Array.isArray(data?.servers) ? data.servers : [];
          return (
            <div className="mt-3 grid gap-3">
              {servers.length > 0 ? (
                <ul className="grid gap-2">
                  {servers.map((entry, index) => {
                    const server = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    const healthy = server.status === "running";
                    return (
                      <li className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-2" key={`${value(server.id ?? "server")}-${index}`}>
                        <div className="flex items-center gap-2">
                          <strong className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#30343b]">{value(server.id, "未命名服务器")}</strong>
                          <span className={`rounded px-1.5 py-0.5 text-[9px] ${healthy ? "bg-[#eaf8f0] text-[#14733f]" : "bg-[#fff5f5] text-[#b42318]"}`}>
                            {value(server.status, "unknown")}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[10px] text-[#687381]">
                          <span>{typeof server.toolCount === "number" ? `${server.toolCount} 个 MCP 工具` : "工具尚未查询"}</span>
                          <span>·</span>
                          <span>{value(server.statusSource, "runtime")}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">当前没有 MCP 服务器快照。</div>
              )}
              <div className="text-[10px] text-[#687381]">
                读取 MCP 运行状态；工具列表通过 mcp_panel 的 tools 操作查询，健康建议通过 health 操作查看。
                {data?.writesEnabled === true ? ` 已启用 profile patch 写入：${value(data.patchPath)}` : " profile patch 写入未配置，apply 会被拒绝。"}
              </div>
            </div>
          );
        })()
      ) : panel.id === "mock-server-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <span className="font-mono text-[11px] text-[#30343b]">{data?.running === true ? "运行中" : "未启动"}</span>
            <strong className="font-mono text-[11px] text-[#3565c5]">{value(data?.routes ?? 0)} 路由</strong>
          </div>
          {data?.url ? <code className="rounded-md bg-white px-3 py-2 text-[10px] text-[#65707b]">{value(data.url)}</code> : null}
          {data?.lastRequest ? <p className="text-[11px] text-[#687381]">最近请求：{value(data.lastRequest)}</p> : null}
        </div>
      ) : panel.id === "cli-notifier-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <span className="font-mono text-[11px] text-[#30343b]">{data?.enabled === true ? "已启用" : "已停用"}</span>
            <span className="font-mono text-[10px] text-[#687381]">
              {value(data?.platform ?? "unknown")} · {value(data?.timeoutMs ?? 10_000)}ms
            </span>
          </div>
          {Array.isArray(data?.notifications) && data.notifications.length > 0 ? (
            <div className="grid gap-2">
              {data.notifications.slice(0, 5).map((notification, index) => {
                const item = typeof notification === "object" && notification !== null ? (notification as Record<string, unknown>) : {};
                return (
                  <div className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-2 text-[10px]" key={`${value(item.time ?? "notification")}-${index}`}>
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-[#30343b]">{value(item.title ?? "Pi Harness")}</strong>
                      <span className={item.delivered === true ? "text-[#14733f]" : "text-[#b42318]"}>{item.delivered === true ? "已送达" : "未送达"}</span>
                    </div>
                    <span className="mt-1 block text-[#65707b]">{value(item.message, "")}</span>
                    {item.delivered !== true && item.reason ? <span className="mt-1 block break-words text-[#b42318]">{value(item.reason)}</span> : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">还没有发送通知。</div>
          )}
        </div>
      ) : panel.id === "obsidian-sync-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <span className="font-mono text-[11px] text-[#30343b]">{data?.configured === true ? "已配置" : "未配置 vault"}</span>
            <span className="font-mono text-[10px] text-[#687381]">Markdown</span>
          </div>
          {data?.vaultPath ? <code className="truncate rounded-md bg-white px-3 py-2 text-[10px] text-[#65707b]">{value(data.vaultPath)}</code> : null}
          {data?.last !== null && data?.last !== undefined && typeof data.last === "object" ? (
            <p className="text-[11px] text-[#687381]">最近写入：{value((data.last as Record<string, unknown>).relativePath ?? "note.md")}</p>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">还没有同步笔记。</div>
          )}
        </div>
      ) : panel.id === "web-research-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3 text-[11px]">
            <span className="text-[#315fb8]">{data?.keyless === true ? "Firecrawl 匿名模式" : "Firecrawl 已认证"}</span>
            <strong className="font-mono text-[#315fb8]">最多 {value(data?.maxResults ?? 8)} 条</strong>
          </div>
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
              const items = Array.isArray(report.items) ? report.items : [];
              return (
                <>
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <strong className="truncate text-[#30343b]">{value(report.query ?? "网页搜索")}</strong>
                    <span className="shrink-0 font-mono text-[#687381]">
                      前 {Math.min(8, items.length)} / 共 {items.length}
                    </span>
                  </div>
                  <div className="grid gap-2">
                    {items.slice(0, 8).map((entry, index) => {
                      const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                      return (
                        <a
                          className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-2 transition-colors hover:border-[#bdd0f5] hover:bg-[#fbfdff]"
                          href={value(item.url, "")}
                          key={`${value(item.url ?? "source")}-${index}`}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <strong className="block truncate text-[11px] text-[#30343b]">{value(item.title ?? item.url ?? "来源")}</strong>
                          <span className="mt-1 block truncate font-mono text-[10px] text-[#3565c5]">{value(item.source ?? item.url, "")}</span>
                          {item.snippet ? <span className="mt-1 line-clamp-2 block text-[10px] leading-4 text-[#65707b]">{value(item.snippet)}</span> : null}
                        </a>
                      );
                    })}
                  </div>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              还没有联网搜索。可让 Agent 调用 web_search；单页读取使用 read_page。
            </div>
          )}
          <p className="text-[10px] text-[#687381]">
            搜索词会发送到 Firecrawl；页面读取{data?.readPageAvailable === true ? "已复用本地 Browser Fetch" : "需要启用 Browser Fetch"}。
          </p>
        </div>
      ) : panel.id === "browser-fetch-panel" ? (
        (() => {
          const view = browserFetchPanelView(data);
          if (view.malformed) {
            return (
              <div className="rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-3 text-[11px] text-[#b42318]">
                <strong className="block text-[12px]">Browser Fetch 面板数据异常</strong>
                <span className="mt-1 block">面板数据不完整或不可信，请重新加载后再抓取。</span>
              </div>
            );
          }
          const result = view.latest;
          return (
            <div className="mt-3 grid gap-3">
              {result === null ? (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  还没有抓取网页。默认阻止本地和私有网络目标。
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-[#f6f8fa] px-3 py-3">
                    <span className="truncate font-mono text-[11px] text-[#30343b]">{value(result.finalUrl || result.url || "page")}</span>
                    <strong className="font-mono text-[12px] text-[#14733f]">HTTP {value(result.status || "—")}</strong>
                  </div>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3] bg-[#fbfcfd] p-3 text-[10px] leading-4 text-[#65707b]">
                    {value(result.text, "")}
                  </pre>
                  {result.previewTruncated || result.truncated ? (
                    <p className="text-[10px] text-[#9a6700]">
                      {result.truncated ? "响应正文已达到抓取上限；" : ""}
                      {result.previewTruncated ? "面板仅显示有界预览。" : ""}
                    </p>
                  ) : null}
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]">
                  max:{value(Math.round(view.limits.responseBytes / 1024))}KiB
                </span>
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]">
                  timeout:{value(view.limits.timeoutMs)}ms
                </span>
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]">
                  redirects:{value(view.limits.redirects)}
                </span>
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]">scripts:disabled</span>
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]">
                  private:{value(view.allowPrivate ? "allowed" : "blocked")}
                </span>
              </div>
            </div>
          );
        })()
      ) : panel.id === "i18n-pair-panel" ? (
        (() => {
          const view = i18nPairPanelView(data);
          const report = view.report;
          const healthy = report !== null && report.missingTotal === 0 && report.extraTotal === 0;
          const statusLabel =
            view.status.state === "unknown"
              ? "数据异常"
              : view.status.state === "running"
                ? "检查中"
                : view.status.state === "failed"
                  ? "检查失败"
                  : view.status.state === "cancelled"
                    ? "已取消"
                    : view.status.state === "completed"
                      ? "已完成"
                      : "等待检查";
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between gap-3 text-[10px] text-[#687381]">
                <span className="rounded-full border border-[#dce5f5] bg-[#f6f8fa] px-2 py-1 font-semibold text-[#3565c5]">{statusLabel}</span>
                {view.status.at !== null ? <time className="font-mono">{new Date(view.status.at).toLocaleString()}</time> : null}
              </div>
              {view.status.error !== null ? (
                <div className="rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-2 text-[10px] leading-4 text-[#b42318]">{view.status.error}</div>
              ) : null}
              {view.malformed ? (
                <div className="rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-2 text-[10px] leading-4 text-[#b42318]">
                  面板数据不完整或不可信，未显示语言包统计。
                </div>
              ) : null}
              {report !== null ? (
                <>
                  <div
                    className={`rounded-lg border px-3 py-3 text-[11px] ${healthy ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]" : "border-[#f4caca] bg-[#fff5f5] text-[#b42318]"}`}
                  >
                    {healthy ? "语言包键完全一致。" : `缺失 ${report.missingTotal} 个，额外 ${report.extraTotal} 个。`}
                  </div>
                  <div className="grid gap-2 rounded-lg border border-[#edf0f3] bg-[#fbfcfd] px-3 py-3 font-mono text-[10px]">
                    <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                      <span className="text-[#687381]">基准</span>
                      <span className="truncate text-[#30343b]" title={report.base}>
                        {report.base}
                      </span>
                    </div>
                    <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                      <span className="text-[#687381]">目标</span>
                      <span className="truncate text-[#30343b]" title={report.target}>
                        {report.target}
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                      <span className="block text-[10px] text-[#687381]">基准键</span>
                      <strong className="mt-1 block text-[17px] text-[#30343b]">{report.baseKeys}</strong>
                    </div>
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                      <span className="block text-[10px] text-[#687381]">目标键</span>
                      <strong className="mt-1 block text-[17px] text-[#30343b]">{report.targetKeys}</strong>
                    </div>
                  </div>
                  {report.missing.length > 0 || report.extra.length > 0 ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {[
                        { label: `缺失 · ${report.missingTotal}`, keys: report.missing, tone: "text-[#b42318]" },
                        { label: `额外 · ${report.extraTotal}`, keys: report.extra, tone: "text-[#9a6700]" },
                      ].map((group) => (
                        <div className="min-w-0 rounded-lg border border-[#edf0f3] bg-[#fbfcfd] p-3" key={group.label}>
                          <strong className={`text-[10px] ${group.tone}`}>{group.label}</strong>
                          <ul className="mt-2 max-h-36 space-y-1 overflow-auto font-mono text-[10px] text-[#30343b]">
                            {group.keys.map((key, index) => (
                              <li className="truncate" key={`${key}-${index}`} title={key}>
                                {key}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {report.truncated ? <p className="text-[10px] text-[#9a6700]">面板仅显示有界键列表；完整结果保留在工具调用详情中。</p> : null}
                </>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                  还没有检查语言包。可让 Agent 调用 i18n_check。
                </div>
              )}
              <div className="flex flex-wrap gap-2 font-mono text-[10px] text-[#3565c5]">
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1">file:{Math.round(view.limits.fileBytes / 1_048_576)}MiB</span>
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1">depth:{view.limits.depth}</span>
                <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1">keys:{view.limits.keysPerFile}</span>
              </div>
            </div>
          );
        })()
      ) : panel.id === "cleaner-panel" ? (
        (() => {
          const view = cleanerPanelView(data);
          if (view.malformed || view.inventory === null) {
            return (
              <div className="mt-3 rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-3 text-[11px] text-[#b42318]">
                <strong className="block text-[12px]">Cleaner 面板数据异常</strong>
                <span className="mt-1 block">面板数据不完整或不可信，请重新加载后再执行清理。</span>
              </div>
            );
          }
          const inventory = view.inventory;
          const activity = view.lastCleanup;
          const statusLabel =
            activity?.status === "running"
              ? "清理中"
              : activity?.status === "completed"
                ? "已完成"
                : activity?.status === "cancelled"
                  ? "已取消"
                  : activity?.status === "failed"
                    ? "清理失败"
                    : "尚未清理";
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[#30343b]">Git 胶囊库存</span>
                  <strong className="font-mono text-[12px] text-[#3565c5]">{inventory.total} 个</strong>
                </div>
                <p className="mt-2 text-[11px] text-[#687381]">仅清理 agent 数据目录中的 .patch 胶囊，必须显式 confirm=true。</p>
                <div className="mt-3 flex flex-wrap gap-2 font-mono text-[10px] text-[#3565c5]">
                  <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1">capsules:{view.limits.capsules}</span>
                  <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1">scan:{view.limits.directoryEntries}</span>
                </div>
              </div>
              {activity !== null ? (
                <div className="rounded-lg border border-[#edf0f3] bg-[#fbfcfd] px-3 py-3">
                  <div className="flex items-center justify-between gap-3 text-[10px]">
                    <strong className={activity.status === "failed" ? "text-[#b42318]" : "text-[#30343b]"}>{statusLabel}</strong>
                    {activity.at !== null ? <time className="font-mono text-[#687381]">{new Date(activity.at).toLocaleString()}</time> : null}
                  </div>
                  <div className="mt-2 flex gap-4 text-[11px] text-[#687381]">
                    <span>
                      已删 <strong className="font-mono text-[#30343b]">{activity.removed}</strong>
                    </span>
                    <span>
                      保留 <strong className="font-mono text-[#30343b]">{activity.kept ?? "—"}</strong>
                    </span>
                    <span>
                      请求保留 <strong className="font-mono text-[#30343b]">{activity.requestedKeep}</strong>
                    </span>
                  </div>
                  {activity.error !== null ? <p className="mt-2 break-words text-[10px] leading-4 text-[#b42318]">{activity.error}</p> : null}
                </div>
              ) : null}
              {view.capsules.length > 0 ? (
                <div className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3] bg-[#fbfcfd]">
                  {view.capsules.map((capsule, index) => (
                    <div
                      className="flex items-center justify-between gap-3 border-b border-[#edf0f3] px-3 py-2 last:border-b-0"
                      key={`${capsule.name}-${index}`}
                    >
                      <span className="truncate font-mono text-[10px] text-[#30343b]" title={capsule.name}>
                        {capsule.name}
                      </span>
                      <span className="shrink-0 font-mono text-[9px] text-[#687381]">{capsule.bytes.toLocaleString()} B</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">当前没有可清理的 Git 胶囊。</div>
              )}
              {inventory.truncated ? (
                <p className="text-[10px] text-[#9a6700]">
                  面板显示 {inventory.shown} / {inventory.total} 个条目；清理工具仍按完整的有界库存执行。
                </p>
              ) : null}
            </div>
          );
        })()
      ) : panel.id === "fail-logger-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const view = failLoggerPanelView(data);
            return (
              <>
                <div className="rounded-lg bg-[#fff5f5] px-3 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-[#7f1d1d]">聚合后的失败记录</span>
                    <strong className="font-mono text-[17px] text-[#b42318]">{view.total}</strong>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-[#8b4a4a]">
                    <span>观测 {view.observed} 次</span>
                    <span>
                      容量 {view.total} / {view.capacity}
                    </span>
                    {view.dropped > 0 ? <span>已淘汰 {view.dropped} 条旧记录</span> : null}
                    {view.truncated ? <span>面板明细已截断</span> : null}
                  </div>
                </div>
                <div className="max-h-56 overflow-auto rounded-lg border border-[#edf0f3]">
                  {view.failures.length > 0 ? (
                    view.failures.map((failure, index) => (
                      <div className="border-b border-[#edf0f3] px-3 py-2 last:border-b-0" key={`${failure.time ?? "failure"}-${index}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] text-[#b42318]">{failure.source}</span>
                          <span className="flex shrink-0 items-center gap-2 font-mono text-[9px] text-[#8a94a0]">
                            {failure.occurrences > 1 ? <strong className="text-[#b42318]">×{failure.occurrences}</strong> : null}
                            {failure.time === null ? "时间未知" : `${failure.time.slice(11, 19)} UTC`}
                          </span>
                        </div>
                        <p className="mt-1 break-words text-[11px] leading-4 text-[#65707b]">{failure.message}</p>
                      </div>
                    ))
                  ) : (
                    <div className="px-3 py-4 text-[12px] text-[#687381]">暂无失败记录。</div>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      ) : panel.id === "context-insight-panel" ? (
        (() => {
          const view = contextInsightsPanelView(data);
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#5d6d82]">上下文占用</span>
                  <strong className="text-[13px] font-semibold text-[#315fb8]">{view.percent === null ? "—" : `${view.percent}%`}</strong>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#dfe8fb]">
                  <div className="h-full rounded-full bg-[#5d8bea] transition-[width] duration-300" style={{ width: `${Math.min(100, view.percent ?? 0)}%` }} />
                </div>
                <p className="mt-2 text-[11px] text-[#5d6d82]">
                  {view.tokens === null ? "令牌数未知" : `${view.tokens.toLocaleString()} tokens`}
                  {view.contextWindow === null ? "" : ` / ${view.contextWindow.toLocaleString()} 上限`}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["消息", view.messages],
                  ["事件", view.events],
                  ["压缩", view.compactions],
                ].map(([label, item]) => (
                  <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                    <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{value(item)}</strong>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-[#edf0f3] bg-white px-3 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[#30343b]">消息组成</span>
                  <span className="text-[10px] text-[#687381]">
                    {view.messagesTruncated ? `最近 ${view.scannedMessages} / ${view.messages} 条` : `全部 ${view.scannedMessages} 条`}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-5 gap-1.5">
                  {[
                    ["用户", view.composition.user],
                    ["助手", view.composition.assistant],
                    ["工具", view.composition.toolResult],
                    ["系统", view.composition.system],
                    ["其他", view.composition.other],
                  ].map(([label, item]) => (
                    <div className="rounded bg-[#f6f8fa] px-2 py-1.5 text-center" key={value(label)}>
                      <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                      <strong className="mt-0.5 block font-mono text-[13px] text-[#30343b]">{value(item)}</strong>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-[#edf0f3] bg-white px-3 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[#30343b]">最近上下文事件</span>
                  <span className="text-[10px] text-[#687381]">
                    显示 {view.limits.displayedEvents} / 保留 {view.limits.retainedEvents} 条
                  </span>
                </div>
                <div className="mt-2 max-h-28 overflow-auto">
                  {view.recentEvents.length > 0 ? (
                    view.recentEvents.map((event, index) => {
                      return (
                        <div
                          className="flex items-center justify-between border-b border-[#f0f2f5] py-1.5 last:border-b-0"
                          key={`${event.type}-${event.at ?? "unknown"}-${index}`}
                        >
                          <span className="font-mono text-[10px] text-[#5d6d82]">{event.type}</span>
                          <span className="text-[10px] text-[#687381]">{event.at === null ? "—" : new Date(event.at).toLocaleTimeString()}</span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="py-2 text-[11px] text-[#687381]">暂无上下文事件。</div>
                  )}
                </div>
                {view.recentEventsTruncated ? <p className="mt-2 text-[10px] text-[#687381]">更早事件已按浏览器显示上限省略。</p> : null}
              </div>
            </div>
          );
        })()
      ) : (
        <div className="mt-3 grid gap-2">
          {entries.map(([key, item]) => (
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={key}>
              <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-[#687381]">{key}</span>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-[#30343b]">{pluginPanelValue(item)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PluginUninstallDialog({
  pluginName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  pluginName: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useModalFocus(true, onCancel, busy);
  return (
    <div
      className="plugin-confirm-backdrop"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        aria-label="确认卸载插件"
        aria-modal="true"
        className="plugin-confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <strong>卸载插件？</strong>
            <small>将从运行配置中移除，之后可以从插件市场重新安装。</small>
          </div>
        </header>
        <code>{pluginName}</code>
        {error && (
          <p className="plugin-confirm-error" role="alert">
            {pluginActionErrorText(error)}
          </p>
        )}
        <footer>
          <button data-dialog-initial-focus disabled={busy} onClick={onCancel} type="button">
            取消
          </button>
          <button className="danger" disabled={busy} onClick={onConfirm} type="button">
            {busy ? "卸载中…" : "确认卸载"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function PluginCategoryNav({
  label,
  categories,
  activeCategory,
  onChange,
}: {
  label: string;
  categories: readonly ClientMarketplaceCategory[];
  activeCategory: string;
  onChange: (category: string) => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const updateScrollState = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const maximum = Math.max(0, nav.scrollWidth - nav.clientWidth);
    setCanScrollLeft(nav.scrollLeft > 1);
    setCanScrollRight(nav.scrollLeft < maximum - 1);
  }, []);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    updateScrollState();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateScrollState);
    observer?.observe(nav);
    window.addEventListener("resize", updateScrollState);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateScrollState);
    };
  }, [categories, updateScrollState]);
  const scroll = (direction: -1 | 1) => {
    const nav = navRef.current;
    if (!nav) return;
    nav.scrollBy({ behavior: "smooth", left: direction * Math.max(180, nav.clientWidth * 0.72) });
  };
  return (
    <div className={`marketplace-categories-shell ${canScrollLeft ? "can-scroll-left" : ""} ${canScrollRight ? "can-scroll-right" : ""}`}>
      {canScrollLeft && (
        <button aria-label="向左查看更多分类" className="marketplace-category-scroll previous" onClick={() => scroll(-1)} type="button">
          ‹
        </button>
      )}
      <nav aria-label={label} className="marketplace-categories" onScroll={updateScrollState} ref={navRef}>
        {categories.map((category) => {
          const active = activeCategory === category.id;
          return (
            <button
              aria-pressed={active}
              className={`marketplace-category ${active ? "active" : ""}`}
              key={category.id || "all"}
              onClick={() => onChange(category.id)}
              type="button"
            >
              <span>{category.label}</span>
              <span className={active ? "font-mono text-[10px] text-[#3565c5]" : "font-mono text-[10px] text-[#687381]"}>{category.count}</span>
            </button>
          );
        })}
      </nav>
      {canScrollRight && (
        <button aria-label="向右查看更多分类" className="marketplace-category-scroll next" onClick={() => scroll(1)} type="button">
          ›
        </button>
      )}
    </div>
  );
}

function Plugins({
  plugins,
  panels,
  catalog,
  capabilityLabel,
  onMarketplace,
  onOpenDetail,
  onToml,
  onToggle,
  onUninstall,
}: {
  plugins: readonly ClientPlugin[];
  panels: readonly ClientPluginPanel[];
  catalog: readonly ClientMarketplacePlugin[];
  capabilityLabel: (id: string) => string;
  onMarketplace: () => void;
  onOpenDetail: (plugin: ClientPlugin) => void;
  onToml: () => void;
  onToggle: (plugin: ClientPlugin) => Promise<{ restartRequired?: boolean }>;
  onUninstall: (plugin: ClientPlugin) => Promise<void>;
}) {
  const catalogByPackage = useMemo(() => new Map(catalog.map((plugin) => [plugin.packageName, plugin])), [catalog]);
  const panelPluginIds = useMemo(() => new Set(panels.map((panel) => panel.pluginId)), [panels]);
  const installedPlugins = useMemo(() => plugins.filter((plugin) => plugin.removable || panelPluginIds.has(plugin.name)), [panelPluginIds, plugins]);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [busyPlugin, setBusyPlugin] = useState<string>();
  const [pluginError, setPluginError] = useState("");
  const [pluginNotice, setPluginNotice] = useState("");
  const [pendingUninstall, setPendingUninstall] = useState<ClientPlugin>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const installedCategories = useMemo(() => {
    const counts = new Map<string, ClientMarketplaceCategory>();
    for (const plugin of installedPlugins) {
      const category = catalogByPackage.get(plugin.name)?.category ?? plugin.category ?? { id: "other", label: "其他" };
      const current = counts.get(category.id);
      counts.set(category.id, { ...category, count: (current?.count ?? 0) + 1 });
    }
    return marketplaceCategoryTabs([...counts.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN")));
  }, [catalogByPackage, installedPlugins]);
  const visiblePlugins = useMemo(() => {
    return installedPlugins.filter((plugin) => {
      const metadata = catalogByPackage.get(plugin.name);
      const category = metadata?.category ?? plugin.category ?? { id: "other", label: "其他" };
      if (categoryFilter && category.id !== categoryFilter) return false;
      const fields = [
        plugin.name,
        metadata?.name,
        displayPluginName(plugin.name),
        metadata?.category.label,
        ...(metadata?.capabilities ?? []).map(capabilityLabel),
        plugin.category?.label,
        capability(plugin.name),
      ];
      return matchesPluginQuery(query, fields);
    });
  }, [capabilityLabel, catalogByPackage, categoryFilter, installedPlugins, query]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [categoryFilter, query]);
  useEffect(() => {
    if (categoryFilter && !installedCategories.some((category) => category.id === categoryFilter)) setCategoryFilter("");
  }, [categoryFilter, installedCategories]);
  const runPluginAction = async (plugin: ClientPlugin, action: (plugin: ClientPlugin) => Promise<{ restartRequired?: boolean } | void>): Promise<boolean> => {
    setPluginError("");
    setPluginNotice("");
    setBusyPlugin(plugin.id);
    try {
      const result = await action(plugin);
      if (result?.restartRequired === true) setPluginNotice(RESTART_REQUIRED_NOTICE);
      return true;
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusyPlugin(undefined);
    }
  };
  return (
    <section className="view-panel plugins-view">
      <div className="plugins-page">
        <div className="subnav">
          <div aria-label="插件目录" className="segmented">
            <button aria-pressed="true" className="active" type="button">
              已安装
            </button>
            <button aria-pressed="false" onClick={onMarketplace} type="button">
              插件市场
            </button>
          </div>
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              onToml();
            }}
          >
            查看运行配置
          </a>
        </div>
        <div className="plugins-toolbar">
          <input
            aria-label="搜索已安装插件"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、包名或能力…"
            type="search"
            value={query}
          />
          <span aria-live="polite">
            {query.trim() || categoryFilter ? `${visiblePlugins.length} / ${installedPlugins.length}` : `${installedPlugins.length}`} 个插件
          </span>
        </div>
        <PluginCategoryNav activeCategory={categoryFilter} categories={installedCategories} label="已安装插件分类" onChange={setCategoryFilter} />
        <div className="plugins-scroll" ref={scrollRef}>
          <div className="plugins-list">
            {visiblePlugins.map((plugin) => {
              const metadata = catalogByPackage.get(plugin.name);
              const categoryLabel = metadata?.category.label ?? plugin.category?.label;
              const shortName = capability(plugin.name);
              const pluginTitle = metadata?.name ?? displayPluginName(plugin.name);
              const cardContent = installedPluginCardContent(plugin, metadata, capabilityLabel);
              const awaitingRestart = plugin.state === RESTART_REQUIRED_PLUGIN_STATE;
              return (
                <article className="catalog-card plugin-card" key={plugin.id}>
                  <div className="plugin-card-head">
                    <span className="plugin-icon">◈</span>
                    <div className="plugin-copy">
                      <div className="plugin-heading">
                        <div className="plugin-title">
                          <strong>{pluginTitle}</strong>
                          <span className={`plugin-state ${awaitingRestart ? "" : plugin.enabled ? "active" : ""}`}>
                            {awaitingRestart ? "重启后生效" : plugin.enabled ? "运行中" : "已停用"}
                          </span>
                          {categoryLabel && <span className="capability">{categoryLabel}</span>}
                          {categoryLabel !== shortName && <span className="capability">{shortName}</span>}
                        </div>
                        <div className="plugin-actions">
                          {plugin.removable ? (
                            <>
                              <button
                                aria-label={`${plugin.enabled ? "停用" : "启用"} ${pluginTitle}`}
                                aria-pressed={plugin.enabled}
                                className="plugin-switch-button"
                                disabled={busyPlugin !== undefined || awaitingRestart}
                                onClick={() => void runPluginAction(plugin, (item) => onToggle(item))}
                                title={awaitingRestart ? "插件已安装但还没加载，重启 Pi Harness 后才能停用或启用" : undefined}
                                type="button"
                              >
                                <span aria-hidden="true" className={`switch ${plugin.enabled ? "on" : ""}`}>
                                  <i></i>
                                </span>
                              </button>
                              <button
                                className="plugin-uninstall"
                                disabled={busyPlugin !== undefined}
                                onClick={() => {
                                  setPluginError("");
                                  setPendingUninstall(plugin);
                                }}
                                type="button"
                              >
                                卸载
                              </button>
                            </>
                          ) : (
                            <span className={`switch ${plugin.enabled ? "on" : ""}`}>
                              <i></i>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="plugin-card-body">
                    <code className="plugin-package">{cardContent.packageLabel}</code>
                    <p className="plugin-description">{cardContent.description}</p>
                    <div className="hook-list">
                      {cardContent.tags.map((tag, index) => (
                        <span key={`${tag}-${index}`}>{tag}</span>
                      ))}
                    </div>
                  </div>
                  <footer className="plugin-card-footer">
                    <button aria-label={`查看 ${pluginTitle} 详情`} className="plugin-detail-link" onClick={() => onOpenDetail(plugin)} type="button">
                      查看详情 →
                    </button>
                    {panelPluginIds.has(plugin.name) ? <span>实时面板</span> : null}
                  </footer>
                </article>
              );
            })}
            {!installedPlugins.length ? (
              <div className="empty-state">还没有安装可管理的插件。去插件市场安装一个吧。</div>
            ) : !visiblePlugins.length ? (
              <div className="empty-state">没有匹配当前搜索与分类条件的已安装插件。</div>
            ) : null}
          </div>
          {pluginError && (
            <p className="plugin-action-error" role="alert">
              {pluginActionErrorText(pluginError)}
            </p>
          )}
          {pluginNotice && (
            <p aria-live="polite" className="plugin-action-notice">
              {pluginNotice}
            </p>
          )}
          {panels.length > installedPlugins.length && (
            <section className="mt-4 border-t border-[#e3e7ee] pt-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <div>
                  <strong className="text-[13px] font-semibold text-[#20252b]">其他插件面板</strong>
                  <p className="mt-1 text-[12px] text-[#687381]">由已启用插件提供的实时状态。</p>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#687381]">LIVE</span>
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                {panels
                  .filter((panel) => !installedPlugins.some((plugin) => plugin.name === panel.pluginId))
                  .map((panel) => (
                    <PluginPanelCard key={panel.id} panel={panel} />
                  ))}
              </div>
            </section>
          )}
        </div>
        {pendingUninstall && (
          <PluginUninstallDialog
            busy={busyPlugin !== undefined}
            error={pluginError}
            onCancel={() => setPendingUninstall(undefined)}
            onConfirm={() =>
              void runPluginAction(pendingUninstall, onUninstall).then((completed) => {
                if (completed) setPendingUninstall(undefined);
              })
            }
            pluginName={catalogByPackage.get(pendingUninstall.name)?.name ?? displayPluginName(pendingUninstall.name)}
          />
        )}
      </div>
    </section>
  );
}

function InstalledPluginDetail({
  plugin,
  panel,
  metadata,
  capabilityLabel,
  onBack,
  onToggle,
  onUninstall,
}: {
  plugin: ClientPlugin;
  panel?: ClientPluginPanel;
  metadata?: ClientMarketplacePlugin;
  capabilityLabel: (id: string) => string;
  onBack: () => void;
  onToggle: (plugin: ClientPlugin) => Promise<{ restartRequired?: boolean }>;
  onUninstall: (plugin: ClientPlugin) => Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<"toggle" | "uninstall">();
  const awaitingRestart = plugin.state === RESTART_REQUIRED_PLUGIN_STATE;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const title = metadata?.name ?? displayPluginName(plugin.name);
  const run = async (action: "toggle" | "uninstall", callback: () => Promise<{ restartRequired?: boolean } | void>) => {
    setError("");
    setNotice("");
    setBusyAction(action);
    try {
      const result = await callback();
      if (result?.restartRequired === true) setNotice(RESTART_REQUIRED_NOTICE);
      return true;
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusyAction(undefined);
    }
  };
  return (
    <section className="marketplace-page flex min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="subnav plugin-detail-subnav">
          <a
            href="?page=plugins"
            onClick={(event) => {
              event.preventDefault();
              onBack();
            }}
          >
            ← 已安装插件
          </a>
          <span>插件详情</span>
        </div>
        <div className="plugin-detail-content">
          <header className="border-b border-[#e3e7ee] pb-7">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className={`rounded px-2 py-1 font-mono text-[10px] ${plugin.enabled ? "bg-[#e6faed] text-[#14733f]" : "bg-[#eef0f3] text-[#687381]"}`}>
                {plugin.enabled ? "运行中" : "已停用"}
              </span>
              <span className="rounded bg-[#f2edff] px-2 py-1 text-[10px] text-[#6d4bc3]">
                {metadata?.category.label ?? plugin.category?.label ?? "运行时插件"}
              </span>
              <span className="rounded bg-[#e4edfd] px-2 py-1 font-mono text-[10px] text-[#3565c5]">{capability(plugin.name)}</span>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-5">
              <div className="min-w-0">
                <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-[#687381]">PLUGIN DETAIL</p>
                <h1 className="text-3xl font-semibold tracking-[-0.03em] text-[#20252b]">{title}</h1>
                <code className="mt-3 block break-all text-[12px] text-[#687381]">
                  {plugin.name}
                  {metadata ? ` · v${metadata.version}` : ""}
                </code>
              </div>
              {plugin.removable ? (
                <div className="plugin-detail-actions">
                  <button
                    className="plugin-detail-action"
                    disabled={busyAction !== undefined || awaitingRestart}
                    onClick={() => void run("toggle", () => onToggle(plugin))}
                    title={awaitingRestart ? "插件已安装但还没加载，重启 Pi Harness 后才能停用或启用" : undefined}
                    type="button"
                  >
                    {busyAction === "toggle" ? "处理中…" : awaitingRestart ? "等待重启" : plugin.enabled ? "停用插件" : "启用插件"}
                  </button>
                  <button
                    className="plugin-detail-action danger"
                    disabled={busyAction !== undefined}
                    onClick={() => {
                      setError("");
                      setConfirmUninstall(true);
                    }}
                    type="button"
                  >
                    卸载插件
                  </button>
                </div>
              ) : (
                <span className="rounded-full bg-[#eef0f3] px-3 py-1.5 text-[11px] text-[#687381]">内置组件</span>
              )}
            </div>
            <p className="mt-5 max-w-3xl text-[14px] leading-7 text-[#59636e]">
              {metadata?.description ?? (plugin.enabled ? "由当前运行时加载并启用，能力与 hook 已注册。" : "插件保留在运行配置中，但当前处于停用状态。")}
            </p>
            {error && (
              <p className="mt-3 text-[12px] text-[#b42318]" role="alert">
                操作失败：{pluginActionErrorText(error)}
              </p>
            )}
            {notice && (
              <p className="mt-3 text-[12px] text-[#8a5a00]" role="status">
                {notice}
              </p>
            )}
          </header>
          <div className="grid gap-4 py-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-4">
              <section className="rounded-[10px] border border-[#e3e7ee] bg-white p-5">
                <h2 className="text-[13px] font-semibold text-[#20252b]">影响范围</h2>
                <div className="mt-4 flex flex-wrap gap-2">
                  {(metadata?.capabilities.length ? metadata.capabilities.map(capabilityLabel) : [capability(plugin.name)]).map((item) => (
                    <span className="rounded-md bg-[#f1f4f9] px-2 py-1 text-[11px] text-[#61666b]" key={item}>
                      {item}
                    </span>
                  ))}
                </div>
              </section>
              {metadata?.hooks.length ? (
                <section className="rounded-[10px] border border-[#e3e7ee] bg-white p-5">
                  <h2 className="text-[13px] font-semibold text-[#20252b]">扩展点</h2>
                  <div className="mt-4 space-y-2">
                    {metadata.hooks.map((item) => (
                      <div className="rounded-md bg-[#f8f9fb] px-3 py-2 font-mono text-[11px] text-[#61666b]" key={item}>
                        {item}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              <section className="rounded-[10px] border border-[#e3e7ee] bg-white p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[13px] font-semibold text-[#20252b]">实时详情</h2>
                    <p className="mt-1 text-[12px] text-[#687381]">当前本机会话中的插件运行状态。</p>
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#687381]">LIVE</span>
                </div>
                {panel ? <PluginPanelCard inline panel={panel} /> : <div className="empty-state">这个插件暂未提供实时面板。</div>}
              </section>
            </div>
            <aside className="h-fit rounded-[10px] border border-[#e3e7ee] bg-white p-5">
              <h2 className="text-[13px] font-semibold text-[#20252b]">插件信息</h2>
              <dl className="mt-4 divide-y divide-[#eef0f3] text-[12px]">
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[#687381]">运行状态</dt>
                  <dd className="font-mono text-[#3b424b]">{awaitingRestart ? "已安装，重启后生效" : plugin.state}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[#687381]">配置标识</dt>
                  <dd className="max-w-[150px] break-all text-right font-mono text-[#3b424b]">{plugin.id}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[#687381]">分类</dt>
                  <dd className="text-right text-[#3b424b]">{plugin.category?.label ?? "运行时插件"}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[#687381]">管理方式</dt>
                  <dd className="text-right text-[#3b424b]">{plugin.removable ? "可配置" : "随运行时加载"}</dd>
                </div>
                {metadata ? (
                  <div className="flex justify-between gap-4 py-3">
                    <dt className="text-[#687381]">版本</dt>
                    <dd className="font-mono text-[#3b424b]">{metadata.version}</dd>
                  </div>
                ) : null}
              </dl>
              {metadata ? (
                <a className="mt-4 block border-t border-[#eef0f3] pt-4 text-[12px] text-[#3565c5]" href={metadata.repository} rel="noreferrer" target="_blank">
                  查看源码 ↗
                </a>
              ) : null}
            </aside>
          </div>
        </div>
      </div>
      {confirmUninstall ? (
        <PluginUninstallDialog
          busy={busyAction === "uninstall"}
          error={error}
          onCancel={() => setConfirmUninstall(false)}
          onConfirm={() =>
            void run("uninstall", () => onUninstall(plugin)).then((completed) => {
              if (completed) setConfirmUninstall(false);
            })
          }
          pluginName={title}
        />
      ) : null}
    </section>
  );
}

export function Marketplace({
  plugins,
  capabilities,
  categories,
  total,
  page,
  hasNext,
  query,
  capabilityLabel,
  capabilityFilter,
  categoryFilter,
  onQueryChange,
  onCapabilityChange,
  onCategoryChange,
  onPageChange,
  onOpenDetail,
  onBack,
  onToml,
  installedPackages,
  restartPendingPackages,
  onInstall,
}: {
  plugins: readonly ClientMarketplacePlugin[];
  capabilities: readonly ClientMarketplaceCapability[];
  categories: readonly ClientMarketplaceCategory[];
  total: number;
  page: number;
  hasNext: boolean;
  query: string;
  capabilityLabel: (id: string) => string;
  capabilityFilter: string;
  categoryFilter: string;
  onQueryChange: (value: string) => void;
  onCapabilityChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onPageChange: (value: number) => void;
  onOpenDetail: (plugin: ClientMarketplacePlugin) => void;
  onBack: () => void;
  onToml: () => void;
  installedPackages: ReadonlySet<string>;
  restartPendingPackages: ReadonlySet<string>;
  onInstall: (plugin: ClientMarketplacePlugin) => Promise<{ restartRequired?: boolean }>;
}) {
  const [installing, setInstalling] = useState<string>();
  const [installError, setInstallError] = useState("");
  // The notice states what the pending set means, so it is read from that set rather than remembered here: leaving the marketplace unmounts this panel, and a restart that empties the set has to take the notice with it instead of leaving a message telling the user to do what they already did.
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const showInstallNotice = !noticeDismissed && restartPendingPackages.size > 0;
  const categoryTabs = useMemo(() => marketplaceCategoryTabs(categories), [categories]);
  const install = async (plugin: ClientMarketplacePlugin) => {
    setInstallError("");
    setNoticeDismissed(false);
    setInstalling(plugin.id);
    try {
      await onInstall(plugin);
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(undefined);
    }
  };
  return (
    <section className="marketplace-page flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="subnav">
          <div aria-label="插件目录" className="segmented">
            <button aria-pressed="false" onClick={onBack} type="button">
              已安装
            </button>
            <button aria-pressed="true" className="active" type="button">
              插件市场
            </button>
          </div>
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              onToml();
            }}
          >
            查看运行配置
          </a>
        </div>
        <div className="marketplace-toolbar">
          <input
            className="marketplace-search"
            aria-label="搜索插件"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索名称、包名、影响范围…"
            value={query}
          />
          <select
            className="marketplace-filter"
            aria-label="按影响范围筛选"
            onChange={(event) => onCapabilityChange(event.target.value)}
            value={capabilityFilter}
          >
            <option value="">全部影响</option>
            {capabilities.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}（{item.count}）
              </option>
            ))}
          </select>
          <span className="marketplace-count">{total} 个已审核条目 · 推荐排序</span>
          {/* The result of an install belongs next to the button that started it: the card grid below scrolls, so a message under it is thousands of pixels away from the card the user clicked. The region is always in the markup so a screen reader announces the message that lands in it. */}
          <div aria-live="polite" className="marketplace-toolbar-message">
            {installError && (
              <p className="marketplace-message error" role="alert">
                安装失败：{pluginActionErrorText(installError)}
              </p>
            )}
            {showInstallNotice && (
              <p className="marketplace-message notice">
                {RESTART_REQUIRED_NOTICE}
                <button className="marketplace-message-dismiss" onClick={() => setNoticeDismissed(true)} type="button">
                  知道了
                </button>
              </p>
            )}
          </div>
        </div>
        <PluginCategoryNav activeCategory={categoryFilter} categories={categoryTabs} label="插件分类" onChange={onCategoryChange} />
        <div className="marketplace-scroll">
          <div className="marketplace-grid">
            {plugins.map((plugin) => (
              <article className="catalog-card marketplace-card" key={plugin.id}>
                <header className="marketplace-card-head">
                  <div className="marketplace-card-mark">◈</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <strong className="marketplace-title">{plugin.name}</strong>
                      <span
                        className={
                          plugin.status === "verified"
                            ? "rounded bg-[#e6faed] px-1.5 py-px font-mono text-[10px] text-[#14733f]"
                            : "rounded bg-[#fff5e7] px-1.5 py-px font-mono text-[10px] text-[#9a6700]"
                        }
                      >
                        {plugin.status === "verified" ? "已验证" : "实验性"}
                      </span>
                      <span
                        className={
                          plugin.source === "official"
                            ? "rounded bg-[#e4edfd] px-1.5 py-px font-mono text-[10px] text-[#3565c5]"
                            : "rounded bg-[#fef5e7] px-1.5 py-px font-mono text-[10px] text-[#9a6700]"
                        }
                      >
                        {plugin.source === "official" ? "官方" : "社区"}
                      </span>
                      <span className="rounded bg-[#f2edff] px-1.5 py-px text-[10px] text-[#6d4bc3]">{plugin.category.label}</span>
                    </div>
                  </div>
                </header>
                <div className="marketplace-card-body">
                  <code className="marketplace-package">
                    {displayPluginName(plugin.packageName)} · v{plugin.version}
                  </code>
                  <p className="marketplace-description">{plugin.description}</p>
                  <div className="marketplace-tags">
                    {plugin.capabilities.map((item) => (
                      <span className="rounded bg-[#f1f4f9] px-1.5 py-px text-[10px] text-[#61666b]" key={item}>
                        {capabilityLabel(item)}
                      </span>
                    ))}
                    {plugin.hooks.map((item) => (
                      <span className="rounded bg-[#f1f4f9] px-1.5 py-px font-mono text-[10px] text-[#61666b]" key={`hook:${item}`}>
                        hook:{item}
                      </span>
                    ))}
                  </div>
                  {plugin.statistics && (
                    <div className="marketplace-statistics mt-3 grid grid-cols-3 divide-x divide-[#e3e7ee] rounded-md border border-[#e3e7ee] bg-[#f8f9fb]">
                      {marketplaceStatisticItems(plugin.statistics).map((item) => (
                        <span className="min-w-0 px-2 py-1.5" key={item.label} title={`${item.label} ${item.value}`}>
                          <small className="block truncate text-[9px] text-[#687381]">{item.label}</small>
                          <strong className="mt-0.5 block truncate font-mono text-[10px] font-medium text-[#3b424b]">{item.value}</strong>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <footer className="marketplace-card-footer">
                  <span>
                    {plugin.author} · {plugin.license}
                  </span>
                  <a
                    href={marketplaceDetailPath(plugin.id)}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpenDetail(plugin);
                    }}
                  >
                    查看详情 →
                  </a>
                  <a href={plugin.repository} target="_blank" rel="noreferrer">
                    查看源码 ↗
                  </a>
                  {/* A plugin that asked for a restart is installed on disk but missing from the loader, so the button says so rather than inviting the same install again. */}
                  <button
                    disabled={installedPackages.has(plugin.packageName) || restartPendingPackages.has(plugin.packageName) || installing !== undefined}
                    onClick={() => void install(plugin)}
                    type="button"
                  >
                    {installedPackages.has(plugin.packageName)
                      ? "已安装"
                      : restartPendingPackages.has(plugin.packageName)
                        ? "重启后生效"
                        : installing === plugin.id
                          ? "安装中…"
                          : "安装"}
                  </button>
                </footer>
              </article>
            ))}
            {!plugins.length && <div className="empty-state">没有匹配的插件。</div>}
          </div>
          <div className="marketplace-pagination">
            <button className="marketplace-pagination-button" disabled={page === 0} onClick={() => onPageChange(page - 1)} type="button">
              上一页
            </button>
            <span>第 {page + 1} 页</span>
            <button className="marketplace-pagination-button" disabled={!hasNext} onClick={() => onPageChange(page + 1)} type="button">
              下一页
            </button>
          </div>
          <div className="marketplace-contribute mt-3 flex items-center gap-2.5 rounded-[10px] border border-dashed border-[#b8ccf5] bg-[#f8f9ff] p-2.5 text-[11.5px] text-[#687381]">
            <strong className="text-[12px] text-[#0f1115]">你有一个 Pi Harness 插件？</strong>
            <span>在 entries 目录新增一个元数据文件，附测试和 README 后提交 PR；审核通过后会出现在这里。</span>
            <a
              className="ml-auto flex-none text-[#3565c5]"
              href="https://github.com/pi-harness/pi-harness/blob/main/docs/plugin-marketplace.md"
              target="_blank"
              rel="noreferrer"
            >
              查看贡献规范 ↗
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function MarketplaceDetail({
  plugin,
  installed,
  restartPending,
  capabilityLabel,
  onInstall,
  onBack,
}: {
  plugin: ClientMarketplacePlugin;
  installed: boolean;
  restartPending: boolean;
  capabilityLabel: (id: string) => string;
  onInstall: (plugin: ClientMarketplacePlugin) => Promise<{ restartRequired?: boolean }>;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const install = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await onInstall(plugin);
      if (result.restartRequired === true) setNotice(RESTART_REQUIRED_NOTICE);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="marketplace-page flex min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="subnav plugin-detail-subnav">
          <a
            href="?page=marketplace"
            onClick={(event) => {
              event.preventDefault();
              onBack();
            }}
          >
            ← 插件市场
          </a>
          <span>插件详情</span>
        </div>
        <div className="plugin-detail-content">
          <header className="border-b border-[#e3e7ee] pb-7">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="rounded bg-[#e4edfd] px-2 py-1 font-mono text-[10px] text-[#3565c5]">
                {plugin.source === "official" ? "官方插件" : "社区插件"}
              </span>
              <span className="rounded bg-[#f2edff] px-2 py-1 text-[10px] text-[#6d4bc3]">{plugin.category.label}</span>
              <span
                className={
                  plugin.status === "verified"
                    ? "rounded bg-[#e6faed] px-2 py-1 font-mono text-[10px] text-[#14733f]"
                    : "rounded bg-[#fff5e7] px-2 py-1 font-mono text-[10px] text-[#9a6700]"
                }
              >
                {plugin.status === "verified" ? "已验证" : "实验性"}
              </span>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-5">
              <div className="min-w-0">
                <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-[#687381]">PLUGIN DETAIL</p>
                <h1 className="text-3xl font-semibold tracking-[-0.03em] text-[#20252b]">{plugin.name}</h1>
                <code className="mt-3 block break-all text-[12px] text-[#687381]">
                  {plugin.packageName} · v{plugin.version}
                </code>
              </div>
              <div className="plugin-detail-actions">
                <button className="plugin-detail-action primary" disabled={installed || restartPending || busy} onClick={() => void install()} type="button">
                  {installed ? "已安装" : restartPending ? "重启后生效" : busy ? "安装中…" : "安装插件"}
                </button>
              </div>
            </div>
            <p className="mt-5 max-w-3xl text-[14px] leading-7 text-[#59636e]">{plugin.description}</p>
            {notice && (
              <p aria-live="polite" className="mt-3 text-[12px] text-[#3565c5]">
                {notice}
              </p>
            )}
            {error && (
              <p className="mt-3 text-[12px] text-[#b42318]" role="alert">
                安装失败：{pluginActionErrorText(error)}
              </p>
            )}
          </header>
          <div className="grid gap-4 py-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-4">
              <section className="rounded-[10px] border border-[#e3e7ee] bg-white p-5">
                <h2 className="text-[13px] font-semibold text-[#20252b]">影响范围</h2>
                <div className="mt-4 flex flex-wrap gap-2">
                  {plugin.capabilities.map((item) => (
                    <span className="rounded-md bg-[#f1f4f9] px-2 py-1 text-[11px] text-[#61666b]" key={item}>
                      {capabilityLabel(item)}
                    </span>
                  ))}
                </div>
              </section>
              <section className="rounded-[10px] border border-[#e3e7ee] bg-white p-5">
                <h2 className="text-[13px] font-semibold text-[#20252b]">扩展点</h2>
                <div className="mt-4 space-y-2">
                  {plugin.hooks.map((item) => (
                    <div className="rounded-md bg-[#f8f9fb] px-3 py-2 font-mono text-[11px] text-[#61666b]" key={item}>
                      {item}
                    </div>
                  ))}
                </div>
              </section>
              <section className="rounded-[10px] border border-[#e3e7ee] bg-white p-5">
                <h2 className="text-[13px] font-semibold text-[#20252b]">运行配置</h2>
                <p className="mt-1 text-[12px] text-[#687381]">安装后会写入当前运行 profile。</p>
                <pre className="mt-4 overflow-auto rounded-lg bg-[#f7f8fa] p-4 text-[11px] leading-6 text-[#3b424b]">
                  <code>{JSON.stringify(plugin.profile, null, 2)}</code>
                </pre>
              </section>
            </div>
            <aside className="h-fit rounded-[10px] border border-[#e3e7ee] bg-white p-5">
              <h2 className="text-[13px] font-semibold text-[#20252b]">插件信息</h2>
              <dl className="mt-4 divide-y divide-[#eef0f3] text-[12px]">
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[#687381]">作者</dt>
                  <dd className="text-right text-[#3b424b]">{plugin.author}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[#687381]">许可证</dt>
                  <dd className="font-mono text-[#3b424b]">{plugin.license}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[#687381]">分类</dt>
                  <dd className="text-right text-[#3b424b]">{plugin.category.label}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[#687381]">版本</dt>
                  <dd className="font-mono text-[#3b424b]">{plugin.version}</dd>
                </div>
                {marketplaceStatisticItems(plugin.statistics).map((item) => (
                  <div className="flex justify-between gap-4 py-3" key={item.label}>
                    <dt className="text-[#687381]">{item.label}</dt>
                    <dd className="font-mono text-[#3b424b]">{item.value}</dd>
                  </div>
                ))}
              </dl>
              <a className="mt-4 block border-t border-[#eef0f3] pt-4 text-[12px] text-[#3565c5]" href={plugin.repository} target="_blank" rel="noreferrer">
                查看源码 ↗
              </a>
            </aside>
          </div>
        </div>
      </div>
    </section>
  );
}

// Every config refresh path has to feed the source editor as well, otherwise the textarea keeps pre-reload text and the next 保存源码 overwrites the file that was just read from disk.
export async function reloadRuntimeConfig(
  api: Pick<ClientApi, "reloadConfig">,
  apply: {
    config: (value: ClientPiConfig) => void;
    sourceDraft: (source: string) => void;
    state: (message: string) => void;
    busy: (value: boolean) => void;
  },
): Promise<void> {
  apply.busy(true);
  apply.state("重载中…");
  try {
    const value = await api.reloadConfig();
    apply.config(value);
    apply.sourceDraft(value.source);
    apply.state("已从磁盘重载");
  } catch (cause: unknown) {
    apply.state(cause instanceof Error ? cause.message : String(cause));
  } finally {
    apply.busy(false);
  }
}

function Settings({
  data,
  api,
  tab,
  onTab,
  onClose,
  onRefresh,
}: {
  data: RoomData;
  api: ClientApi;
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const status = data.status;
  const [providerState, setProviderState] = useState<Record<string, string>>({});
  const [providerBusy, setProviderBusy] = useState<Record<string, boolean>>({});
  const [providerAddOpen, setProviderAddOpen] = useState(false);
  const [providerForm, setProviderForm] = useState<{
    provider: string;
    name: string;
    baseUrl: string;
    api: "openai-completions" | "openai-responses";
    apiKey: string;
    model: string;
  }>({ provider: "", name: "", baseUrl: "", api: "openai-completions", apiKey: "", model: "" });
  const [config, setConfig] = useState<ClientPiConfig>();
  const [configMode, setConfigMode] = useState<"form" | "source">("form");
  const [configSourceDraft, setConfigSourceDraft] = useState("");
  const [configBusy, setConfigBusy] = useState(false);
  const [configState, setConfigState] = useState("");
  const notifierActive = data.plugins.some((plugin) => plugin.name.endsWith("/cli-notifier") && plugin.enabled);
  const providerDialogRef = useModalFocus(providerAddOpen, () => setProviderAddOpen(false), providerBusy.__add);
  useEffect(() => {
    if (tab !== "general" && tab !== "toml") return;
    setConfigState("读取中…");
    void api
      .getConfig()
      .then((value) => {
        setConfig(value);
        setConfigSourceDraft(value.source);
        setConfigState("");
      })
      .catch((cause: unknown) => setConfigState(cause instanceof Error ? cause.message : String(cause)));
  }, [api, tab]);
  const updateConfig = (input: Partial<ClientPiConfig["settings"]>, message: string) => {
    setConfigBusy(true);
    setConfigState(message);
    void api
      .updateConfig(input)
      .then((value) => {
        setConfig(value);
        setConfigSourceDraft(value.source);
      })
      .then(() => setConfigState("已保存"))
      .catch((cause: unknown) => setConfigState(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setConfigBusy(false));
  };
  const runProviderAction = (provider: string, action: "test" | "refresh") => {
    if (providerBusy[provider]) return;
    setProviderBusy((current) => ({ ...current, [provider]: true }));
    setProviderState((current) => ({ ...current, [provider]: action === "test" ? "测试中…" : "刷新中…" }));
    if (action === "test")
      void api
        .testProvider(provider)
        .then((result) => {
          const auth = result.auth;
          const label = auth && typeof auth === "object" && "label" in auth && typeof auth.label === "string" ? auth.label : undefined;
          setProviderState((current) => ({ ...current, [provider]: result.reachable ? "连接正常" : (label ?? "未检测到认证") }));
        })
        .catch((cause: unknown) => setProviderState((current) => ({ ...current, [provider]: cause instanceof Error ? cause.message : String(cause) })))
        .finally(() => setProviderBusy((current) => ({ ...current, [provider]: false })));
    else
      void api
        .refreshProvider(provider)
        .then((result) => setProviderState((current) => ({ ...current, [provider]: `${result.models.length} 个模型已刷新` })))
        .catch((cause: unknown) => setProviderState((current) => ({ ...current, [provider]: cause instanceof Error ? cause.message : String(cause) })))
        .finally(() => setProviderBusy((current) => ({ ...current, [provider]: false })));
  };
  return (
    <section className="view-panel settings-page">
      <div className="settings-dialog">
        <nav aria-label="设置分类" className="settings-top-tabs">
          {(["general", "providers", "toml"] as const).map((item) => (
            <button aria-pressed={tab === item} className={`settings-tab ${tab === item ? "active" : ""}`} key={item} onClick={() => onTab(item)} type="button">
              {item === "general" ? "通用" : item === "providers" ? `提供商 ${data.providers.length}` : "运行配置"}
            </button>
          ))}
        </nav>
        <section>
          <header>
            <button className="settings-back" onClick={onClose} type="button">
              ← 返回会话
            </button>
            <div className="settings-header-copy">
              <strong>{tab === "general" ? "通用" : tab === "providers" ? "提供商" : "运行配置"}</strong>
              <small>{tab === "toml" ? "配置即代码，改完重载" : "运行时状态与快捷键"}</small>
            </div>
          </header>
          <div className="settings-body">
            {tab === "general" && (
              <>
                {[
                  ["工作目录", status?.cwd],
                  ["agent 目录", status?.agentDir],
                  ["会话", status ? `${status.sessionId} · ${status.messages} 条消息` : "—"],
                  ["快捷键", "⌘K 命令 · ⌘, 设置 · ⌃C 中断"],
                  ["权限策略", "当前 API 未提供修改接口"],
                ].map(([key, item]) => (
                  <div className="general-row" key={key}>
                    <div>
                      <strong>{key}</strong>
                      <small>{value(item)}</small>
                    </div>
                  </div>
                ))}
                <div className="general-row">
                  <div>
                    <strong>任务结束提醒插件</strong>
                    <small>由 CLI Notifier 提供，具体目标在插件配置中管理</small>
                  </div>
                  <span className={`setting-status ${notifierActive ? "on" : ""}`}>{notifierActive ? "已加载" : "未加载"}</span>
                </div>
                <div className="general-row">
                  <div>
                    <strong>自动压缩上下文</strong>
                    <small>接近上下文上限时自动整理历史消息，可在运行配置中修改</small>
                    {!config && configState && configState !== "读取中…" ? (
                      <small className="setting-error" role="alert">
                        配置读取失败：{configState}
                      </small>
                    ) : null}
                  </div>
                  <span className={`setting-status ${config?.settings.compaction.enabled ? "on" : ""}`}>
                    {config ? (config.settings.compaction.enabled ? "已开启" : "已关闭") : configState === "读取中…" ? "读取中" : "不可用"}
                  </span>
                </div>
              </>
            )}
            {tab === "providers" && (
              <>
                <div className="provider-add-head">
                  <div>
                    <strong>已启用提供商</strong>
                    <small>模型列表只显示当前会话和已配置提供商。</small>
                  </div>
                  <button className="primary" onClick={() => setProviderAddOpen(true)} type="button">
                    添加提供商
                  </button>
                </div>
                {providerAddOpen && (
                  <div
                    className="provider-add-overlay"
                    onClick={() => {
                      if (!providerBusy.__add) setProviderAddOpen(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        if (!providerBusy.__add) setProviderAddOpen(false);
                      }
                    }}
                  >
                    <div
                      aria-busy={providerBusy.__add}
                      aria-label="添加提供商"
                      aria-modal="true"
                      className="provider-add-modal"
                      onClick={(event) => event.stopPropagation()}
                      ref={providerDialogRef}
                      role="dialog"
                      tabIndex={-1}
                    >
                      <header>
                        <div>
                          <strong>添加自定义提供商</strong>
                          <small>注册 OpenAI 兼容接口，凭据只提交到本机 Pi runtime。</small>
                        </div>
                        <button aria-label="关闭添加提供商" disabled={providerBusy.__add} onClick={() => setProviderAddOpen(false)} type="button">
                          ×
                        </button>
                      </header>
                      <form
                        className="provider-add-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!providerForm.provider || !providerForm.baseUrl || !providerForm.apiKey || !providerForm.model) return;
                          setProviderBusy((current) => ({ ...current, __add: true }));
                          setProviderState((current) => ({ ...current, __add: "添加中…" }));
                          void api
                            .addProvider(providerForm)
                            .then(async () => {
                              setProviderForm({ provider: "", name: "", baseUrl: "", api: "openai-completions", apiKey: "", model: "" });
                              setProviderState((current) => ({ ...current, __add: "已添加" }));
                              await onRefresh();
                              setProviderAddOpen(false);
                            })
                            .catch((cause: unknown) =>
                              setProviderState((current) => ({ ...current, __add: cause instanceof Error ? cause.message : String(cause) })),
                            )
                            .finally(() => setProviderBusy((current) => ({ ...current, __add: false })));
                        }}
                      >
                        <label>
                          <span>提供商 ID</span>
                          <input
                            aria-label="提供商 ID"
                            data-dialog-initial-focus
                            maxLength={64}
                            minLength={2}
                            pattern="[a-z0-9][a-z0-9._-]{1,63}"
                            placeholder="例如 openrouter"
                            required
                            value={providerForm.provider}
                            onChange={(event) => setProviderForm((current) => ({ ...current, provider: event.target.value }))}
                          />
                        </label>
                        <label>
                          <span>显示名称</span>
                          <input
                            aria-label="提供商名称"
                            placeholder="可选"
                            value={providerForm.name}
                            onChange={(event) => setProviderForm((current) => ({ ...current, name: event.target.value }))}
                          />
                        </label>
                        <label className="provider-add-wide">
                          <span>接口地址</span>
                          <input
                            aria-label="接口地址"
                            placeholder="https://api.example.com/v1"
                            required
                            type="url"
                            value={providerForm.baseUrl}
                            onChange={(event) => setProviderForm((current) => ({ ...current, baseUrl: event.target.value }))}
                          />
                        </label>
                        <label>
                          <span>模型 ID</span>
                          <input
                            aria-label="模型 ID"
                            placeholder="例如 gpt-4o"
                            required
                            value={providerForm.model}
                            onChange={(event) => setProviderForm((current) => ({ ...current, model: event.target.value }))}
                          />
                        </label>
                        <label>
                          <span>协议</span>
                          <select
                            aria-label="协议"
                            value={providerForm.api}
                            onChange={(event) =>
                              setProviderForm((current) => ({ ...current, api: event.target.value as "openai-completions" | "openai-responses" }))
                            }
                          >
                            <option value="openai-completions">OpenAI Completions</option>
                            <option value="openai-responses">OpenAI Responses</option>
                          </select>
                        </label>
                        <label className="provider-add-wide">
                          <span>API key</span>
                          <input
                            aria-label="API key"
                            placeholder="只在本机提交，不会回显"
                            required
                            type="password"
                            value={providerForm.apiKey}
                            onChange={(event) => setProviderForm((current) => ({ ...current, apiKey: event.target.value }))}
                          />
                        </label>
                        <div className="provider-add-actions">
                          <button className="primary" disabled={providerBusy.__add} type="submit">
                            {providerBusy.__add ? "添加中…" : "添加提供商"}
                          </button>
                          {providerState.__add && <small aria-live="polite">{providerState.__add}</small>}
                        </div>
                      </form>
                    </div>
                  </div>
                )}
                <small>已启用提供商 · /api/providers</small>
                {data.providers.length ? (
                  data.providers.map((provider) => (
                    <article className="provider-card" key={provider.provider}>
                      <div className="provider-head">
                        <span className="provider-dot">●</span>
                        <strong>{provider.name}</strong>
                        <span className="provider-state">{provider.active ? "当前会话" : provider.auth?.configured === true ? "已配置" : "未配置"}</span>
                      </div>
                      <div className="provider-field">
                        <code>provider</code>
                        <input aria-label={`${provider.name} 提供商 ID`} disabled value={provider.provider} readOnly />
                      </div>
                      <div className="provider-field">
                        <code>model</code>
                        <div className="provider-model-value" title={provider.models.map((model) => model.id).join(", ") || "暂无模型"}>
                          <span>{provider.activeModel ? `${provider.activeModel.provider}/${provider.activeModel.id}` : "未选择模型"}</span>
                          {provider.models.length > 0 && (
                            <details className="provider-models-details">
                              <summary>查看 {provider.models.length} 个模型</summary>
                              <div className="model-chips">
                                {provider.models.map((model) => (
                                  <span key={model.id}>{model.id}</span>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      </div>
                      <div className="provider-field">
                        <code>api_key</code>
                        <input aria-label={`${provider.name} API key 状态`} disabled value="不会在浏览器显示" readOnly />
                      </div>
                      <div className="provider-footer">
                        <code>{provider.models.length} 个模型</code>
                        <button disabled={providerBusy[provider.provider]} onClick={() => runProviderAction(provider.provider, "test")} type="button">
                          {providerBusy[provider.provider] && providerState[provider.provider] === "测试中…" ? "测试中…" : "测试连接"}
                        </button>
                        <button
                          className="link-button"
                          disabled={providerBusy[provider.provider]}
                          onClick={() => runProviderAction(provider.provider, "refresh")}
                          type="button"
                        >
                          {providerBusy[provider.provider] && providerState[provider.provider] === "刷新中…" ? "刷新中…" : "拉取模型"}
                        </button>
                      </div>
                      {providerState[provider.provider] && (
                        <small aria-live="polite" className="provider-result">
                          {providerState[provider.provider]}
                        </small>
                      )}
                    </article>
                  ))
                ) : (
                  <div className="empty-state">运行时没有注册提供商。</div>
                )}
              </>
            )}
            {tab === "toml" && (
              <div className="config-editor">
                <div className="toml-toolbar">
                  <div>
                    <strong>运行时配置</strong>
                    <span>{config?.path ?? "~/.pi/agent/settings.json"}</span>
                  </div>
                  <button className={configMode === "form" ? "active" : ""} onClick={() => setConfigMode("form")} type="button">
                    表单
                  </button>
                  <button className={configMode === "source" ? "active" : ""} onClick={() => setConfigMode("source")} type="button">
                    源码
                  </button>
                  <button
                    className="primary"
                    disabled={configBusy}
                    onClick={() => {
                      void reloadRuntimeConfig(api, {
                        config: setConfig,
                        sourceDraft: setConfigSourceDraft,
                        state: setConfigState,
                        busy: setConfigBusy,
                      });
                    }}
                    type="button"
                  >
                    重载
                  </button>
                </div>
                {configState && (
                  <div aria-live="polite" className={`config-state ${configState.includes("失败") || configState.includes("Error") ? "error" : ""}`}>
                    {configState}
                  </div>
                )}
                {config ? (
                  configMode === "source" ? (
                    <div className="config-source-editor">
                      <textarea
                        aria-label="settings.json 源码"
                        className="config-source"
                        onChange={(event) => setConfigSourceDraft(event.target.value)}
                        spellCheck={false}
                        value={configSourceDraft}
                      />
                      <div className="config-source-actions">
                        <small>完整 JSON 配置，可编辑未知字段；保存前会校验语法。</small>
                        <button
                          className="primary"
                          disabled={configBusy || !configSourceDraft.trim()}
                          onClick={() => {
                            setConfigBusy(true);
                            setConfigState("保存源码…");
                            void api
                              .updateConfigSource(configSourceDraft)
                              .then((value) => {
                                setConfig(value);
                                setConfigSourceDraft(value.source);
                                setConfigState("已保存源码");
                              })
                              .catch((cause: unknown) => setConfigState(cause instanceof Error ? cause.message : String(cause)))
                              .finally(() => setConfigBusy(false));
                          }}
                          type="button"
                        >
                          保存源码
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="config-sections">
                      <section className="config-section">
                        <header>
                          <strong>模型默认值</strong>
                          <small>新会话启动时使用的模型和思考级别</small>
                        </header>
                        <label className="config-field">
                          <span>提供商</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ defaultProvider: event.target.value }, "保存提供商…")}
                            value={config.settings.defaultProvider ?? ""}
                          >
                            <option value="">跟随运行时</option>
                            {data.providers.map((provider) => (
                              <option key={provider.provider} value={provider.provider}>
                                {provider.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="config-field">
                          <span>模型</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ defaultModel: event.target.value }, "保存模型…")}
                            value={config.settings.defaultModel ?? ""}
                          >
                            <option value="">跟随提供商</option>
                            {data.models.map((model) => (
                              <option key={`${model.provider}/${model.id}`} value={model.id}>
                                {model.provider}/{model.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="config-field">
                          <span>思考级别</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ defaultThinkingLevel: event.target.value }, "保存思考级别…")}
                            value={config.settings.defaultThinkingLevel ?? "medium"}
                          >
                            {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => (
                              <option key={level} value={level}>
                                {level}
                              </option>
                            ))}
                          </select>
                        </label>
                      </section>
                      <section className="config-section">
                        <header>
                          <strong>运行策略</strong>
                          <small>消息队列和网络传输行为</small>
                        </header>
                        <label className="config-field">
                          <span>传输方式</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ transport: event.target.value }, "保存传输方式…")}
                            value={config.settings.transport}
                          >
                            <option value="auto">自动</option>
                            <option value="sse">SSE</option>
                            <option value="websocket">WebSocket</option>
                          </select>
                        </label>
                        <label className="config-field">
                          <span>Steering 消息</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ steeringMode: event.target.value }, "保存队列策略…")}
                            value={config.settings.steeringMode}
                          >
                            <option value="one-at-a-time">逐条发送</option>
                            <option value="all">一次发送全部</option>
                          </select>
                        </label>
                        <label className="config-field">
                          <span>Follow-up 消息</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ followUpMode: event.target.value }, "保存跟进策略…")}
                            value={config.settings.followUpMode}
                          >
                            <option value="one-at-a-time">逐条发送</option>
                            <option value="all">一次发送全部</option>
                          </select>
                        </label>
                      </section>
                      <section className="config-section">
                        <header>
                          <strong>上下文与显示</strong>
                          <small>控制思考内容和自动压缩</small>
                        </header>
                        <label className="config-toggle">
                          <span>
                            <strong>隐藏思考正文</strong>
                            <small>只显示可展开的思考摘要</small>
                          </span>
                          <input
                            checked={config.settings.hideThinkingBlock}
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ hideThinkingBlock: event.target.checked }, "保存显示设置…")}
                            type="checkbox"
                          />
                        </label>
                        <label className="config-toggle">
                          <span>
                            <strong>自动压缩上下文</strong>
                            <small>接近上下文上限时自动整理历史消息</small>
                          </span>
                          <input
                            checked={config.settings.compaction.enabled}
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ compaction: { ...config.settings.compaction, enabled: event.target.checked } }, "保存压缩设置…")
                            }
                            type="checkbox"
                          />
                        </label>
                        <label className="config-toggle">
                          <span>
                            <strong>自动重试</strong>
                            <small>临时网络错误时自动重试请求</small>
                          </span>
                          <input
                            checked={config.settings.retry.enabled}
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ retry: { ...config.settings.retry, enabled: event.target.checked } }, "保存重试设置…")}
                            type="checkbox"
                          />
                        </label>
                        <label className="config-toggle">
                          <span>
                            <strong>显示图片</strong>
                            <small>允许模型响应中的图片渲染</small>
                          </span>
                          <input
                            checked={config.settings.terminal.showImages}
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ terminal: { ...config.settings.terminal, showImages: event.target.checked } }, "保存图片设置…")}
                            type="checkbox"
                          />
                        </label>
                      </section>
                      <section className="config-section">
                        <header>
                          <strong>终端与导航</strong>
                          <small>控制命令行界面和消息渲染行为</small>
                        </header>
                        <label className="config-toggle">
                          <span>
                            <strong>安静启动</strong>
                            <small>启动时隐藏版本和更新提示</small>
                          </span>
                          <input
                            checked={config.settings.advanced.quietStartup}
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ advanced: { ...config.settings.advanced, quietStartup: event.target.checked } }, "保存启动设置…")
                            }
                            type="checkbox"
                          />
                        </label>
                        <label className="config-field">
                          <span>项目可信策略</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ advanced: { ...config.settings.advanced, projectTrust: event.target.value } }, "保存信任策略…")}
                            value={config.settings.advanced.projectTrust}
                          >
                            <option value="ask">每次询问</option>
                            <option value="always">始终信任</option>
                            <option value="never">从不信任</option>
                          </select>
                        </label>
                        <label className="config-field">
                          <span>Mermaid 渲染</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ advanced: { ...config.settings.advanced, mermaid: event.target.value } }, "保存 Mermaid 设置…")}
                            value={config.settings.advanced.mermaid}
                          >
                            <option value="off">关闭</option>
                            <option value="final">完成后渲染</option>
                            <option value="streaming">流式渲染</option>
                          </select>
                        </label>
                        <label className="config-field">
                          <span>双击 Escape</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ advanced: { ...config.settings.advanced, doubleEscapeAction: event.target.value } }, "保存快捷键设置…")
                            }
                            value={config.settings.advanced.doubleEscapeAction}
                          >
                            <option value="tree">打开会话树</option>
                            <option value="fork">创建分支</option>
                            <option value="none">不执行</option>
                          </select>
                        </label>
                      </section>
                      <section className="config-section">
                        <header>
                          <strong>诊断与隐私</strong>
                          <small>控制缓存提示和匿名数据上报</small>
                        </header>
                        <label className="config-toggle">
                          <span>
                            <strong>显示缓存未命中</strong>
                            <small>在消息中显示模型缓存诊断</small>
                          </span>
                          <input
                            checked={config.settings.advanced.showCacheMissNotices}
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ advanced: { ...config.settings.advanced, showCacheMissNotices: event.target.checked } }, "保存诊断设置…")
                            }
                            type="checkbox"
                          />
                        </label>
                        <label className="config-toggle">
                          <span>
                            <strong>安装遥测</strong>
                            <small>发送匿名安装和版本统计</small>
                          </span>
                          <input
                            checked={config.settings.advanced.enableInstallTelemetry}
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ advanced: { ...config.settings.advanced, enableInstallTelemetry: event.target.checked } }, "保存隐私设置…")
                            }
                            type="checkbox"
                          />
                        </label>
                      </section>
                    </div>
                  )
                ) : (
                  <div className="empty-state">正在读取运行时配置…</div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

const filterCommands = (commands: readonly ClientCommand[], query: string): readonly ClientCommand[] => {
  const normalized = query.trim().toLowerCase();
  return commands.filter((command) => `${command.invocationName} ${command.description ?? ""}`.toLowerCase().includes(normalized));
};

export function CommandPalette({
  commands,
  query,
  activeIndex,
  onActiveIndexChange,
  onUse,
}: {
  commands: readonly ClientCommand[];
  query: string;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onUse: (value: string) => void;
}) {
  const visible = filterCommands(commands, query);
  const execute = (index: number) => {
    const command = visible[index];
    if (!command) return;
    onUse(`/${command.invocationName}`);
  };
  return (
    <div aria-label="命令面板" className="command-palette" id="command-menu" role="listbox">
      <div className="palette-group">
        <small>
          COMMANDS <span>· RUNTIME REGISTRY</span>
        </small>
        {visible.length ? (
          visible.map((command, index) => {
            const invocation = `/${command.invocationName}`;
            return (
              <button
                aria-selected={index === activeIndex}
                key={`${command.invocationName}:${command.source ?? "runtime"}`}
                onClick={() => execute(index)}
                onMouseEnter={() => onActiveIndexChange(index)}
                role="option"
                type="button"
              >
                <code>{invocation}</code>
                <span>{command.description ?? command.source ?? "由当前运行时注册"}</span>
              </button>
            );
          })
        ) : (
          <div className="empty-state">
            {commands.length
              ? "没有匹配的命令。"
              : "还没有加载任何命令。命令由 pi 扩展注册：把扩展放进 ~/.pi/agent/extensions（或已信任工作区的 .pi/extensions）后重启 Pi Harness。"}
          </div>
        )}
      </div>
    </div>
  );
}

function PromptCompletionPopover({
  kind,
  commands,
  files,
  query,
  activeIndex,
  onActiveIndexChange,
  onUse,
}: {
  kind: PromptCompletionKind;
  commands: readonly ClientCommand[];
  files: readonly ClientFile[];
  query: string;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onUse: (value: string) => void;
}) {
  const items =
    kind === "command"
      ? filterCommands(commands, query).slice(0, 12)
      : files.filter((file) => `${file.path} ${file.label} ${file.status}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 12);
  return (
    <div
      aria-label={kind === "command" ? "命令补全" : "文件补全"}
      className="prompt-completion"
      data-prompt-completion
      id="prompt-completion-list"
      role="listbox"
    >
      <small>{kind === "command" ? "命令" : "文件"}</small>
      {items.length ? (
        items.slice(0, 12).map((item, index) => {
          const label = kind === "command" ? `/${(item as ClientCommand).invocationName}` : `@${(item as ClientFile).path}`;
          const detail =
            kind === "command" ? ((item as ClientCommand).description ?? (item as ClientCommand).source ?? "由当前运行时注册") : (item as ClientFile).status;
          return (
            <button
              aria-selected={index === activeIndex}
              id={`prompt-completion-option-${index}`}
              key={`${kind}:${label}`}
              onClick={() => onUse(label)}
              onMouseEnter={() => onActiveIndexChange(index)}
              role="option"
              type="button"
            >
              <strong>{label}</strong>
              <span>{detail}</span>
            </button>
          );
        })
      ) : (
        <span className="prompt-completion-empty">没有匹配项</span>
      )}
    </div>
  );
}

type GlobalSearchItem =
  | { kind: "command"; command: ClientCommand }
  | { kind: "session"; session: Record<string, unknown> }
  | { kind: "file"; file: ClientFile };

function GlobalSearch({
  commands,
  sessions,
  files,
  onClose,
  onUse,
  onOpenSession,
  onOpenFile,
}: {
  commands: readonly ClientCommand[];
  sessions: readonly Record<string, unknown>[];
  files: readonly ClientFile[];
  onClose: () => void;
  onUse: (value: string) => void;
  onOpenSession: (session: Record<string, unknown>) => void;
  onOpenFile: (file: ClientFile) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useModalFocus(true, onClose);
  const normalized = query.trim().toLowerCase();
  const matches = (text: string) => !normalized || text.toLowerCase().includes(normalized);
  const items: readonly GlobalSearchItem[] = [
    ...commands
      .filter((command) => matches(`${command.invocationName} ${command.description ?? ""}`))
      .map((command) => ({ kind: "command" as const, command })),
    ...sessions
      .filter((session) => matches(`${value(session.name, "")} ${value(session.firstMessage, "")} ${value(session.sessionId, "")}`))
      .map((session) => ({ kind: "session" as const, session })),
    ...files.filter((file) => matches(`${file.path} ${file.label} ${file.status}`)).map((file) => ({ kind: "file" as const, file })),
  ];
  const selectedIndex = items.length ? Math.min(activeIndex, items.length - 1) : -1;
  const activeItemId = selectedIndex >= 0 ? `global-search-option-${selectedIndex}` : undefined;
  useEffect(() => setActiveIndex(0), [query]);
  const execute = (item: GlobalSearchItem | undefined) => {
    if (!item) return;
    if (item.kind === "command") onUse(`/${item.command.invocationName}`);
    else if (item.kind === "session") onOpenSession(item.session);
    else onOpenFile(item.file);
    onClose();
  };
  return (
    <div
      className="global-search"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div aria-label="全局搜索" aria-modal="true" className="global-search-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="global-search-heading">
          <strong>全局搜索</strong>
          <small>命令 · 会话 · 文件</small>
          <button aria-label="关闭全局搜索" onClick={onClose} type="button">
            ×
          </button>
        </div>
        <input
          aria-activedescendant={activeItemId}
          aria-autocomplete="list"
          aria-controls="global-search-results"
          aria-expanded="true"
          aria-label="全局搜索"
          data-dialog-initial-focus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown" && items.length) {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % items.length);
            } else if (event.key === "ArrowUp" && items.length) {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + items.length) % items.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              execute(items[selectedIndex]);
            }
          }}
          placeholder="搜索命令、会话或文件"
          role="combobox"
          value={query}
        />
        <div className="global-search-results" id="global-search-results" role="listbox">
          {items.length ? (
            (["command", "session", "file"] as const).map((kind) => {
              const group = items.filter((item) => item.kind === kind);
              if (!group.length) return null;
              const label = kind === "command" ? "命令" : kind === "session" ? "会话" : "文件";
              return (
                <section aria-label={label} className="global-search-group" key={kind} role="group">
                  <small aria-hidden="true">{label}</small>
                  {group.map((item) => {
                    const index = items.indexOf(item);
                    const title =
                      item.kind === "command"
                        ? `/${item.command.invocationName}`
                        : item.kind === "session"
                          ? value(item.session.name ?? item.session.firstMessage ?? item.session.sessionId, "未命名会话")
                          : item.file.label;
                    const detail =
                      item.kind === "command"
                        ? (item.command.description ?? item.command.source ?? "由当前运行时注册")
                        : item.kind === "session"
                          ? `${value(item.session.messageCount, "0")} 条消息`
                          : `${item.file.path} · ${item.file.status}`;
                    return (
                      <button
                        aria-selected={index === selectedIndex}
                        id={`global-search-option-${index}`}
                        key={`${item.kind}:${title}:${index}`}
                        onClick={() => execute(item)}
                        onMouseEnter={() => setActiveIndex(index)}
                        role="option"
                        type="button"
                      >
                        <strong>{title}</strong>
                        <span>{detail}</span>
                      </button>
                    );
                  })}
                </section>
              );
            })
          ) : (
            <div className="empty-state">没有匹配的命令、会话或文件。</div>
          )}
        </div>
      </div>
    </div>
  );
}

// message_update frames carry per-token deltas that this client already applies locally, and the gateway never retains them, so refreshing the whole 11-endpoint snapshot for each of them is pure amplification.
export function shouldRefreshForRuntimeEvent(payload: Record<string, unknown>): boolean {
  const event = payload.event;
  if (typeof event !== "object" || event === null) return true;
  return (event as Record<string, unknown>).type !== "message_update";
}

// The event stream must outlive every handler identity change, otherwise typing in a filter box closes the EventSource and the deltas emitted during the reconnect window are lost for good.
export function subscribeRuntimeEvents(
  api: Pick<ClientApi, "subscribeEvents">,
  handler: { readonly current: (payload: Record<string, unknown>) => void },
): () => void {
  return api.subscribeEvents((payload) => handler.current(payload));
}

type MarketplaceDetailPlan =
  | { readonly kind: "clear" }
  | { readonly kind: "show"; readonly plugin: ClientMarketplacePlugin }
  | { readonly kind: "keep" }
  | { readonly kind: "fetch" };

// `loaded` is every plugin already in memory (the visible page plus the fully paginated catalog); `resolvedId` is the detail already resolved for this route, which keeps a poll from blanking the page and refetching it.
export function marketplaceDetailPlan(
  pluginId: string | undefined,
  loaded: readonly ClientMarketplacePlugin[],
  resolvedId: string | undefined,
): MarketplaceDetailPlan {
  if (pluginId === undefined) return { kind: "clear" };
  const plugin = loaded.find((item) => item.id === pluginId);
  if (plugin !== undefined) return { kind: "show", plugin };
  return resolvedId === pluginId ? { kind: "keep" } : { kind: "fetch" };
}

/** At most `limit` characters, collapsed to one line unless the caller wants the original line breaks kept. */
function previewText(value: string, limit: number, singleLine = true): string {
  const collapsed = singleLine ? value.replace(/\s+/gu, " ").trim() : value;
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

const TOOL_ARGUMENT_PREVIEW_LIMIT = 140;
// A tool result is untrusted text of any length, and the row it belongs to is collapsed, so the transcript keeps a readable head of it rather than pushing megabytes of file contents into the document.
const TOOL_RESULT_PREVIEW_LIMIT = 4_000;

/** The arguments of a call as one line, so the row says which file was read rather than only that `read` ran. */
export function toolArgumentSummary(args: unknown): string {
  if (args === undefined || args === null) return "";
  // A tool is free to take a bare scalar rather than an object of named arguments, and `value` already knows how to print one of those without falling back to [object Object].
  if (typeof args !== "object") return previewText(value(args, ""), TOOL_ARGUMENT_PREVIEW_LIMIT);
  const parts = Object.entries(args as Record<string, unknown>)
    .filter(([, item]) => item !== undefined && item !== null && item !== "")
    .map(([key, item]) => `${key}=${typeof item === "string" ? item : JSON.stringify(item)}`);
  return previewText(parts.join(" · "), TOOL_ARGUMENT_PREVIEW_LIMIT);
}

function toolSignature(tools: readonly ChatToolCall[]): string {
  return tools.map((tool) => `${tool.id}:${tool.name}:${tool.failed ? 1 : 0}:${tool.result?.length ?? -1}`).join("|");
}

// Memoised on primitive props so a poll that returns an identical transcript does not re-run marked + DOMPurify over every turn. The tool list is a fresh array on every poll, so it is compared by content instead of by identity, which is what the default shallow comparison would do.
export const ChatTurnArticle = memo(
  function ChatTurnArticle({
    role,
    text,
    thinking,
    tools = [],
    stopped = false,
    onMouseUp,
  }: {
    role: "user" | "assistant";
    text: string;
    thinking: string;
    tools?: readonly ChatToolCall[];
    stopped?: boolean;
    onMouseUp: () => void;
  }) {
    return (
      <article className={`turn ${role === "user" ? "user" : "text"}`}>
        {role === "user" ? (
          <UserMessageBubble text={text} />
        ) : (
          <>
            {/* A model that emits only whitespace as its reasoning would otherwise open an empty disclosure titled 思考. */}
            {thinking.trim() && (
              <details className="reasoning message-reasoning">
                <summary className="reasoning-head">思考</summary>
                <div className="reasoning-body">
                  <MarkdownMessage text={thinking} />
                </div>
              </details>
            )}
            {/* Without these rows the transcript jumps from the prompt to an answer the model could not have known, because a message whose only content is a tool call carries no text at all. */}
            {tools.map((tool, index) => (
              <details className={`turn-tool ${tool.failed ? "failed" : ""}`} key={tool.id || `${tool.name}-${index}`}>
                <summary className="turn-tool-head">
                  <strong>{tool.name}</strong>
                  <span className="turn-tool-args">{toolArgumentSummary(tool.arguments)}</span>
                  <span className="turn-tool-status">{tool.result === undefined ? "执行中…" : tool.failed ? "失败" : "完成"}</span>
                </summary>
                {tool.result !== undefined && <pre className="turn-tool-output">{previewText(tool.result, TOOL_RESULT_PREVIEW_LIMIT, false)}</pre>}
              </details>
            ))}
            {text && <MarkdownMessage onMouseUp={onMouseUp} text={text} />}
            {/* An interrupted turn otherwise looks exactly like one that finished on its own, and the aborted flag the prompt call returns is gone after a reload, so the marker is read back from the stored message. */}
            {stopped && <p className="turn-stopped">已中断</p>}
          </>
        )}
      </article>
    );
  },
  (previous, next) =>
    previous.role === next.role &&
    previous.text === next.text &&
    previous.thinking === next.thinking &&
    previous.stopped === next.stopped &&
    previous.onMouseUp === next.onMouseUp &&
    toolSignature(previous.tools ?? []) === toolSignature(next.tools ?? []),
);

export function ControlRoomView({ api = createClientApi(), appVersion }: { api?: ClientApi; appVersion?: string }) {
  const initialQueryState = useMemo(readQueryState, []);
  const [data, setData] = useState<RoomData>({
    sessions: [],
    files: [],
    models: [],
    providers: [],
    plugins: [],
    pluginPanels: [],
    marketplace: [],
    marketplaceCapabilities: [],
    marketplaceCategories: [],
    marketplaceTotal: 0,
    marketplacePage: 0,
    marketplaceHasNext: false,
    commands: [],
    workspaces: [],
  });
  const [view, setView] = useState<View>(initialQueryState.view);
  const [page, setPage] = useState<Page>(initialQueryState.page);
  const [settings, setSettings] = useState<SettingsTab | undefined>(initialQueryState.settings);
  const [details, setDetails] = useState<Record<string, unknown>>();
  const [commandOpen, setCommandOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessionMenuPath, setSessionMenuPath] = useState<string>();
  const [sessionMenuPosition, setSessionMenuPosition] = useState<{ left: number; top: number }>();
  const [sessionToolsOpen, setSessionToolsOpen] = useState(false);
  const [sessionToolsPosition, setSessionToolsPosition] = useState<{ left: number; top: number }>();
  const [sessionSelectionMode, setSessionSelectionMode] = useState(false);
  const [sessionDialog, setSessionDialog] = useState<"rename" | "delete" | "archive" | "batch-delete">();
  const [sessionActionTarget, setSessionActionTarget] = useState<{ name: string; path: string }>();
  const [sessionNameDraft, setSessionNameDraft] = useState("");
  const [workspaceChooserOpen, setWorkspaceChooserOpen] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string>();
  const [selectedSessionPath, setSelectedSessionPath] = useState<string | undefined>(initialQueryState.sessionPath);
  const initialSessionPathRef = useRef(initialQueryState.sessionPath);
  const sessionRestoreAttemptedRef = useRef(false);
  const [draft, setDraft] = useState("");
  const [annotations, setAnnotations] = useState<ClientAnnotation[]>([]);
  const [annotationSelection, setAnnotationSelection] = useState("");
  const [annotationNote, setAnnotationNote] = useState("");
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [marketplaceQuery, setMarketplaceQuery] = useState(initialQueryState.marketplaceQuery);
  const [marketplaceCapability, setMarketplaceCapability] = useState(initialQueryState.marketplaceCapability);
  const [marketplaceCategory, setMarketplaceCategory] = useState(initialQueryState.marketplaceCategory);
  const [marketplacePluginId, setMarketplacePluginId] = useState<string | undefined>(initialQueryState.marketplacePlugin);
  const [marketplaceDetail, setMarketplaceDetail] = useState<ClientMarketplacePlugin>();
  const [marketplaceDetailPending, setMarketplaceDetailPending] = useState(initialQueryState.marketplacePlugin !== undefined);
  const [marketplaceDetailError, setMarketplaceDetailError] = useState("");
  const [marketplaceCatalog, setMarketplaceCatalog] = useState<readonly ClientMarketplacePlugin[]>([]);
  const [installedPluginId, setInstalledPluginId] = useState<string | undefined>(initialQueryState.installedPlugin);
  const [installedPluginMetadata, setInstalledPluginMetadata] = useState<ClientMarketplacePlugin>();
  const [marketplacePage, setMarketplacePage] = useState(initialQueryState.marketplacePage);
  const [promptError, setPromptError] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState("");
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [includeArchivedSessions, setIncludeArchivedSessions] = useState(false);
  const [sessionPage, setSessionPage] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [sessionHasNext, setSessionHasNext] = useState(false);
  const [selectedSessionPaths, setSelectedSessionPaths] = useState<ReadonlySet<string>>(new Set());
  const importInputRef = useRef<HTMLInputElement>(null);
  const sessionPopoverTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [streamingAssistant, setStreamingAssistant] = useState<{ thinking: string; text: string }>();
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const refreshQueuedRef = useRef(false);
  const resolvedMarketplaceDetailIdRef = useRef<string | undefined>(undefined);
  const [promptCaret, setPromptCaret] = useState(0);
  const [promptCompletionSuppressed, setPromptCompletionSuppressed] = useState(false);
  const [promptCompletionIndex, setPromptCompletionIndex] = useState(0);
  const [initialRefreshPending, setInitialRefreshPending] = useState(true);
  const [refreshIssues, setRefreshIssues] = useState<readonly string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void loadMarketplaceCatalog(api)
      .then((items) => {
        if (!cancelled) setMarketplaceCatalog(items);
      })
      .catch(() => {
        if (!cancelled) setMarketplaceCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);
  useEffect(() => {
    if (!selectedSessionPath && data.session?.sessionFile) setSelectedSessionPath(data.session.sessionFile);
  }, [data.session?.sessionFile, selectedSessionPath]);
  const promptCompletion = useMemo(() => getPromptCompletion(draft, promptCaret), [draft, promptCaret]);
  const promptCompletionItems = useMemo(() => {
    if (!promptCompletion) return [] as readonly (ClientCommand | ClientFile)[];
    return promptCompletion.kind === "command"
      ? filterCommands(data.commands, promptCompletion.query).slice(0, 12)
      : data.files
          .filter((file) => `${file.path} ${file.label} ${file.status}`.toLowerCase().includes(promptCompletion.query.trim().toLowerCase()))
          .slice(0, 12);
  }, [data.commands, data.files, promptCompletion]);
  const promptCompletionOpen = Boolean(promptCompletion && !promptCompletionSuppressed && promptCompletionItems.length);
  const promptCompletionActiveIndex = Math.min(promptCompletionIndex, Math.max(promptCompletionItems.length - 1, 0));
  const installedPackages = useMemo(
    () => new Set(data.plugins.filter((plugin) => plugin.removable && plugin.state !== RESTART_REQUIRED_PLUGIN_STATE).map((plugin) => plugin.name)),
    [data.plugins],
  );
  // Kept apart from installedPackages, which decides whether the marketplace says 已安装: a plugin waiting for a restart is on disk and in the profile but not loaded, so counting it as installed would claim it is running.
  // The gateway reads the profile, so it reports an install this browser never made and one that survives a reload; the local set below only has to cover the moment between an install and the next poll.
  const reportedRestartPending = useMemo(
    () => new Set(data.plugins.filter((plugin) => plugin.state === RESTART_REQUIRED_PLUGIN_STATE).map((plugin) => plugin.name)),
    [data.plugins],
  );
  const harnessProcess = data.status?.processStartedAt ?? "";
  const capabilityLabel = useMemo(() => marketplaceCapabilityLabeller(data.marketplaceCapabilities), [data.marketplaceCapabilities]);
  const [restartPending, setRestartPending] = useState<RestartPendingState>(() => readRestartPendingPackages(browserStorage()));
  const markRestartPending = (packageName: string) => {
    setRestartPending((current) =>
      current.process === harnessProcess && current.packages.has(packageName)
        ? current
        : { packages: new Set([...(current.process === harnessProcess ? current.packages : []), packageName]), process: harnessProcess },
    );
  };
  useEffect(() => {
    setRestartPending((current) => restartPendingForProcess(current, harnessProcess));
  }, [harnessProcess]);
  useEffect(() => {
    setRestartPending((current) => {
      const packages = withoutInstalledPackages(current.packages, installedPackages);
      return packages === current.packages ? current : { packages, process: current.process };
    });
  }, [installedPackages]);
  useEffect(() => {
    writeRestartPendingPackages(browserStorage(), restartPending);
  }, [restartPending]);
  const restartPendingPackages = useMemo(() => new Set([...reportedRestartPending, ...restartPending.packages]), [reportedRestartPending, restartPending]);
  const workspaceReady =
    !workspaceChooserOpen && Boolean(selectedWorkspacePath || data.status?.cwd || data.workspaces.find((workspace) => workspace.current)?.path || data.session);
  const installedPluginCount = useMemo(() => {
    const panelPluginIds = new Set(data.pluginPanels.map((panel) => panel.pluginId));
    return data.plugins.filter((plugin) => plugin.removable || panelPluginIds.has(plugin.name)).length;
  }, [data.pluginPanels, data.plugins]);
  useEffect(() => {
    setPromptCompletionIndex(0);
  }, [promptCompletion?.kind, promptCompletion?.query]);
  useEffect(() => {
    if (!sessionMenuOpen && !sessionToolsOpen) return;
    const dismissOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-session-popover]")) return;
      setSessionMenuOpen(false);
      setSessionMenuPath(undefined);
      setSessionMenuPosition(undefined);
      setSessionToolsOpen(false);
      setSessionToolsPosition(undefined);
      setSessionActionTarget(undefined);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setSessionMenuOpen(false);
      setSessionMenuPath(undefined);
      setSessionMenuPosition(undefined);
      setSessionToolsOpen(false);
      setSessionToolsPosition(undefined);
      setSessionActionTarget(undefined);
      sessionPopoverTriggerRef.current?.focus();
    };
    const dismissOnViewportChange = () => {
      setSessionMenuOpen(false);
      setSessionMenuPath(undefined);
      setSessionMenuPosition(undefined);
      setSessionToolsOpen(false);
      setSessionToolsPosition(undefined);
      setSessionActionTarget(undefined);
    };
    document.addEventListener("pointerdown", dismissOnPointerDown);
    document.addEventListener("keydown", dismissOnEscape);
    document.addEventListener("scroll", dismissOnViewportChange, true);
    window.addEventListener("resize", dismissOnViewportChange);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointerDown);
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener("scroll", dismissOnViewportChange, true);
      window.removeEventListener("resize", dismissOnViewportChange);
    };
  }, [sessionMenuOpen, sessionToolsOpen]);
  useEffect(() => {
    if (!commandOpen && !promptCompletionOpen) return;
    const dismissTransientLists = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      if (commandOpen && !target?.closest("[data-command-palette]")) {
        setCommandOpen(false);
        setCommandQuery("");
      }
      if (promptCompletionOpen && !target?.closest("[data-prompt-completion]")) setPromptCompletionSuppressed(true);
    };
    document.addEventListener("pointerdown", dismissTransientLists);
    return () => document.removeEventListener("pointerdown", dismissTransientLists);
  }, [commandOpen, promptCompletionOpen]);
  useEffect(() => {
    const dismissProviderModels = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      const target = event.target instanceof Element ? event.target : undefined;
      document.querySelectorAll<HTMLDetailsElement>("details.provider-models-details[open]").forEach((details) => {
        if (event instanceof PointerEvent && target && details.contains(target)) return;
        details.removeAttribute("open");
        if (event instanceof KeyboardEvent) details.querySelector<HTMLElement>("summary")?.focus();
      });
    };
    document.addEventListener("pointerdown", dismissProviderModels);
    document.addEventListener("keydown", dismissProviderModels);
    return () => {
      document.removeEventListener("pointerdown", dismissProviderModels);
      document.removeEventListener("keydown", dismissProviderModels);
    };
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    params.set("page", page);
    if (view === "chat") params.delete("view");
    else params.set("view", view);
    if (settings) params.set("settings", settings);
    else params.delete("settings");
    if (selectedSessionPath) params.set("session", selectedSessionPath);
    else params.delete("session");
    if (marketplaceQuery) params.set("marketplaceQuery", marketplaceQuery);
    else params.delete("marketplaceQuery");
    if (marketplaceCapability) params.set("capability", marketplaceCapability);
    else params.delete("capability");
    if (marketplaceCategory) params.set("category", marketplaceCategory);
    else params.delete("category");
    if (page === "plugins" && installedPluginId) params.set("plugin", installedPluginId);
    else if (page === "marketplace" && marketplacePluginId) params.set("plugin", marketplacePluginId);
    else params.delete("plugin");
    if (marketplacePage > 0) params.set("marketplacePage", String(marketplacePage));
    else params.delete("marketplacePage");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [
    installedPluginId,
    marketplaceCapability,
    marketplaceCategory,
    marketplacePage,
    marketplacePluginId,
    marketplaceQuery,
    page,
    selectedSessionPath,
    settings,
    view,
  ]);
  useEffect(() => {
    const onPopState = () => {
      const next = readQueryState();
      setCommandOpen(false);
      setGlobalSearchOpen(false);
      setSessionMenuOpen(false);
      setDetails(undefined);
      setPage(next.page);
      setView(next.view);
      setSettings(next.settings);
      setSelectedSessionPath(next.sessionPath);
      setMarketplaceQuery(next.marketplaceQuery);
      setMarketplaceCapability(next.marketplaceCapability);
      setMarketplaceCategory(next.marketplaceCategory);
      setMarketplacePage(next.marketplacePage);
      setInstalledPluginId(next.installedPlugin);
      setMarketplacePluginId(next.marketplacePlugin);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    const plan = marketplaceDetailPlan(marketplacePluginId, [...data.marketplace, ...marketplaceCatalog], resolvedMarketplaceDetailIdRef.current);
    if (plan.kind === "keep") return;
    if (plan.kind === "clear") {
      resolvedMarketplaceDetailIdRef.current = undefined;
      setMarketplaceDetail(undefined);
      setMarketplaceDetailPending(false);
      setMarketplaceDetailError("");
      return;
    }
    if (plan.kind === "show") {
      resolvedMarketplaceDetailIdRef.current = marketplacePluginId;
      setMarketplaceDetail(plan.plugin);
      setMarketplaceDetailPending(false);
      setMarketplaceDetailError("");
      return;
    }
    let cancelled = false;
    setMarketplaceDetail(undefined);
    setMarketplaceDetailPending(true);
    setMarketplaceDetailError("");
    void api
      .listMarketplace("", "", 0, 100)
      .then((result) => {
        if (cancelled) return;
        // Only a real answer marks the route resolved; a failed request stays retryable on the next poll.
        resolvedMarketplaceDetailIdRef.current = marketplacePluginId;
        const plugin = result.items.find((item) => item.id === marketplacePluginId);
        if (plugin === undefined) setMarketplaceDetailError("没有找到这个市场插件，它可能已下架。");
        else setMarketplaceDetail(plugin);
      })
      .catch((cause) => {
        if (!cancelled) setMarketplaceDetailError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setMarketplaceDetailPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, data.marketplace, marketplaceCatalog, marketplacePluginId]);
  useEffect(() => {
    if (installedPluginId === undefined) {
      setInstalledPluginMetadata(undefined);
      return;
    }
    const known = marketplaceCatalog.find((item) => item.packageName === installedPluginId);
    if (known !== undefined) {
      setInstalledPluginMetadata(known);
      return;
    }
    let cancelled = false;
    setInstalledPluginMetadata(undefined);
    void api
      .listMarketplace("", "", 0, 100)
      .then((result) => {
        if (!cancelled) setInstalledPluginMetadata(result.items.find((item) => item.packageName === installedPluginId));
      })
      .catch(() => {
        if (!cancelled) setInstalledPluginMetadata(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [api, installedPluginId, marketplaceCatalog]);
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      api.getStatus(),
      api.getSession(),
      api.listSessions(sessionPage, 30, includeArchivedSessions),
      api.getFiles(),
      api.listModels(),
      api.listProviders(),
      api.listPlugins(),
      api.listPluginPanels(),
      api.listMarketplace(marketplaceQuery, marketplaceCapability, marketplacePage, 24, marketplaceCategory),
      api.listCommands(),
      api.listWorkspaces(),
    ]);
    const [status, session, sessions, files, models, providers, plugins, pluginPanels, marketplace, commands, workspaces] = results;
    setRefreshIssues(
      failedRefreshLabels(["运行状态", "当前会话", "会话列表", "文件", "模型", "提供商", "插件", "插件面板", "插件市场", "命令", "工作区"], results),
    );
    setInitialRefreshPending(false);
    setData((current) => ({
      status: status.status === "fulfilled" ? status.value : current.status,
      session: session.status === "fulfilled" ? session.value : current.session,
      sessions: sessions.status === "fulfilled" ? sessions.value.items : current.sessions,
      files: files.status === "fulfilled" ? files.value : current.files,
      models: models.status === "fulfilled" ? models.value : current.models,
      providers: providers.status === "fulfilled" ? providers.value : current.providers,
      plugins: plugins.status === "fulfilled" ? plugins.value : current.plugins,
      pluginPanels: pluginPanels.status === "fulfilled" ? pluginPanels.value : current.pluginPanels,
      marketplace: marketplace.status === "fulfilled" ? marketplace.value.items : current.marketplace,
      marketplaceCapabilities: marketplace.status === "fulfilled" ? marketplace.value.capabilities : current.marketplaceCapabilities,
      marketplaceCategories: marketplace.status === "fulfilled" ? marketplace.value.categories : current.marketplaceCategories,
      marketplaceTotal: marketplace.status === "fulfilled" ? marketplace.value.total : current.marketplaceTotal,
      marketplacePage: marketplace.status === "fulfilled" ? marketplace.value.page : current.marketplacePage,
      marketplaceHasNext: marketplace.status === "fulfilled" ? marketplace.value.hasNext : current.marketplaceHasNext,
      commands: commands.status === "fulfilled" ? commands.value : current.commands,
      workspaces: workspaces.status === "fulfilled" ? workspaces.value : current.workspaces,
    }));
    if (sessions.status === "fulfilled") {
      setSessionTotal(sessions.value.total);
      setSessionHasNext(sessions.value.hasNext);
    }
  }, [api, includeArchivedSessions, marketplaceCapability, marketplaceCategory, marketplacePage, marketplaceQuery, sessionPage]);
  const scheduleRefresh = useCallback(() => {
    refreshQueuedRef.current = true;
    if (refreshTimerRef.current !== undefined) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = undefined;
      if (!refreshQueuedRef.current) return;
      refreshQueuedRef.current = false;
      void refresh();
    }, 100);
  }, [refresh]);
  const handleRuntimeEvent = useCallback(
    (payload: Record<string, unknown>) => {
      if (shouldRefreshForRuntimeEvent(payload)) scheduleRefresh();
      const event = payload.event;
      if (typeof event !== "object" || event === null) return;
      const runtimeEvent = event as Record<string, unknown>;
      if (runtimeEvent.type === "turn_start") {
        setStreamingAssistant({ thinking: "", text: "" });
        return;
      }
      if (runtimeEvent.type !== "message_update" || typeof runtimeEvent.assistantMessageEvent !== "object" || runtimeEvent.assistantMessageEvent === null)
        return;
      const assistantMessageEvent = runtimeEvent.assistantMessageEvent as Record<string, unknown>;
      const type = assistantMessageEvent.type;
      if (type !== "thinking_delta" && type !== "text_delta") return;
      const delta = typeof assistantMessageEvent.delta === "string" ? assistantMessageEvent.delta : "";
      if (!delta) return;
      setStreamingAssistant((current) => ({
        thinking: (current?.thinking ?? "") + (type === "thinking_delta" ? delta : ""),
        text: (current?.text ?? "") + (type === "text_delta" ? delta : ""),
      }));
    },
    [scheduleRefresh],
  );
  const handleRuntimeEventRef = useRef(handleRuntimeEvent);
  const refreshRef = useRef(refresh);
  const createNewSession = useCallback(
    async (workspace?: ClientWorkspace) => {
      setPromptError("");
      setWorkspaceError("");
      try {
        const created = await api.createSession(workspace?.path);
        if (created.sessionFile) setSelectedSessionPath(created.sessionFile);
        setSettings(undefined);
        setCommandOpen(false);
        setGlobalSearchOpen(false);
        setDetails(undefined);
        setWorkspaceChooserOpen(false);
        setSelectedWorkspacePath(workspace?.path);
        setCommandQuery("");
        setPage("session");
        setView("chat");
        setSessionMenuOpen(false);
        await refresh();
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (workspace) setWorkspaceError(message);
        else setPromptError(message);
      }
    },
    [api, refresh],
  );
  const beginNewSession = () => {
    setPromptError("");
    setWorkspaceError("");
    setSelectedWorkspacePath(undefined);
    setWorkspaceChooserOpen(true);
  };
  const pickDirectory = useCallback(async () => {
    try {
      const path = await api.pickDirectory();
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      await createNewSession({ path, branch: "directory", current: false, name });
    } catch (cause: unknown) {
      setWorkspaceError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, createNewSession]);
  const openDirectory = useCallback(async () => {
    await pickDirectory();
  }, [pickDirectory]);
  useEffect(() => {
    handleRuntimeEventRef.current = handleRuntimeEvent;
    refreshRef.current = refresh;
  }, [handleRuntimeEvent, refresh]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => subscribeRuntimeEvents(api, handleRuntimeEventRef), [api]);
  useEffect(() => {
    const timer = window.setInterval(() => void refreshRef.current(), 5000);
    return () => {
      window.clearInterval(timer);
      if (refreshTimerRef.current !== undefined) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = undefined;
      }
    };
  }, []);
  useEffect(() => {
    if (data.status?.status !== "running") setStreamingAssistant(undefined);
  }, [data.status?.status]);
  useEffect(() => {
    const path = initialSessionPathRef.current;
    if (!path || sessionRestoreAttemptedRef.current || data.sessions.length === 0) return;
    sessionRestoreAttemptedRef.current = true;
    const target = data.sessions.find((session) => session.path === path);
    if (!target || typeof target.path !== "string") {
      setSelectedSessionPath(undefined);
      return;
    }
    if (data.session?.sessionFile === target.path) return;
    void api
      .openSession(target.path)
      .then(refresh)
      .catch((cause: unknown) => setPromptError(cause instanceof Error ? cause.message : String(cause)));
  }, [api, data.session?.sessionFile, data.sessions, refresh]);
  useEffect(() => {
    setCommandIndex(0);
    if (!commandOpen) return;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [commandOpen, commandQuery]);
  const stopRun = useCallback(() => {
    setPromptError("");
    void api
      .abort()
      .then(refresh)
      .catch((cause: unknown) => setPromptError(cause instanceof Error ? cause.message : String(cause)));
  }, [api, refresh]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldInterruptRun(event, data.status?.status === "running", window.getSelection()?.toString() ?? "")) {
        event.preventDefault();
        stopRun();
        return;
      }
      if (event.key === "Escape") {
        if (sessionDialog) {
          setSessionDialog(undefined);
          return;
        }
        if (globalSearchOpen) {
          setGlobalSearchOpen(false);
          return;
        }
        if (commandOpen) {
          setCommandOpen(false);
          setCommandQuery("");
          return;
        }
        if (details !== undefined) {
          setDetails(undefined);
          return;
        }
        setCommandOpen(false);
        setSessionMenuOpen(false);
        setSessionToolsOpen(false);
        setWorkspaceChooserOpen(false);
        setSettings(undefined);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(false);
        setGlobalSearchOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setCommandOpen(false);
        setGlobalSearchOpen(false);
        setDetails(undefined);
        setSettings("general");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandOpen, data.status?.status, details, globalSearchOpen, sessionDialog, stopRun]);
  const events = data.session?.events ?? [];
  const displayEvents = useMemo(() => compactThinkingEvents(events), [events]);
  const chatTurns = useMemo(() => projectChatTurns(data.session?.messages ?? []), [data.session?.messages]);
  // Every streamed delta has to re-stick, not just the finished turn: without the streaming lengths in here the viewport freezes while the answer keeps growing below the fold and only jumps to the bottom once the turn ends and the message count changes.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const element = chatScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data.session?.messages.length, data.status?.events, streamingAssistant?.text.length, streamingAssistant?.thinking.length, pendingPrompt, promptBusy]);
  const filteredSessions = data.sessions.filter(
    (session) =>
      !search ||
      value(session.name ?? session.firstMessage, "未命名会话")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    const prompt = annotations.length > 0 ? formatAnnotationPrompt(annotations, question) : question;
    if (!prompt || promptBusy) return;
    setDraft("");
    setPromptError("");
    setPendingPrompt(prompt);
    setStreamingAssistant(undefined);
    stickToBottomRef.current = true;
    setPromptBusy(true);
    void api
      .prompt(prompt)
      .then(async () => {
        setAnnotations([]);
        await refresh();
      })
      .catch((cause: unknown) => setPromptError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPendingPrompt(""))
      .finally(() => setPromptBusy(false));
  };
  const captureAnnotationSelection = useCallback(() => {
    window.requestAnimationFrame(() => {
      const selected = window.getSelection()?.toString().trim() ?? "";
      if (selected.length > 0) setAnnotationSelection(selected.slice(0, 4_000));
    });
  }, []);
  const addAnnotation = () => {
    const quote = annotationSelection.trim();
    if (!quote) return;
    setAnnotations((current) => [
      ...current,
      { id: current.length === 0 ? 1 : Math.max(...current.map((item) => item.id)) + 1, quote, note: annotationNote.trim() },
    ]);
    setAnnotationSelection("");
    setAnnotationNote("");
  };
  const openCommandCompletion = () => {
    const input = promptInputRef.current;
    const caret = input?.selectionStart ?? draft.length;
    const existing = getPromptCompletion(draft, caret);
    let nextCaret = caret;
    if (existing?.kind !== "command") {
      const separator = caret > 0 && !/\s/.test(draft[caret - 1] ?? "") ? " " : "";
      const insertion = `${separator}/`;
      const nextDraft = `${draft.slice(0, caret)}${insertion}${draft.slice(caret)}`;
      nextCaret = caret + insertion.length;
      setDraft(nextDraft);
    }
    setPromptCaret(nextCaret);
    setPromptCompletionSuppressed(false);
    setPromptCompletionIndex(0);
    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(nextCaret, nextCaret);
    });
  };
  const applyStarter = (value: string) => {
    setDraft(value);
    setPromptCaret(value.length);
    setPromptCompletionSuppressed(false);
    // A starter card is the largest target on the empty screen, but seeding the draft is all it does: without moving the caret into the composer the click only prints text several hundred pixels further down, which reads as nothing having happened.
    window.requestAnimationFrame(() => {
      const input = promptInputRef.current;
      input?.focus();
      input?.setSelectionRange(value.length, value.length);
    });
  };
  const openSession = (session: Record<string, unknown>) => {
    const path = typeof session.path === "string" ? session.path : "";
    if (!path) return;
    setSettings(undefined);
    setCommandOpen(false);
    setGlobalSearchOpen(false);
    setPage("session");
    setView("chat");
    setDetails(undefined);
    setSelectedSessionPath(path);
    void api
      .openSession(path)
      .then(refresh)
      .catch((cause: unknown) => setPromptError(cause instanceof Error ? cause.message : String(cause)));
  };
  const sessionAction = async (action: () => Promise<void>) => {
    if (sessionActionBusy) return;
    setSessionActionBusy(true);
    setPromptError("");
    try {
      await action();
      await refresh();
      setSelectedSessionPaths(new Set());
      setSessionMenuOpen(false);
      setSessionMenuPath(undefined);
      setSessionMenuPosition(undefined);
      setSessionToolsOpen(false);
      setSessionToolsPosition(undefined);
      setSessionActionTarget(undefined);
      setSessionSelectionMode(false);
      setSessionDialog(undefined);
    } catch (cause: unknown) {
      setPromptError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSessionActionBusy(false);
    }
  };
  const activeSessionPath = data.session?.sessionFile;
  const toggleSessionSelection = (path: string) => {
    setSelectedSessionPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const openSessionMenu = (path: string, name: string | undefined, trigger: HTMLButtonElement) => {
    if (sessionMenuOpen && sessionMenuPath === path) {
      closeSessionMenu();
      setSessionActionTarget(undefined);
      return;
    }
    setSessionToolsOpen(false);
    setSessionToolsPosition(undefined);
    sessionPopoverTriggerRef.current = trigger;
    setSessionNameDraft(name ?? "");
    setSessionActionTarget({ name: name || "未命名会话", path });
    setSessionMenuPath(path);
    setSessionMenuPosition(sidebarPopoverPosition(trigger, 142, 190, "beside"));
    setSessionMenuOpen(true);
  };
  const closeSessionMenu = () => {
    setSessionMenuOpen(false);
    setSessionMenuPath(undefined);
    setSessionMenuPosition(undefined);
  };
  const pushInstalledPluginRoute = (pluginId: string | undefined) => {
    const params = new URLSearchParams(window.location.search);
    params.set("page", "plugins");
    params.delete("settings");
    if (pluginId) params.set("plugin", pluginId);
    else params.delete("plugin");
    const query = params.toString();
    window.history.pushState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    setSettings(undefined);
    setDetails(undefined);
    setCommandOpen(false);
    setGlobalSearchOpen(false);
    setSessionMenuOpen(false);
    setSessionMenuPath(undefined);
    setPage("plugins");
    setInstalledPluginId(pluginId);
    setMarketplacePluginId(undefined);
  };
  const pushMarketplacePluginRoute = (pluginId: string | undefined) => {
    const params = new URLSearchParams(window.location.search);
    params.set("page", "marketplace");
    params.delete("settings");
    if (pluginId) params.set("plugin", pluginId);
    else params.delete("plugin");
    const query = params.toString();
    window.history.pushState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    setSettings(undefined);
    setDetails(undefined);
    setCommandOpen(false);
    setGlobalSearchOpen(false);
    setSessionMenuOpen(false);
    setSessionMenuPath(undefined);
    setPage("marketplace");
    setInstalledPluginId(undefined);
    setMarketplacePluginId(pluginId);
  };
  const installedPlugin = installedPluginId === undefined ? undefined : data.plugins.find((plugin) => plugin.name === installedPluginId);
  const installedPluginPanel = installedPluginId === undefined ? undefined : data.pluginPanels.find((panel) => panel.pluginId === installedPluginId);
  const content = settings ? (
    <Settings
      api={api}
      data={data}
      tab={settings}
      onTab={setSettings}
      onRefresh={refresh}
      onClose={() => {
        setSettings(undefined);
        setPage("session");
        setView("chat");
        setDetails(undefined);
      }}
    />
  ) : page === "plugins" && installedPluginId && installedPlugin ? (
    <InstalledPluginDetail
      metadata={installedPluginMetadata}
      capabilityLabel={capabilityLabel}
      onBack={() => pushInstalledPluginRoute(undefined)}
      onToggle={async (plugin) => {
        const result = await api.togglePlugin(plugin.id, !plugin.enabled);
        await refresh();
        return result;
      }}
      onUninstall={async (plugin) => {
        await api.uninstallPlugin(plugin.id);
        const plugins = await api.listPlugins();
        setData((current) => ({ ...current, plugins: plugins.filter((item) => item.id !== plugin.id) }));
        pushInstalledPluginRoute(undefined);
      }}
      panel={installedPluginPanel}
      plugin={installedPlugin}
    />
  ) : page === "plugins" && installedPluginId ? (
    <section className="view-panel min-w-0 overflow-auto bg-[#f8f9fb]">
      <div className="subnav plugin-detail-subnav bg-white">
        <a
          href="?page=plugins"
          onClick={(event) => {
            event.preventDefault();
            pushInstalledPluginRoute(undefined);
          }}
        >
          ← 已安装插件
        </a>
        <span>插件详情</span>
      </div>
      <div className="empty-state">{data.status ? "没有找到这个已安装插件，它可能已被移除。" : "正在读取插件详情…"}</div>
    </section>
  ) : page === "plugins" ? (
    <Plugins
      capabilityLabel={capabilityLabel}
      plugins={data.plugins}
      panels={data.pluginPanels}
      catalog={marketplaceCatalog.length ? marketplaceCatalog : data.marketplace}
      onMarketplace={() => pushMarketplacePluginRoute(undefined)}
      onOpenDetail={(plugin) => pushInstalledPluginRoute(plugin.name)}
      onToml={() => {
        setDetails(undefined);
        setSettings("toml");
      }}
      onToggle={async (plugin) => {
        const result = await api.togglePlugin(plugin.id, !plugin.enabled);
        await refresh();
        return result;
      }}
      onUninstall={async (plugin) => {
        await api.uninstallPlugin(plugin.id);
        const plugins = await api.listPlugins();
        setData((current) => ({ ...current, plugins: plugins.filter((item) => item.id !== plugin.id) }));
      }}
    />
  ) : page === "marketplace" ? (
    marketplacePluginId && marketplaceDetail?.id === marketplacePluginId ? (
      <MarketplaceDetail
        plugin={marketplaceDetail}
        capabilityLabel={capabilityLabel}
        installed={installedPackages.has(marketplaceDetail.packageName)}
        restartPending={restartPendingPackages.has(marketplaceDetail.packageName)}
        onBack={() => pushMarketplacePluginRoute(undefined)}
        onInstall={async (plugin) => {
          const result = await api.installMarketplace(plugin.id);
          await refresh();
          if (result.restartRequired === true) markRestartPending(plugin.packageName);
          return result;
        }}
      />
    ) : marketplacePluginId ? (
      <section className="marketplace-page flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="subnav plugin-detail-subnav">
            <a
              href="?page=marketplace"
              onClick={(event) => {
                event.preventDefault();
                pushMarketplacePluginRoute(undefined);
              }}
            >
              ← 插件市场
            </a>
            <span>插件详情</span>
          </div>
          <div className="empty-state">{marketplaceDetailPending ? "正在读取插件详情…" : marketplaceDetailError || "没有找到这个市场插件，它可能已下架。"}</div>
        </div>
      </section>
    ) : (
      <Marketplace
        plugins={data.marketplace}
        capabilities={data.marketplaceCapabilities}
        capabilityLabel={capabilityLabel}
        categories={data.marketplaceCategories}
        total={data.marketplaceTotal}
        page={data.marketplacePage}
        hasNext={data.marketplaceHasNext}
        query={marketplaceQuery}
        capabilityFilter={marketplaceCapability}
        categoryFilter={marketplaceCategory}
        onQueryChange={(value) => {
          setMarketplaceQuery(value);
          setMarketplacePage(0);
        }}
        onCapabilityChange={(value) => {
          setMarketplaceCapability(value);
          setMarketplacePage(0);
        }}
        onCategoryChange={(value) => {
          setMarketplaceCategory(value);
          setMarketplacePage(0);
        }}
        onOpenDetail={(plugin) => pushMarketplacePluginRoute(plugin.id)}
        onPageChange={setMarketplacePage}
        onBack={() => pushInstalledPluginRoute(undefined)}
        onToml={() => {
          setDetails(undefined);
          setSettings("toml");
        }}
        installedPackages={installedPackages}
        restartPendingPackages={restartPendingPackages}
        onInstall={async (plugin) => {
          const result = await api.installMarketplace(plugin.id);
          await refresh();
          if (result.restartRequired === true) markRestartPending(plugin.packageName);
          return result;
        }}
      />
    )
  ) : view === "chat" ? (
    <section className="view-panel chat-view">
      <div
        className={`chat-scroll ${data.session?.messages.length ? "" : "is-empty"}`}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        }}
        ref={chatScrollRef}
      >
        {data.session?.messages.length ? (
          chatTurns.map((turn, index) => (
            <ChatTurnArticle
              key={index}
              onMouseUp={captureAnnotationSelection}
              role={turn.role}
              stopped={turn.stopped}
              text={turn.text}
              thinking={turn.thinking}
              tools={turn.tools}
            />
          ))
        ) : (
          <Workspace
            status={data.status}
            workspaces={data.workspaces}
            onCreate={(workspace) => void createNewSession(workspace)}
            onStarter={applyStarter}
            onToml={() => {
              setDetails(undefined);
              setSettings("toml");
            }}
          />
        )}
        {streamingAssistant && data.status?.status === "running" && (
          <article className="turn text streaming-turn" aria-live="polite">
            {streamingAssistant.thinking && (
              <details className="reasoning message-reasoning">
                <summary className="reasoning-head">思考中…</summary>
                <div className="reasoning-body">
                  <MarkdownMessage text={streamingAssistant.thinking} />
                </div>
              </details>
            )}
            {!streamingAssistant.thinking && !streamingAssistant.text && <div className="streaming-placeholder">正在生成…</div>}
            {streamingAssistant.text && <MarkdownMessage onMouseUp={captureAnnotationSelection} text={streamingAssistant.text} />}
          </article>
        )}
        {pendingPrompt && !data.session?.messages.some((message) => message.role === "user" && messageText(message) === pendingPrompt) && (
          <article className="turn user pending-turn">
            <UserMessageBubble text={pendingPrompt} />
          </article>
        )}
      </div>
      <div className="composer-wrap">
        <div className="context-shell">
          <div className="context-line">
            <span className="context-label">实时上下文</span>
            <div className="context-metrics">
              <span>
                <b>{data.status?.messages ?? 0}</b> 条消息
              </span>
              <span>
                <b>{data.status?.events ?? events.length}</b> 个事件
              </span>
              <span>
                <b>{value(data.status?.model)}</b>
              </span>
            </div>
          </div>
        </div>
        <div className="composer-stack">
          {promptError && <PromptError message={promptError} />}
          {annotationSelection ? (
            <div aria-label="添加批注" className="rounded-lg border border-[#cdddf8] bg-[#f6f8ff] px-3 py-2">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-[#dce9ff] px-1.5 py-0.5 text-[10px] text-[#315fb8]">选中片段</span>
                <p className="max-h-16 flex-1 overflow-auto whitespace-pre-wrap text-[11px] text-[#30343b]">{annotationSelection}</p>
                <button aria-label="取消批注" className="text-[12px] text-[#687381]" onClick={() => setAnnotationSelection("")} type="button">
                  ×
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  aria-label="批注备注"
                  className="min-w-0 flex-1 rounded-md border border-[#dce5f5] bg-white px-2 py-1.5 text-[11px] outline-none"
                  onChange={(event) => setAnnotationNote(event.target.value)}
                  placeholder="备注（可选）"
                  value={annotationNote}
                />
                <button className="rounded-md bg-[#3565c5] px-3 py-1.5 text-[11px] font-medium text-white" onClick={addAnnotation} type="button">
                  加入批注
                </button>
              </div>
            </div>
          ) : null}
          {annotations.length > 0 ? (
            <div className="flex items-center gap-2 overflow-x-auto text-[10px]">
              <span className="shrink-0 rounded-md bg-[#edf3fe] px-2 py-1 font-medium text-[#315fb8]">批注 ×{annotations.length}</span>
              {annotations.map((annotation) => (
                <button
                  className="max-w-48 shrink-0 truncate rounded-md border border-[#dce5f5] bg-white px-2 py-1 text-left text-[#65707b]"
                  key={annotation.id}
                  onClick={() => setAnnotations((current) => current.filter((item) => item.id !== annotation.id))}
                  title="点击移除批注"
                  type="button"
                >
                  #{annotation.id} {annotation.quote}
                </button>
              ))}
              <button className="shrink-0 text-[#687381]" onClick={() => setAnnotations([])} type="button">
                清空
              </button>
            </div>
          ) : null}
          <form className="composer" onSubmit={submit}>
            <textarea
              aria-activedescendant={promptCompletionOpen ? `prompt-completion-option-${promptCompletionActiveIndex}` : undefined}
              aria-autocomplete="list"
              aria-controls={promptCompletionOpen ? "prompt-completion-list" : undefined}
              aria-expanded={promptCompletionOpen}
              aria-haspopup="listbox"
              aria-label="Prompt"
              onChange={(event) => {
                setDraft(event.target.value);
                setPromptCaret(event.currentTarget.selectionStart ?? event.target.value.length);
                setPromptCompletionSuppressed(false);
                event.currentTarget.style.height = "auto";
                event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`;
              }}
              onKeyDown={(event) => {
                const caret = event.currentTarget.selectionStart ?? draft.length;
                const completion = getPromptCompletion(event.currentTarget.value, caret);
                const items = completion
                  ? completion.kind === "command"
                    ? filterCommands(data.commands, completion.query).slice(0, 12)
                    : data.files
                        .filter((file) => `${file.path} ${file.label} ${file.status}`.toLowerCase().includes(completion.query.trim().toLowerCase()))
                        .slice(0, 12)
                  : [];
                const popupOpen = Boolean(completion && !promptCompletionSuppressed && items.length);
                if (popupOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                  event.preventDefault();
                  setPromptCompletionIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
                  return;
                }
                if (popupOpen && (event.key === "Enter" || event.key === "Tab")) {
                  event.preventDefault();
                  const item = items[Math.min(promptCompletionIndex, items.length - 1)];
                  if (item && completion) {
                    const value = completion.kind === "command" ? `/${(item as ClientCommand).invocationName}` : `@${(item as ClientFile).path}`;
                    const replacement = replacePromptCompletion(event.currentTarget.value, completion, `${value} `);
                    setDraft(replacement.text);
                    setPromptCaret(replacement.caret);
                    setPromptCompletionSuppressed(false);
                    requestAnimationFrame(() => {
                      const input = promptInputRef.current;
                      input?.focus();
                      input?.setSelectionRange(replacement.caret, replacement.caret);
                    });
                  }
                  return;
                }
                if (event.key === "Escape" && completion && !promptCompletionSuppressed) {
                  event.preventDefault();
                  setPromptCompletionSuppressed(true);
                  return;
                }
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onClick={() => {
                if (!workspaceReady) setWorkspaceChooserOpen(true);
              }}
              onFocus={(event) => {
                if (!workspaceReady) {
                  event.currentTarget.blur();
                  setWorkspaceChooserOpen(true);
                }
              }}
              placeholder={
                workspaceReady ? `描述要做的改动，⌘↵ 发送；@ 引用文件${data.commands.length ? "，/ 调用命令" : ""}` : "先选择工作区，再描述要做的改动"
              }
              readOnly={!workspaceReady}
              ref={promptInputRef}
              rows={2}
              data-prompt-completion
              value={draft}
            ></textarea>
            {promptCompletionOpen && promptCompletion && (
              <PromptCompletionPopover
                activeIndex={promptCompletionActiveIndex}
                commands={data.commands}
                files={data.files}
                kind={promptCompletion.kind}
                onActiveIndexChange={setPromptCompletionIndex}
                onUse={(value) => {
                  const replacement = replacePromptCompletion(draft, promptCompletion, `${value} `);
                  setDraft(replacement.text);
                  setPromptCaret(replacement.caret);
                  setPromptCompletionSuppressed(false);
                  requestAnimationFrame(() => {
                    const input = promptInputRef.current;
                    input?.focus();
                    input?.setSelectionRange(replacement.caret, replacement.caret);
                  });
                }}
                query={promptCompletion.query}
              />
            )}
            <div className="composer-tools">
              <select
                aria-label="模型"
                disabled={!data.models.length || promptBusy}
                value={data.status?.model ?? ""}
                onChange={(event) => {
                  const [provider, ...modelParts] = event.target.value.split("/");
                  const model = modelParts.join("/");
                  if (!provider || !model) return;
                  setPromptError("");
                  void api
                    .selectModel(provider, model)
                    .then(refresh)
                    .catch((cause: unknown) => setPromptError(cause instanceof Error ? cause.message : String(cause)));
                }}
              >
                {data.models.length ? (
                  data.models.map((model) => (
                    <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                      {model.name === model.id ? `${model.provider}/${model.id}` : `${model.name} (${model.provider})`}
                    </option>
                  ))
                ) : (
                  <option value="">暂无可用模型</option>
                )}
              </select>
              {/* The title rides on the wrapper because a disabled button never shows one, and the empty runtime is exactly when the explanation is needed. */}
              <span className="tool-chip-hint" title={data.commands.length ? "插入斜杠并列出命令" : "当前运行时还没有注册任何命令"}>
                <button className="tool-chip" disabled={!data.commands.length} onClick={openCommandCompletion} type="button">
                  ／ 命令
                </button>
              </span>
              <span className="composer-hint">⌘↵ 发送 · ⌘K 命令 · ⌃C 中断</span>
              <button
                aria-label={promptBusy ? "发送中" : "发送消息"}
                className="send-button"
                disabled={promptBusy || !draft.trim()}
                title={promptBusy ? "正在发送" : "发送消息（⌘↵）"}
                type="submit"
              >
                {promptBusy ? "…" : "↑"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  ) : view === "trajectory" ? (
    <Trajectory events={displayEvents} onSelect={setDetails} sessionMessages={data.status?.messages ?? 0} />
  ) : (
    <Files
      api={api}
      files={data.files}
      onDiff={async (file) => {
        const diff = await api.getFileDiff(file);
        setDetails({
          type: "file_diff",
          path: diff.path,
          output: diff.diff || "没有可显示的差异（工作区可能已更新）。",
        });
      }}
      onRefresh={() => void refresh()}
    />
  );
  const groups = sessionGroups(filteredSessions);
  const showCurrentSession = Boolean(data.session && !search && !filteredSessions.some((session) => session.sessionId === data.session?.sessionId));
  const visibleCommands = filterCommands(data.commands, commandQuery);
  const betterSidebarPanel = data.pluginPanels.find((panel) => panel.id === "better-sidebar-panel");
  const betterSidebarData =
    betterSidebarPanel?.data !== null && typeof betterSidebarPanel?.data === "object" && !Array.isArray(betterSidebarPanel?.data)
      ? (betterSidebarPanel.data as Record<string, unknown>)
      : undefined;
  const themeStudioPanel = data.pluginPanels.find((panel) => panel.id === "theme-studio-panel");
  const themeStudioData =
    themeStudioPanel?.data !== null && typeof themeStudioPanel?.data === "object" && !Array.isArray(themeStudioPanel?.data)
      ? (themeStudioPanel.data as Record<string, unknown>)
      : undefined;
  const themeStyle = useMemo(() => {
    if (!themeStudioData?.tokens || typeof themeStudioData.tokens !== "object" || Array.isArray(themeStudioData.tokens)) return undefined;
    const tokens = Object.entries(themeStudioData.tokens as Record<string, unknown>).filter(
      ([key, token]) => key.startsWith("--") && typeof token === "string",
    );
    return tokens.length ? Object.fromEntries(tokens) : undefined;
  }, [themeStudioData]);
  const activeTheme = typeof themeStudioData?.theme === "string" ? themeStudioData.theme : undefined;
  const insertCommand = useCallback(
    (value: string) => {
      const input = promptInputRef.current;
      // selectionStart is read off the field instead of the promptCaret state because the state goes stale as soon as the caret is moved with the mouse, while the field keeps reporting its caret after a dialog blurs it.
      const replacement = insertCommandDraft(draft, input?.selectionStart ?? draft.length, value);
      setDraft(replacement.text);
      setPromptCaret(replacement.caret);
      setPromptCompletionSuppressed(false);
      setCommandOpen(false);
      setCommandQuery("");
      // useModalFocus returns focus to whatever was focused before the dialog opened, and it does that in its own animation frame during unmount, so the composer takes focus back one frame later instead of being overwritten.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const target = promptInputRef.current;
          target?.focus();
          target?.setSelectionRange(replacement.caret, replacement.caret);
        }),
      );
    },
    [draft],
  );
  return (
    <div className="app-frame" data-theme={activeTheme} style={themeStyle}>
      <aside className="sidebar">
        <header className="brand-row">
          <span className="pi-mark" aria-hidden="true">
            <img src="/icons/svg/mark-white.svg" alt="" />
          </span>
          <strong>pi harness</strong>
          {appVersion ? <span className="version">{appVersion}</span> : null}
        </header>
        <div className="sidebar-actions">
          <button className="new-session" onClick={beginNewSession} type="button" aria-expanded={workspaceChooserOpen}>
            ＋ 新建会话
          </button>
          <div className="session-search" data-command-palette>
            <input
              aria-controls={commandOpen ? "command-menu" : undefined}
              aria-expanded={commandOpen}
              aria-label={commandOpen ? "搜索命令" : "搜索会话"}
              onChange={(event) => {
                const next = event.target.value;
                if (!commandOpen && next.startsWith("/")) {
                  setCommandOpen(true);
                  setCommandQuery(next.slice(1));
                  return;
                }
                if (commandOpen) setCommandQuery(next.replace(/^\/\s?/, ""));
                else setSearch(next);
              }}
              onKeyDown={(event) => {
                if (!commandOpen) return;
                if (event.key === "ArrowDown" && visibleCommands.length) {
                  event.preventDefault();
                  setCommandIndex((index) => (index + 1) % visibleCommands.length);
                } else if (event.key === "ArrowUp" && visibleCommands.length) {
                  event.preventDefault();
                  setCommandIndex((index) => (index - 1 + visibleCommands.length) % visibleCommands.length);
                } else if (event.key === "Enter" && visibleCommands.length) {
                  event.preventDefault();
                  insertCommand(`/${visibleCommands[commandIndex]?.invocationName ?? ""}`);
                }
              }}
              placeholder={commandOpen ? "输入命令名称或描述" : "搜索会话 · ⌘K 命令"}
              ref={searchInputRef}
              type="search"
              value={commandOpen ? `/${commandQuery}` : search}
            />
            {commandOpen && (
              <CommandPalette
                activeIndex={commandIndex}
                commands={data.commands}
                onActiveIndexChange={setCommandIndex}
                onUse={insertCommand}
                query={commandQuery}
              />
            )}
          </div>
          <input
            accept=".jsonl,application/json,application/x-ndjson"
            aria-label="导入会话文件"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              void sessionAction(async () => {
                const imported = await api.importSession(await file.text(), file.name);
                if (imported.sessionFile) setSelectedSessionPath(imported.sessionFile);
              });
            }}
            ref={importInputRef}
            type="file"
          />
        </div>
        <div className="session-list-toolbar">
          <div className="session-list-title">
            <strong>会话</strong>
            <span>{sessionTotal || data.sessions.length}</span>
          </div>
          <div className="session-list-tools">
            <button
              aria-pressed={sessionSelectionMode}
              className={`session-tool-button ${sessionSelectionMode ? "active" : ""}`}
              onClick={() => {
                setSessionSelectionMode(!sessionSelectionMode);
                setSelectedSessionPaths(new Set());
                setSessionToolsOpen(false);
                closeSessionMenu();
              }}
              type="button"
            >
              {sessionSelectionMode ? "完成" : "选择"}
            </button>
            <div className="session-tools-wrap" data-session-popover>
              <button
                aria-expanded={sessionToolsOpen}
                aria-haspopup="menu"
                aria-label="会话工具"
                className="session-tool-button icon"
                onClick={(event) => {
                  closeSessionMenu();
                  sessionPopoverTriggerRef.current = event.currentTarget;
                  setSessionActionTarget(undefined);
                  if (sessionToolsOpen) {
                    setSessionToolsOpen(false);
                    setSessionToolsPosition(undefined);
                  } else {
                    setSessionToolsPosition(sidebarPopoverPosition(event.currentTarget, 150, 190, "below"));
                    setSessionToolsOpen(true);
                  }
                }}
                type="button"
              >
                ⋯
              </button>
              {sessionToolsOpen &&
                sessionToolsPosition &&
                createPortal(
                  <div className="session-tools-popover" data-session-popover role="menu" style={sessionToolsPosition}>
                    <button autoFocus onClick={() => window.location.reload()} role="menuitem" type="button">
                      刷新列表
                    </button>
                    <button
                      onClick={() => {
                        setSessionToolsOpen(false);
                        setSessionToolsPosition(undefined);
                        importInputRef.current?.click();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      导入会话
                    </button>
                    <button
                      disabled={!activeSessionPath || sessionActionBusy}
                      onClick={() => {
                        if (!activeSessionPath) return;
                        void sessionAction(async () => {
                          const blob = await api.exportSession(activeSessionPath);
                          const link = document.createElement("a");
                          link.href = URL.createObjectURL(blob);
                          link.download = `${data.session?.sessionId ?? "session"}.jsonl`;
                          link.click();
                          URL.revokeObjectURL(link.href);
                        });
                      }}
                      role="menuitem"
                      type="button"
                    >
                      导出当前会话
                    </button>
                    <button
                      onClick={() => {
                        setIncludeArchivedSessions((current) => !current);
                        setSessionToolsOpen(false);
                        setSessionToolsPosition(undefined);
                        void refresh();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      {includeArchivedSessions ? "隐藏归档会话" : "显示归档会话"}
                    </button>
                  </div>,
                  document.body,
                )}
            </div>
          </div>
        </div>
        {sessionSelectionMode && selectedSessionPaths.size > 0 && (
          <div className="session-batch-bar">
            <span>{selectedSessionPaths.size} 个已选择</span>
            <button onClick={() => void sessionAction(() => api.batchSessions("archive", [...selectedSessionPaths]).then(() => undefined))} type="button">
              归档
            </button>
            <button onClick={() => void sessionAction(() => api.batchSessions("pin", [...selectedSessionPaths]).then(() => undefined))} type="button">
              置顶
            </button>
            <button
              className="danger"
              onClick={() => {
                setSessionActionTarget(undefined);
                setSessionDialog("batch-delete");
              }}
              type="button"
            >
              删除
            </button>
          </div>
        )}
        <div className="sidebar-scroll">
          {showCurrentSession && data.session && (
            <div className="session-group">
              <div className="group-label">当前</div>
              <div className="session-row-wrap current-session-row">
                {sessionSelectionMode && (
                  <input
                    aria-label="选择当前会话"
                    checked={activeSessionPath ? selectedSessionPaths.has(activeSessionPath) : false}
                    onChange={() => activeSessionPath && toggleSessionSelection(activeSessionPath)}
                    type="checkbox"
                  />
                )}
                <button
                  className="session-row active"
                  onClick={() => {
                    setSettings(undefined);
                    setCommandOpen(false);
                    setGlobalSearchOpen(false);
                    setPage("session");
                    setView("chat");
                    setDetails(undefined);
                    setSessionMenuOpen(false);
                    void refresh();
                  }}
                  type="button"
                >
                  <span className="session-dot ok"></span>
                  <span className="session-copy">
                    <strong>{data.session.messages.length ? data.session.sessionId.slice(0, 12) : "新会话"}</strong>
                    <small>{data.session.messages.length} 条消息</small>
                  </span>
                </button>
                {!sessionSelectionMode && activeSessionPath && (
                  <button
                    aria-expanded={sessionMenuOpen && sessionMenuPath === activeSessionPath}
                    aria-haspopup="menu"
                    aria-label="当前会话操作"
                    className="session-row-more"
                    data-session-popover
                    onClick={(event) =>
                      openSessionMenu(activeSessionPath, data.session?.messages.length ? data.session?.sessionId.slice(0, 12) : "新会话", event.currentTarget)
                    }
                    type="button"
                  >
                    ⋯
                  </button>
                )}
                {!sessionSelectionMode && activeSessionPath && sessionMenuPath === activeSessionPath && sessionMenuOpen && sessionMenuPosition && (
                  <SessionActionMenu
                    busy={sessionActionBusy}
                    position={sessionMenuPosition}
                    onArchive={() => {
                      closeSessionMenu();
                      setSessionDialog("archive");
                    }}
                    onDelete={() => {
                      closeSessionMenu();
                      setSessionDialog("delete");
                    }}
                    onFork={() =>
                      void sessionAction(async () => {
                        const result = await api.forkSession(activeSessionPath);
                        if (result.sessionFile) {
                          setSelectedSessionPath(result.sessionFile);
                          await api.openSession(result.sessionFile);
                        }
                      })
                    }
                    onRename={() => {
                      closeSessionMenu();
                      setSessionDialog("rename");
                    }}
                  />
                )}
              </div>
            </div>
          )}
          {groups.length ? (
            groups.map(([label, sessions]) => (
              <div className="session-group" key={label}>
                <div className="group-label">{label}</div>
                {sessions.map((session, index) => (
                  <div className="session-row-wrap" key={index}>
                    {sessionSelectionMode && (
                      <input
                        aria-label={`选择会话 ${value(session.name ?? session.firstMessage, "未命名会话")}`}
                        checked={typeof session.path === "string" && selectedSessionPaths.has(session.path)}
                        onChange={() => {
                          if (typeof session.path === "string") toggleSessionSelection(session.path);
                        }}
                        type="checkbox"
                      />
                    )}
                    <button
                      className={`session-row ${session.sessionId === data.session?.sessionId ? "active" : ""}`}
                      onClick={() => openSession(session)}
                      type="button"
                    >
                      <span className="session-dot ok"></span>
                      <span className="session-copy">
                        <strong>{value(session.name ?? session.firstMessage, "未命名会话")}</strong>
                        <small>
                          {value(session.messageCount, "0")} 条消息{session.pinned === true ? " · 已置顶" : ""}
                          {session.archived === true ? " · 已归档" : ""}
                        </small>
                      </span>
                    </button>
                    {!sessionSelectionMode && typeof session.path === "string" && (
                      <button
                        aria-expanded={sessionMenuOpen && sessionMenuPath === session.path}
                        aria-haspopup="menu"
                        aria-label={`会话操作 ${value(session.name ?? session.firstMessage, "未命名会话")}`}
                        className="session-row-more"
                        data-session-popover
                        onClick={(event) => {
                          event.stopPropagation();
                          openSessionMenu(session.path as string, value(session.name ?? session.firstMessage, ""), event.currentTarget);
                        }}
                        type="button"
                      >
                        ⋯
                      </button>
                    )}
                    {!sessionSelectionMode &&
                      typeof session.path === "string" &&
                      sessionMenuPath === session.path &&
                      sessionMenuOpen &&
                      sessionMenuPosition && (
                        <SessionActionMenu
                          busy={sessionActionBusy}
                          position={sessionMenuPosition}
                          onArchive={() => {
                            closeSessionMenu();
                            setSessionDialog("archive");
                          }}
                          onDelete={() => {
                            closeSessionMenu();
                            setSessionDialog("delete");
                          }}
                          onFork={() =>
                            void sessionAction(async () => {
                              const result = await api.forkSession(session.path as string);
                              if (result.sessionFile) {
                                setSelectedSessionPath(result.sessionFile);
                                await api.openSession(result.sessionFile);
                              }
                            })
                          }
                          onRename={() => {
                            closeSessionMenu();
                            setSessionDialog("rename");
                          }}
                        />
                      )}
                  </div>
                ))}
              </div>
            ))
          ) : !showCurrentSession ? (
            <div className="empty-state">暂无已保存会话</div>
          ) : null}
          {sessionTotal > 30 && (
            <div className="session-pagination">
              <button disabled={sessionPage === 0} onClick={() => setSessionPage((page) => Math.max(0, page - 1))} type="button">
                上一页
              </button>
              <span>
                {sessionPage + 1} / {Math.max(1, Math.ceil(sessionTotal / 30))}
              </span>
              <button disabled={!sessionHasNext} onClick={() => setSessionPage((page) => page + 1)} type="button">
                下一页
              </button>
            </div>
          )}
          {betterSidebarData && (
            <section aria-label="工作区概览" className="mx-3 mt-3 rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-[11px] font-semibold text-[#253044]">工作区概览</strong>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${betterSidebarData.clean === true ? "bg-[#eaf8f0] text-[#14733f]" : "bg-[#fff0f0] text-[#b42318]"}`}
                >
                  {betterSidebarData.clean === true ? "clean" : `${value(betterSidebarData.changedCount ?? 0)} 变更`}
                </span>
              </div>
              <code className="mt-2 block truncate text-[10px] text-[#315fb8]">{value(betterSidebarData.cwd ?? "当前工作区")}</code>
              <p className="mt-1 truncate font-mono text-[10px] text-[#65707b]">{value(betterSidebarData.branch ?? "非 Git 工作区")}</p>
              {Array.isArray(betterSidebarData.changedFiles) && betterSidebarData.changedFiles.length > 0 ? (
                <div className="mt-2 grid gap-1 border-t border-[#dce5f5] pt-2">
                  {betterSidebarData.changedFiles.slice(0, 3).map((item, index) => {
                    const file = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                    return (
                      <code className="truncate text-[9px] text-[#65707b]" key={`${value(file.path ?? "file")}-${index}`}>
                        {value(file.status ?? "??")} {value(file.path ?? "未命名")}
                      </code>
                    );
                  })}
                </div>
              ) : null}
            </section>
          )}
        </div>
        <footer className="sidebar-footer">
          <div className="runtime-cells">
            <span>
              model <b>{value(data.status?.model)}</b>
            </span>
            <span>
              msgs <b>{data.status?.messages ?? 0}</b>
            </span>
            <span>
              status <b>{value(data.status?.status, "connecting")}</b>
            </span>
          </div>
          <button
            aria-label="搜索会话、文件和命令"
            className="sidebar-link compact-session-search"
            onClick={() => {
              setCommandOpen(false);
              setSessionToolsOpen(false);
              closeSessionMenu();
              setGlobalSearchOpen(true);
            }}
            title="搜索会话、文件和命令"
            type="button"
          >
            ⌕
          </button>
          <button aria-label="新建会话" className="sidebar-link compact-new-session" onClick={beginNewSession} title="新建会话" type="button">
            ＋
          </button>
          <button
            aria-label={`插件，已安装 ${installedPluginCount} 个`}
            className={`sidebar-link ${page === "plugins" || page === "marketplace" ? "active" : ""}`}
            onClick={() => pushInstalledPluginRoute(undefined)}
            title={`插件 · ${installedPluginCount} 个`}
            type="button"
          >
            ◈ <span>插件</span>
            <b>{installedPluginCount}</b>
          </button>
          <button
            aria-label="设置"
            className={`sidebar-link ${settings ? "active" : ""}`}
            onClick={() => {
              setCommandOpen(false);
              setGlobalSearchOpen(false);
              setSessionMenuOpen(false);
              setSessionMenuPath(undefined);
              setDetails(undefined);
              setSettings("general");
            }}
            title="设置"
            type="button"
          >
            ⚙ <span>设置</span>
          </button>
        </footer>
      </aside>
      <section className="main-pane">
        <header className={`main-header ${!settings && page === "session" ? "session-track" : ""}`}>
          <div className="active-heading">
            <strong>
              {settings
                ? "设置"
                : page === "plugins" || page === "marketplace"
                  ? installedPluginId || marketplacePluginId
                    ? "插件详情"
                    : "插件"
                  : data.session?.messages.length
                    ? data.session.sessionId.slice(0, 12)
                    : "新会话"}
            </strong>
            <small>
              {settings
                ? "运行时状态与配置"
                : page === "plugins"
                  ? installedPluginId
                    ? (installedPluginMetadata?.name ?? displayPluginName(installedPluginId))
                    : "安装、启用与卸载"
                  : page === "marketplace"
                    ? marketplacePluginId
                      ? (marketplaceDetail?.name ?? marketplacePluginId)
                      : "官方与社区 · 已审核目录"
                    : sessionSource(data.status, data.session)}
            </small>
          </div>
          <div className="header-spacer"></div>
          {data.status?.status === "running" && (
            <div className="run-indicator running">
              <span className="run-dot"></span>
              <span>运行中 · Pi agent</span>
              <button className="stop-button" onClick={stopRun} title="停止当前运行（⌃C）" type="button">
                停止
              </button>
            </div>
          )}
          {!settings && page === "session" && (
            <div aria-label="会话视图" className="view-tabs">
              {(["chat", "trajectory", "files"] as const).map((item) => (
                <button
                  aria-pressed={view === item}
                  className={`view-tab ${view === item ? "active" : ""}`}
                  key={item}
                  onClick={() => {
                    setView(item);
                    setDetails(undefined);
                  }}
                  type="button"
                >
                  {item === "chat" ? "对话" : item === "trajectory" ? "轨迹" : "产出"}
                </button>
              ))}
            </div>
          )}
          {!settings && page === "session" && <span aria-hidden="true" className="header-divider"></span>}
          {!settings && page === "session" && (
            <>
              <div className="session-menu-wrap" data-session-popover>
                <button
                  aria-expanded={sessionMenuOpen && !sessionMenuPath}
                  aria-haspopup="menu"
                  className="session-menu"
                  onClick={(event) => {
                    const closeCurrentMenu = sessionMenuOpen && !sessionMenuPath;
                    setSessionMenuPath(undefined);
                    setSessionMenuPosition(undefined);
                    sessionPopoverTriggerRef.current = event.currentTarget;
                    setSessionActionTarget(
                      !closeCurrentMenu && activeSessionPath
                        ? { name: data.session?.sessionId?.slice(0, 12) || "当前会话", path: activeSessionPath }
                        : undefined,
                    );
                    setSessionMenuOpen(!closeCurrentMenu);
                  }}
                  type="button"
                  aria-label="会话操作"
                >
                  ⋯
                </button>
                {sessionMenuOpen && !sessionMenuPath && (
                  <div className="session-menu-popover compact-session-menu" role="menu">
                    <button
                      className="session-action"
                      disabled={!activeSessionPath || sessionActionBusy}
                      onClick={() => {
                        setSessionNameDraft(data.session?.sessionId?.slice(0, 12) ?? "");
                        setSessionDialog("rename");
                        setSessionMenuOpen(false);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <strong>重命名</strong>
                      <small>设置一个容易识别的名称</small>
                    </button>
                    <button
                      className="session-action"
                      disabled={!activeSessionPath || sessionActionBusy}
                      onClick={() =>
                        void sessionAction(async () => {
                          const result = await api.forkSession(activeSessionPath as string);
                          if (result.sessionFile) {
                            setSelectedSessionPath(result.sessionFile);
                            await api.openSession(result.sessionFile);
                          }
                        })
                      }
                      role="menuitem"
                      type="button"
                    >
                      <strong>复制会话</strong>
                      <small>复制上下文并打开副本</small>
                    </button>
                    <button
                      className="session-action"
                      disabled={!activeSessionPath || sessionActionBusy}
                      onClick={() => {
                        setSessionMenuOpen(false);
                        setSessionDialog("archive");
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <strong>归档会话</strong>
                      <small>从默认列表隐藏</small>
                    </button>
                    <button
                      className="session-action danger"
                      disabled={!activeSessionPath || sessionActionBusy}
                      onClick={() => {
                        setSessionMenuOpen(false);
                        setSessionDialog("delete");
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <strong>删除会话</strong>
                      <small>永久删除本地记录</small>
                    </button>
                  </div>
                )}
              </div>
              <button
                aria-label={details !== undefined ? "关闭详情" : "打开详情"}
                aria-pressed={details !== undefined}
                className="details-toggle"
                onClick={() => setDetails(details ? undefined : {})}
                type="button"
              >
                <span aria-hidden="true">◨</span> <span className="details-toggle-label">详情</span>
              </button>
            </>
          )}
        </header>
        {refreshIssues.length > 0 && (
          <div aria-live="polite" className="refresh-warning" role="status">
            <span>
              <strong>部分数据刷新失败</strong>
              {refreshIssues.join("、")}可能为空或显示上次结果。
            </span>
            <button onClick={() => void refresh()} type="button">
              重试
            </button>
          </div>
        )}
        <div className="view-host">
          {initialRefreshPending ? (
            <div aria-live="polite" className="initial-loading" role="status">
              <span aria-hidden="true"></span>
              正在连接 Pi runtime…
            </div>
          ) : (
            content
          )}
        </div>
      </section>
      {!settings && page === "session" && details !== undefined && (
        <>
          <button aria-label="关闭详情" className="details-backdrop" onClick={() => setDetails(undefined)} type="button" />
          <Details
            event={Object.keys(details).length ? details : undefined}
            onClose={() => setDetails(undefined)}
            onCopy={() => void navigator.clipboard?.writeText(JSON.stringify(details, null, 2))}
          />
        </>
      )}
      {globalSearchOpen && (
        <GlobalSearch
          commands={data.commands}
          files={data.files}
          onClose={() => setGlobalSearchOpen(false)}
          onOpenFile={(file) => {
            setPage("session");
            setView("files");
            setDetails({ type: "file", path: file.path, status: file.status });
          }}
          onOpenSession={openSession}
          onUse={insertCommand}
          sessions={data.sessions}
        />
      )}
      {workspaceChooserOpen && (
        <WorkspaceChooser
          error={workspaceError}
          onClose={() => setWorkspaceChooserOpen(false)}
          onPickDirectory={openDirectory}
          onSelect={(workspace) => void createNewSession(workspace)}
          workspaces={data.workspaces}
        />
      )}
      {sessionDialog && (
        <SessionDialog
          busy={sessionActionBusy}
          count={sessionDialog === "batch-delete" ? selectedSessionPaths.size : undefined}
          kind={sessionDialog}
          name={
            sessionDialog === "rename" || sessionDialog === "batch-delete"
              ? undefined
              : (sessionActionTarget?.name ?? value(data.session?.sessionId, "当前会话"))
          }
          onChange={setSessionNameDraft}
          onClose={() => {
            setSessionDialog(undefined);
            setSessionActionTarget(undefined);
          }}
          onConfirm={() => {
            const targetPath = sessionActionTarget?.path ?? activeSessionPath;
            if (sessionDialog === "rename" && targetPath) {
              void sessionAction(() => api.renameSession(targetPath, sessionNameDraft.trim()).then(() => undefined));
            } else if (sessionDialog === "archive" && targetPath) {
              void sessionAction(async () => {
                await api.setSessionMetadata(targetPath, { archived: true });
              });
            } else if (sessionDialog === "delete" && targetPath) {
              void sessionAction(async () => {
                await api.deleteSession(targetPath);
              });
            } else if (sessionDialog === "batch-delete") {
              void sessionAction(() => api.batchSessions("delete", [...selectedSessionPaths]).then(() => undefined));
            }
          }}
          value={sessionNameDraft}
        />
      )}
    </div>
  );
}
