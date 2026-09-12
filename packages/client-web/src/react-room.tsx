import { themeStudioView } from "./theme-studio-view.js";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  createClientApi,
  failedRefreshLabels,
  type ClientApi,
  type ClientCommand,
  type ClientEventStreamState,
  type ClientFile,
  type ClientMarketplaceCapability,
  type ClientMarketplaceCategory,
  type ClientMarketplacePlugin,
  type ClientModel,
  type ClientPiConfig,
  type ClientPlugin,
  type ClientPluginPanel,
  type ClientProvider,
  type ClientRunPhase,
  type ClientSession,
  type ClientStatus,
  type ClientWorkspace,
} from "./control-room.js";
import { getPromptCompletion, replacePromptCompletion, type PromptCompletionKind } from "./prompt-completion.js";
import {
  failPromptSubmission,
  finishPromptSubmission,
  promptDelivery,
  promptUiForSession,
  reportPromptRefreshFailure,
  runPromptSubmission,
  startPromptSubmission,
  updatePromptDraft,
  type ClientPromptUiState,
} from "./prompt-ui.js";
import { compactThinkingEvents, eventDataSource, eventKindLabel, eventOrigin, eventOutputText, formatEventClock, formatEventDuration, mergeTrajectoryEvents } from "./runtime-events.js";
import { MarkdownMessage } from "./markdown.js";
import { type ChatToolCall, messageText, messageThinking, projectChatTurns } from "./message-content.js";
import {
  annotationDraftForSession,
  captureSelectionForSession,
  clearSubmittedAnnotations,
  formatAnnotationPrompt,
  parseAnnotationPrompt,
  type ClientAnnotationDraft,
} from "./annotation-ui.js";
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
import { historyCompressorPanelView } from "./history-compressor-view.js";
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
import { sqlLensDisplayText, sqlLensPanelView, sqlLensRowsJson } from "./sql-lens-view.js";
import { agentTeamsPanelView } from "./agent-teams-view.js";
import { modlensPanelView } from "./modlens-view.js";
import { visionToolkitPanelView } from "./vision-toolkit-view.js";
import { readmeGenPanelView } from "./readme-gen-view.js";
import { taskboardPanelView } from "./taskboard-view.js";
import { promptLibraryPanelView } from "./prompt-library-view.js";
import { memoryPanelView } from "./memory-view.js";
import { workspaceSearchPanelView } from "./workspace-search-view.js";
import { workspaceNavigatorPanelView } from "./workspace-navigator-view.js";
import { betterSidebarPanelView, type BetterSidebarGitFailureReason } from "./better-sidebar-view.js";
import { LOCALES, formatLocale, setLocale, t, useLocale, writeStoredLocale } from "./i18n.js";

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
  marketplaceLocale?: string;
  marketplaceCapabilities: readonly ClientMarketplaceCapability[];
  marketplaceCategories: readonly ClientMarketplaceCategory[];
  marketplaceTotal: number;
  marketplacePage: number;
  marketplaceHasNext: boolean;
  commands: readonly ClientCommand[];
  workspaces: readonly ClientWorkspace[];
}

const EMPTY_MARKETPLACE_PLUGINS: readonly ClientMarketplacePlugin[] = [];
const EMPTY_MARKETPLACE_CAPABILITIES: readonly ClientMarketplaceCapability[] = [];
const EMPTY_MARKETPLACE_CATEGORIES: readonly ClientMarketplaceCategory[] = [];

const value = (input: unknown, fallback = "—"): string => {
  if (input === undefined || input === null || input === "") return fallback;
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") return String(input);
  try {
    return JSON.stringify(input);
  } catch {
    return fallback;
  }
};

function betterSidebarGitFailureText(reason: BetterSidebarGitFailureReason | null): string {
  switch (reason) {
    case "not-repository":
      return t("当前工作区不在 Git 仓库中。");
    case "timeout":
      return t("Git 状态读取超时；请提高 gitTimeoutMs 或缩小工作区。");
    case "git-unavailable":
      return t("未找到 Git 可执行文件。");
    case "output-limit":
      return t("Git 输出超过安全上限；请缩小工作区。");
    case "invalid-output":
      return t("Git 返回了无法安全解析的状态。");
    default:
      return t("Git 状态读取失败。");
  }
}

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
  status?.cwd ?? (typeof session?.sessionFile === "string" ? session.sessionFile : t("未选择工作区"));
export const archiveActionForSessions = (sessions: readonly { readonly archived?: boolean }[]): "archive" | "unarchive" =>
  sessions.length > 0 && sessions.every((session) => session.archived === true) ? "unarchive" : "archive";
export const pinActionForSessions = (sessions: readonly { readonly pinned?: boolean }[]): "pin" | "unpin" =>
  sessions.length > 0 && sessions.every((session) => session.pinned === true) ? "unpin" : "pin";
const EVENT_LABEL_LIMIT = 120;
const eventLabel = (event: Record<string, unknown>): string => {
  const type = value(event.type, "");
  if (type === "file_diff") return t("文件差异");
  if (type === "file") return t("文件详情");
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
    ["context", t("上下文")],
    ["agent-teams", t("协作")],
    ["modlens", t("视觉")],
    ["token-guard", t("预算")],
    ["git-time-capsule", t("版本控制")],
    ["dependency-checker", t("工程诊断")],
    ["at-file", t("文件上下文")],
    ["test-harness", t("测试")],
    ["session-insights", t("会话统计")],
    ["session-compare", t("会话对比")],
    ["secure-audit", t("安全审计")],
    ["readme-gen", t("文档生成")],
    ["i18n-pair", t("国际化")],
    ["cleaner", t("清理")],
    ["sql-lens", t("数据库")],
    ["docker-sandbox", t("沙箱")],
    ["mcp-client", t("工具协议")],
    ["mcp-panel", t("MCP 控制台")],
    ["browser-fetch", t("网页抓取")],
    ["web-research", t("联网研究")],
    ["browser-session", t("浏览器会话")],
    ["yaml-validator", t("配置校验")],
    ["mock-server", t("接口模拟")],
    ["cli-notifier", t("桌面通知")],
    ["obsidian-sync", t("知识库")],
    ["context-doctor", t("上下文诊断")],
    ["history-compressor", t("历史压缩")],
    ["reviewer-bot", t("代码审查")],
    ["auto-mode", t("安全执行")],
    ["plan-execute", t("计划执行")],
    ["plugin-finder", t("插件发现")],
    ["taskboard", t("任务看板")],
    ["synapse", t("会话地图")],
    ["hol-guard", t("安全防护")],
    ["plugin-radar", t("生态雷达")],
    ["plugin-stars", t("排行榜")],
    ["plugin-check", t("插件体检")],
    ["annotation", t("批注上下文")],
    ["cost-meter", t("成本账本")],
    ["undo-savepoint", t("恢复保存点")],
    ["skill-catalog", t("技能目录")],
    ["graph-memory", t("知识图谱")],
    ["memory", t("跨会话记忆")],
    ["canvas-draw", t("流程图")],
    ["image-compressor", t("图片压缩")],
    ["workspace-search", t("工作区检索")],
    ["prompt-guard", t("提示词防护")],
    ["code2skill", t("技能打包")],
    ["tab-manager", t("会话标签")],
    ["genui", t("结构化界面")],
    ["anchored-standard", t("轨迹锚定")],
    ["telemetry-blocker", t("遥测拦截")],
    ["change-verifier", t("变更门禁")],
    ["plugin-dev", t("插件开发")],
    ["openpets", t("桌面伙伴")],
    ["vision-toolkit", t("视觉素材")],
    ["session-bridge", t("会话交接")],
    ["skill-guard", t("Skill 安全")],
    ["recall-unread", t("会话召回")],
    ["turn-rewind", t("会话回退")],
    ["session-export", t("会话导出")],
    ["session-search", t("会话搜索")],
    ["session-bookmarks", t("会话书签")],
    ["llm-verifier", t("模型校验")],
    ["module-search", t("模块检索")],
    ["workspace-navigator", t("工作区导航")],
    ["better-sidebar", t("侧栏概览")],
    ["archify", t("架构地图")],
    ["mirage-bridge", t("Mirage 虚拟终端")],
    ["theme-studio", t("主题")],
    ["reverse-skill", t("技能隔离")],
    ["colleague-skill", t("角色交接")],
    ["prompt-library", t("提示词库")],
    ["model", t("模型")],
    ["tool", t("工具")],
    ["session", t("会话")],
    ["resource", t("资源")],
    ["web", t("界面")],
    ["gateway", t("界面")],
  ];
  return entries.find(([needle]) => name.includes(needle))?.[1] ?? t("运行时");
};
// The state the gateway reports for a plugin that is installed in the profile but has no loader entry yet, which is every marketplace install until the next start.
const RESTART_REQUIRED_PLUGIN_STATE = "restart-required";
// The runtime leases the tool registry for its whole life and snapshots the tool set when it takes it, so a plugin that contributes tools joins on the next start rather than immediately. The notice names no start command because the harness is reachable through more than one of them, and it covers enabling as well as installing because both actions share it.
export function restartRequiredNotice(): string {
  return t(
    "改动已写入 profile（~/.pi-harness/profiles/<profile>/cordis.yml）。控制台无法自行重启，请回到启动 Pi Harness 的终端按 Ctrl-C，再用原来的命令重新启动；在那之前这次改动不会生效，刚安装的插件也不会出现在「已安装」列表里。",
  );
}

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
  if (mapped !== undefined) return t(mapped);
  const status = /^Request failed with status (\d+)$/u.exec(text);
  if (status !== null) return t("请求失败（HTTP {status}）：请确认 Pi Harness 仍在运行，然后重试。", { status: status[1] ?? "" });
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
  if (packageMatch) return t("官方 · {scope}", { scope: packageMatch[1] ?? "" });
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

type SessionGroupId = "today" | "yesterday" | "earlier";

const SESSION_GROUP_ORDER: readonly SessionGroupId[] = ["today", "yesterday", "earlier"];

/** The heading of a session group. The bucket is keyed by id rather than by its heading because a key that changes with the language would scatter one day's sessions across three buckets. */
function sessionGroupLabel(id: SessionGroupId): string {
  if (id === "today") return t("今天");
  if (id === "yesterday") return t("昨天");
  return t("更早");
}

function sessionGroups(sessions: readonly Record<string, unknown>[]): readonly [SessionGroupId, readonly Record<string, unknown>[]][] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = start - 86_400_000;
  const groups = new Map<SessionGroupId, Record<string, unknown>[]>();
  for (const session of sessions) {
    const raw = session.modified ?? session.created;
    const timestamp = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    const id: SessionGroupId =
      Number.isFinite(timestamp) && timestamp >= start ? "today" : Number.isFinite(timestamp) && timestamp >= yesterday ? "yesterday" : "earlier";
    groups.set(id, [...(groups.get(id) ?? []), session]);
  }
  return SESSION_GROUP_ORDER.flatMap((id) => {
    const items = groups.get(id);
    return items?.length ? [[id, items] as const] : [];
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
    [t("定位问题"), t("分析当前仓库并给出根因")],
    [t("修复并测试"), t("实现修复并运行相关测试")],
    [t("审查改动"), t("只读检查未提交变更")],
    [t("解释代码"), t("解释当前文件的关键逻辑")],
  ];
  return (
    <div className="new-session-screen">
      <div className="welcome-kicker">PI AGENT HARNESS · REAL RUNTIME</div>
      <div className="welcome-heading">
        <span className="pi-mark large" aria-hidden="true">
          <img src="/icons/svg/mark-white.svg" alt="" />
        </span>
        <div>
          <h2>{t("开始一个工作会话")}</h2>
          <p>{t("连接当前工作区，直接让 Pi agent 读取、修改并验证代码。")}</p>
        </div>
      </div>
      <div className="workspace-picker">
        {workspaces.length ? (
          workspaces.map((workspace) => (
            <button className="workspace-row" key={workspace.path} onClick={() => onCreate(workspace)} type="button">
              <span className={`workspace-status ${workspace.current ? "live" : "offline"}`}>{workspace.current ? t("已连接") : t("工作区")}</span>
              <span>
                <code>{workspace.path}</code>
                <small>{workspace.current && status ? `${workspace.branch} · ${status.model}` : workspace.branch}</small>
              </span>
              <span className="workspace-arrow">↗</span>
            </button>
          ))
        ) : (
          <div className="workspace-row is-empty">
            <span className="workspace-status offline">{t("加载中")}</span>
            <span>
              <code>{status?.cwd ?? t("加载工作区…")}</code>
              <small>{t("正在读取 git worktree")}</small>
            </span>
          </div>
        )}
      </div>
      <div className="effective-config">
        <span className="config-label">{t("当前运行时")}</span>
        <span>{status?.model ?? t("由运行时提供")}</span>
        <span>{status ? t("{count} 条消息", { count: status.messages }) : "—"}</span>
        <a
          href="#"
          onClick={(event) => {
            event.preventDefault();
            onToml();
          }}
        >
          {t("改配置 ⌘,")}
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
  const [customPath, setCustomPath] = useState("");
  const handleCustomPathSubmit = () => {
    const trimmed = customPath.trim();
    if (trimmed) {
      onSelect({ path: trimmed, name: trimmed.split("/").pop() || trimmed, branch: "directory", current: false });
    }
  };
  return (
    <div className="workspace-chooser" onClick={onClose}>
      <div
        aria-label={t("选择工作区")}
        aria-modal="true"
        className="workspace-chooser-dialog"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="workspace-chooser-heading">
          <strong>{t("新建会话")}</strong>
          <button aria-label={t("关闭工作区选择")} onClick={onClose} type="button">
            ×
          </button>
        </div>
        <small>{t("选择这个会话要使用的工作区")}</small>
        {error ? (
          <div className="workspace-chooser-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="workspace-path-input-row">
          <input
            className="workspace-path-input"
            onChange={(e) => setCustomPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCustomPathSubmit();
            }}
            placeholder={t("输入绝对路径，如 /tmp/my-project")}
            type="text"
            value={customPath}
          />
          <button className="workspace-path-go" disabled={!customPath.trim()} onClick={handleCustomPathSubmit} type="button">
            {t("打开")}
          </button>
        </div>
        <button className="workspace-pick-directory" data-dialog-initial-focus onClick={() => void onPickDirectory()} type="button">
          <span>{t("打开目录")}</span>
          <small>{t("从 Finder 选择一个新的工作目录")}</small>
        </button>
        <div className="workspace-chooser-divider">
          <span>{t("或选择已有 worktree")}</span>
        </div>
        {workspaces.length ? (
          workspaces.map((workspace) => (
            <button className="workspace-chooser-row" key={workspace.path} onClick={() => onSelect(workspace)} type="button">
              <span className={`workspace-status ${workspace.current ? "live" : "offline"}`}>{workspace.current ? t("当前") : "worktree"}</span>
              <span>
                <strong>{workspace.name}</strong>
                <code>{workspace.path}</code>
              </span>
              <small>{workspace.branch}</small>
            </button>
          ))
        ) : (
          <span className="workspace-chooser-empty">{t("正在读取 git worktree…")}</span>
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
  const title = kind === "rename" ? t("重命名会话") : kind === "archive" ? t("归档会话") : destructive ? t("删除会话") : t("会话操作");
  const description =
    kind === "rename"
      ? t("给这个会话一个容易识别的名称。")
      : kind === "archive"
        ? t("归档后会从默认列表隐藏，之后仍可在会话工具中恢复。")
        : count && count > 1
          ? t("将永久删除 {count} 个会话及其本地记录，此操作不可撤销。", { count })
          : t("将永久删除这个会话及其本地记录，此操作不可撤销。");
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
          <button aria-label={t("关闭")} disabled={busy} onClick={onClose} type="button">
            ×
          </button>
        </header>
        {kind === "rename" && (
          <label className="session-dialog-field">
            <span>{t("名称")}</span>
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
            {t("取消")}
          </button>
          <button className={destructive ? "danger" : "primary"} disabled={busy || (kind === "rename" && !draft.trim())} onClick={onConfirm} type="button">
            {busy ? t("处理中…") : kind === "rename" ? t("保存名称") : kind === "archive" ? t("归档") : t("永久删除")}
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
          <button aria-label={t("关闭")} disabled={busy} onClick={onClose} type="button">
            ×
          </button>
        </header>
        {target && <div className="session-dialog-target">{target}</div>}
        <footer className="session-dialog-actions">
          <button data-dialog-initial-focus disabled={busy} onClick={onClose} type="button">
            {t("取消")}
          </button>
          <button className="danger" disabled={busy} onClick={onConfirm} type="button">
            {busy ? t("处理中…") : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

function SessionActionMenu({
  busy,
  archived,
  pinned,
  position,
  themeStyle,
  onRename,
  onFork,
  onArchive,
  onPin,
  onDelete,
}: {
  busy: boolean;
  archived: boolean;
  pinned: boolean;
  position: { left: number; top: number };
  themeStyle?: CSSProperties;
  onRename: () => void;
  onFork: () => void;
  onArchive: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  return createPortal(
    <div
      className="session-row-menu-popover"
      data-session-popover
      onClick={(event) => event.stopPropagation()}
      role="menu"
      style={{ ...themeStyle, ...position }}
    >
      <button autoFocus disabled={busy} onClick={onRename} role="menuitem" type="button">
        {t("重命名")}
      </button>
      <button disabled={busy} onClick={onFork} role="menuitem" type="button">
        {t("复制会话")}
      </button>
      <button disabled={busy} onClick={onPin} role="menuitem" type="button">
        {pinned ? t("取消置顶") : t("置顶")}
      </button>
      <button disabled={busy} onClick={onArchive} role="menuitem" type="button">
        {archived ? t("恢复会话") : t("归档会话")}
      </button>
      <button className="danger" disabled={busy} onClick={onDelete} role="menuitem" type="button">
        {t("删除会话")}
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

export function ProviderAuthNotice({ model, providers, onConfigure }: { model?: string; providers: readonly ClientProvider[]; onConfigure: () => void }) {
  const provider = providers.find((item) => model?.startsWith(`${item.provider}/`));
  // Absence of metadata is not evidence of missing credentials. Warn only on
  // the selected provider's explicit status; local commands remain usable.
  if (provider?.auth?.configured !== false) return null;
  return (
    <div className="provider-auth-notice" role="status">
      <div className="action-error-summary">
        <strong>{t("模型尚未配置认证")}</strong>
        <span>{provider.name}</span>
        <span>
          {provider.provider === "everyapi"
            ? t("请用 everyapi use pi-harness 启动，或设置 EVERYAPI_RELAY_KEY 后重启。")
            : t("请在设置 → 提供商中配置 API key，然后重试。")}
        </span>
      </div>
      <button className="tool-chip" type="button" onClick={onConfigure}>
        {t("提供商")}
      </button>
    </div>
  );
}

function PromptError({ message }: { message: string }) {
  const everyApiAuth = /No API key found for everyapi/i.test(message);
  const requiresAuth = everyApiAuth || /No API key found|authentication|未配置认证/i.test(message);
  return (
    <div className="action-error" role="alert">
      <div className="action-error-summary">
        <strong>{everyApiAuth ? t("EveryAPI 认证未注入当前进程") : requiresAuth ? t("模型尚未配置认证") : t("发送失败")}</strong>
        <span>
          {everyApiAuth
            ? t("请用 everyapi use pi-harness 启动，或设置 EVERYAPI_RELAY_KEY 后重启。")
            : requiresAuth
              ? t("请在设置 → 提供商中配置 API key，然后重试。")
              : t("运行时没有接受这次请求，请重试或查看错误详情。")}
        </span>
      </div>
      <details>
        <summary>{t("查看原始错误")}</summary>
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
        <span className="ml-2 inline-flex rounded-md bg-[var(--color-blue-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-blue)]">
          {t("批注 ×{v0}", { v0: parsed.count })}
        </span>
      ) : null}
    </div>
  );
}

function Details({ event, onClose, onCopy }: { event: Record<string, unknown> | undefined; onClose: () => void; onCopy: () => void }) {
  if (!event)
    return (
      <aside className="details-panel">
        <header>
          <strong>{t("事件详情")}</strong>
          <button aria-label={t("关闭事件详情")} onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div className="details-body">
          <div className="empty-state">{t("选择轨迹中的事件查看原始数据。")}</div>
        </div>
      </aside>
    );
  const output = event.output ?? event.result ?? event.message;
  const outputText = eventOutputText(output);
  const fileDetail = event.type === "file" || event.type === "file_diff";
  const stats: readonly [string, string][] = fileDetail
    ? [
        [t("来源"), "/api/files"],
        [t("文件"), value(event.path)],
      ]
    : [
        [t("类型"), eventKindLabel(event.type)],
        [t("产生者"), eventOrigin(event)],
        [t("耗时"), formatEventDuration(event)],
        [t("时间"), formatEventClock(event)],
      ];
  return (
    <aside className="details-panel">
      <header>
        <strong>{eventLabel(event)}</strong>
        <button aria-label={fileDetail ? t("关闭文件差异") : t("关闭事件详情")} onClick={onClose} type="button">
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
            <small>{t("输出")}</small>
            {/* A tool result is text wrapped in a content envelope, and printing the envelope made the panel show JSON where the file the tool read should be. The raw payload is still one disclosure below. */}
            <pre className="tool-output">{outputText ?? JSON.stringify(output, null, 2)}</pre>
          </div>
        )}
        <div className="detail-section">
          <small>{fileDetail ? t("数据来源") : t("经过的插件")}</small>
          <div className="detail-plugin">{eventDataSource(event)}</div>
        </div>
        <div className="detail-actions">
          <button onClick={onCopy} type="button">
            {t("复制 JSON")}
          </button>
          <button disabled title={t("当前 API 未提供重放接口")} type="button">
            {t("重放")}
          </button>
        </div>
        <details className="raw-json">
          <summary>{t("原始 JSON")}</summary>
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
  const historicalCount = events.filter((event) => event.historical === true && event.type !== "historical_events_omitted").length;
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
        <span>{t("按轮次")}</span>
        <b>{t("{v0} 个事件", { v0: events.length })}</b>
        {historicalCount > 0 && <small className="trajectory-history">{t("已从会话日志恢复 {count} 个历史事件", { count: historicalCount })}</small>}
        <div className="timeline">
          {events.length ? (
            events.map((event, index) => (
              <span className="timeline-turn" key={index}>
                <i className="timeline-strip" title={eventLabel(event)}></i>
              </span>
            ))
          ) : (
            <span className="timeline-empty">{resumed ? t("本次打开后还没有事件") : t("等待真实事件…")}</span>
          )}
        </div>
      </div>
      <div className="source-filters">
        <button className={`filter ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")} type="button">
          {t("全部 {v0}", { v0: events.length })}
        </button>
        {[...counts].map(([type, count]) => (
          <button className={`filter ${filter === type ? "active" : ""}`} key={type} onClick={() => setFilter(type)} title={type} type="button">
            {eventKindLabel(type)} {count}
          </button>
        ))}
      </div>
      <div className="event-table">
        <div className="event-head">
          <span>{t("时间")}</span>
          <span>{t("类型")}</span>
          <span>{t("事件")}</span>
          <span>{t("产生者")}</span>
          <span>{t("耗时")}</span>
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
            {resumed ? t("轨迹只记录控制台连上之后发生的事件，这条会话已有的 {count} 条消息请看「对话」。", { count: sessionMessages }) : t("暂无轨迹事件。")}
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
          <strong>{t("本次会话改动")}</strong>
          <span>{t("由 /api/files 提供")}</span>
        </div>
        <div className="file-summary">
          {t("{files} 个文件 · {additions} 个新增文件 · {deletions} 个删除文件", { files: files.length, additions, deletions })}
        </div>
        <div className="file-list">
          {files.length ? (
            files.map((file) => (
              <div className="file-row" key={file.path}>
                <b className={`file-kind ${file.label === "untracked" ? "new" : ""}`}>{file.label}</b>
                <code>{file.path}</code>
                <span className={file.status.includes("D") ? "del" : "add"}>{file.status}</span>
                <button
                  aria-label={diffPending === file.path ? t("正在读取 {path} 的差异", { path: file.path }) : t("查看 {path} 的差异", { path: file.path })}
                  className="diff-button"
                  disabled={busy || diffPending !== undefined}
                  onClick={() => openDiff(file.path)}
                  type="button"
                >
                  {diffPending === file.path ? t("读取中…") : t("查看差异")}
                </button>
              </div>
            ))
          ) : (
            <div className="empty-state">{t("工作区没有未提交改动。")}</div>
          )}
        </div>
        {files.length > 0 && (
          <div className="file-actions">
            <input aria-label={t("提交说明")} onChange={(event) => setMessage(event.target.value)} placeholder={t("提交说明")} value={message} />
            <button className="primary" disabled={busy || !message.trim()} onClick={commit} type="button">
              {busy ? t("处理中…") : t("提交这些改动")}
            </button>
            <button disabled={busy} onClick={() => setRevertConfirmOpen(true)} type="button">
              {t("全部撤销")}
            </button>
          </div>
        )}
        {error && <p className="files-error">{error}</p>}
      </div>
      {revertConfirmOpen && (
        <ConfirmDialog
          busy={busy}
          confirmLabel={t("确认撤销")}
          description={t("这会丢弃当前工作区的全部未提交改动，此操作不可恢复。")}
          onClose={() => setRevertConfirmOpen(false)}
          onConfirm={revert}
          target={t("{count} 个文件", { count: files.length })}
          title={t("撤销全部改动")}
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

export function PluginPanelCard({ panel, inline = false, activeSessionId }: { panel: ClientPluginPanel; inline?: boolean; activeSessionId?: string }) {
  const data = pluginPanelData(panel.data);
  const entries = data ? Object.entries(data) : [[t("内容"), panel.data] as const];
  const items = data && Array.isArray(data.items) ? data.items : [];
  const pluginEntries = data && Array.isArray(data.entries) ? data.entries : [];
  const capabilities = data && Array.isArray(data.capabilities) ? data.capabilities : [];
  return (
    <div
      className={`plugin-panel-card ${inline ? "pt-1" : "rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] p-4 shadow-[0_8px_24px_rgba(27,39,64,0.04)]"}`}
    >
      <header className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-blue-soft)] font-mono text-[15px] text-[var(--color-blue)]">
          {panel.icon ?? "◈"}
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-[13px] font-semibold text-[var(--color-ink)]">{panel.title}</strong>
          <p className="mt-1 text-[11px] leading-4 text-[var(--color-faint)]">{panel.description ?? panel.pluginId.replace(/cordis/gi, "runtime")}</p>
        </div>
      </header>
      {panel.error ? (
        <div className="mt-3 rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-2 text-[12px] text-[var(--color-red)]">{panel.error}</div>
      ) : panel.id === "console-logger-panel" ? (
        <div className="mt-3 grid gap-2">
          <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
            <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">{t("最近日志")}</span>
            <strong className="mt-1 block text-[20px] font-semibold text-[var(--color-ink)]">{value(data?.total ?? 0)}</strong>
          </div>
          <div className="max-h-48 overflow-auto rounded-lg border border-[var(--color-line)]">
            {items.length ? (
              items.map((item, index) => {
                const message = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div
                    className="grid grid-cols-[auto_1fr] gap-2 border-b border-[var(--color-line)] px-3 py-2 last:border-b-0"
                    key={`${value(message.time ?? "log")}-${index}`}
                  >
                    <span className="font-mono text-[10px] text-[var(--color-faint)]">{value(message.level ?? "log")}</span>
                    <div className="min-w-0">
                      <strong className="block truncate text-[11px] text-[var(--color-ink)]">{value(message.source ?? "runtime")}</strong>
                      <span className="block whitespace-pre-wrap break-words text-[11px] leading-4 text-[var(--color-muted)]">
                        {pluginPanelValue(message.args ?? "")}
                      </span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-4 text-[12px] text-[var(--color-faint)]">{t("暂无日志输出。")}</div>
            )}
          </div>
        </div>
      ) : panel.id === "plugin-group-panel" ? (
        <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-[var(--color-line)]">
          {pluginEntries.length ? (
            pluginEntries.map((item, index) => {
              const entry = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
              return (
                <div
                  className="flex items-center gap-3 border-b border-[var(--color-line)] px-3 py-2 last:border-b-0"
                  key={`${value(entry.id ?? "plugin")}-${index}`}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${entry.enabled === false ? "bg-[#a0a8b2]" : "bg-[#22c55e]"}`}></span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-ink)]">{value(entry.name ?? "plugin")}</span>
                  <span className="text-[10px] text-[var(--color-faint)]">{value(entry.state ?? "unknown")}</span>
                </div>
              );
            })
          ) : (
            <div className="px-3 py-4 text-[12px] text-[var(--color-faint)]">{t("暂无插件条目。")}</div>
          )}
        </div>
      ) : panel.id === "timer-service-panel" ? (
        <div className="mt-3 grid gap-3 rounded-lg bg-[var(--color-soft)] px-3 py-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">{t("服务状态")}</span>
            <span
              className={`rounded-full px-2 py-1 text-[10px] font-semibold ${data?.registered === true ? "bg-[var(--color-green-soft)] text-[var(--color-green)]" : "bg-[var(--color-amber-soft)] text-[var(--color-amber)]"}`}
            >
              {data?.registered === true ? t("已注册") : t("未注册")}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {capabilities.map((capability, index) => (
              <span
                className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]"
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
              <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                {[
                  [t("成员"), view.inventory.members.total],
                  [t("任务"), view.inventory.tasks.total],
                  [t("未读消息"), view.inventory.messages.unread],
                  [t("可执行任务"), view.inventory.tasks.ready],
                ].map(([label, item]) => (
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                    <strong className="mt-1 block text-[17px] font-semibold text-[var(--color-ink)]">{value(item)}</strong>
                  </div>
                ))}
              </div>
              {view.dependencyCycle !== null && view.dependencyCycle.length > 1 ? (
                <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-2 text-[11px] text-[var(--color-red)]">
                  {t("依赖循环：{v0}", { v0: view.dependencyCycle.join(" → ") })}
                </div>
              ) : null}
              <div className="grid gap-2">
                {view.members.length > 0 ? (
                  view.members.map((member) => (
                    <div
                      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 rounded-lg border border-[var(--color-line)] px-3 py-2"
                      key={member.id}
                    >
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${member.status === "working" ? "bg-[#22c55e]" : "bg-[#a0a8b2]"}`}></span>
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
                          <span className="min-w-0 break-words text-[11px] font-semibold text-[var(--color-ink)]">{member.name}</span>
                          <span className="shrink-0 font-mono text-[10px] text-[var(--color-blue)]">{member.status}</span>
                        </div>
                        <code className="mt-1 block break-all text-[9px] text-[var(--color-blue)]">{member.id}</code>
                        <span className="mt-1 block break-words text-[10px] leading-4 text-[var(--color-faint)]">{member.role}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-3 text-[12px] text-[var(--color-faint)]">{t("暂无协作角色。")}</div>
                )}
              </div>
              <div className="grid gap-2">
                {view.tasks.length > 0 ? (
                  view.tasks.map((task) => (
                    <div
                      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-lg border border-[var(--color-line)] px-3 py-2"
                      key={task.id}
                    >
                      <div className="min-w-0 flex-1">
                        <span className="block break-words text-[11px] leading-4 text-[var(--color-ink)]">{task.title}</span>
                        <code className="mt-1 block break-all text-[9px] text-[var(--color-blue)]">{task.id}</code>
                        <code className="mt-1 block break-all text-[9px] text-[var(--color-faint)]">{task.assignee}</code>
                        {task.dependsOn.length > 0 ? (
                          <span className="mt-1 block break-all font-mono text-[9px] leading-4 text-[var(--color-faint)]">
                            {t("依赖：{v0}", { v0: task.dependsOn.join(", ") })}
                          </span>
                        ) : null}
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${task.status === "blocked" ? "bg-[var(--color-amber-soft)] text-[var(--color-amber)]" : task.status === "done" ? "bg-[var(--color-green-soft)] text-[var(--color-green)]" : "bg-[var(--color-blue-soft)] text-[var(--color-blue)]"}`}
                      >
                        {task.status}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-3 text-[12px] text-[var(--color-faint)]">
                    {t("还没有任务。可让 Agent 使用 team_task 创建。")}
                  </div>
                )}
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("会话内邮箱备注")}</span>
                  <span className="font-mono text-[10px] text-[var(--color-faint)]">
                    {view.inventory.messages.shown} / {view.inventory.messages.total}
                  </span>
                </div>
                {view.messages.length > 0 ? (
                  [...view.messages].reverse().map((message) => (
                    <div
                      className={`rounded-lg border px-3 py-2 ${message.read ? "border-[var(--color-line)] bg-[var(--color-surface)]" : "border-[#cfe0ff] bg-[var(--color-blue-soft)]"}`}
                      key={message.id}
                    >
                      <div className="flex items-center gap-2 text-[10px] text-[var(--color-faint)]">
                        <span className="font-mono text-[var(--color-blue)]">
                          {message.from} → {message.to}
                        </span>
                        <span className="ml-auto">{message.read ? t("已读") : t("未读")}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-[var(--color-ink)]">{message.body}</p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-3 text-[12px] text-[var(--color-faint)]">{t("暂无邮箱备注。")}</div>
                )}
              </div>
              {view.truncated || view.inventory.members.truncated || view.inventory.tasks.truncated || view.inventory.messages.truncated ? (
                <p className="text-[10px] leading-4 text-[var(--color-amber)]">{t("面板按固定安全上限展示；完整计数保留在上方。")}</p>
              ) : null}
              <p className="text-[10px] leading-4 text-[var(--color-faint)]">
                {t("这是当前 Pi 会话的协作账本，不会启动其他 Agent、创建进程或向外部发送消息。")}
              </p>
            </div>
          );
        })()
      ) : panel.id === "modlens-panel" ? (
        (() => {
          const view = modlensPanelView(panel.data);
          const stateLabel =
            view.status.state === "running"
              ? t("正在读取视觉内容")
              : view.status.state === "failed"
                ? t("视觉检查失败")
                : view.status.state === "cancelled"
                  ? t("视觉检查已取消")
                  : view.status.state === "completed"
                    ? t("视觉检查完成")
                    : t("等待图片");
          const mode = view.status.state === "idle" ? view.image?.mode : view.status.mode;
          const path = view.status.state === "idle" ? view.image?.path : view.status.path;
          const stateStyle =
            view.status.state === "failed"
              ? "border-[#f4caca] bg-[var(--color-red-soft)]"
              : view.status.state === "cancelled"
                ? "border-[#f1d7a8] bg-[var(--color-amber-soft)]"
                : view.status.state === "running"
                  ? "border-[#c9d9f7] bg-[var(--color-blue-soft)]"
                  : view.attached
                    ? "border-[#b9e6c9] bg-[var(--color-green-soft)]"
                    : "border-[var(--color-line)] bg-[var(--color-soft)]";
          return (
            <div className="mt-3 grid gap-3">
              <div className={`rounded-lg border px-3 py-3 ${stateStyle}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[var(--color-ink)]">{stateLabel}</span>
                  <span className="rounded-full border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[9px] text-[var(--color-blue)]">
                    {mode === "native" ? t("原生直传") : mode === "evidence" ? t("ModLens 证据") : "vision_inspect"}
                  </span>
                </div>
                {path !== undefined ? <p className="mt-2 truncate font-mono text-[10px] text-[var(--color-muted)]">{path}</p> : null}
                {view.image !== null ? (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--color-faint)]">
                    <span>{view.image.mimeType}</span>
                    <span>{view.image.bytes.toLocaleString(formatLocale())} bytes</span>
                    {view.image.cached ? <span className="font-semibold text-[var(--color-green)]">{t("缓存命中")}</span> : null}
                  </div>
                ) : view.status.state === "idle" ? (
                  <p className="mt-2 text-[11px] text-[var(--color-faint)]">{t("让 Agent 调用 vision_inspect，并提供工作区内的图片路径。")}</p>
                ) : null}
                {view.status.state === "failed" || view.status.state === "cancelled" ? (
                  <p className="mt-2 break-words text-[10px] leading-4 text-[var(--color-red)]">{view.status.error}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {view.supportedTypes.map((type) => (
                  <span
                    className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]"
                    key={type}
                  >
                    {type}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 font-mono text-[9px] text-[var(--color-faint)]">
                <span>image:{Math.round(view.limits.imageBytes / 1_048_576)}MiB</span>
                <span>evidence:{Math.round(view.limits.evidenceBytes / 1_024)}KiB</span>
                <span>timeout:{Math.round(view.limits.timeoutMs / 1_000)}s</span>
                <span>cache:{view.limits.cacheEntries}</span>
              </div>
              {view.truncated ? <p className="text-[10px] leading-4 text-[var(--color-amber)]">{t("异常面板数据已按固定安全边界丢弃或截断。")}</p> : null}
              <p className="rounded-lg border border-[#dce5f5] bg-[var(--color-soft)] px-3 py-2 text-[10px] leading-4 text-[var(--color-muted)]">
                {t("纯文本模型会启动外部 ModLens 引擎，可能使用网络和 provider 配额并产生费用。视觉证据是不可信数据，不构成指令或用户授权。")}
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
                ? t("正在盘点视觉素材")
                : t("正在读取图片元数据")
              : view.status.state === "failed"
                ? t("视觉素材检查失败")
                : view.status.state === "cancelled"
                  ? t("视觉素材检查已取消")
                  : view.status.state === "completed"
                    ? t("视觉素材检查完成")
                    : t("等待检查");
          const stateStyle =
            view.status.state === "failed"
              ? "border-[#f4caca] bg-[var(--color-red-soft)]"
              : view.status.state === "cancelled"
                ? "border-[#f1d7a8] bg-[var(--color-amber-soft)]"
                : view.status.state === "running"
                  ? "border-[#c9d9f7] bg-[var(--color-blue-soft)]"
                  : view.status.state === "completed"
                    ? "border-[#b9e6c9] bg-[var(--color-green-soft)]"
                    : "border-[var(--color-line)] bg-[var(--color-soft)]";
          const shownAssets = report?.assets.slice(0, 20) ?? [];
          const shownIssues = report?.issues.slice(0, 10) ?? [];
          return (
            <div className="mt-3 grid gap-3">
              <div className={`rounded-lg border px-3 py-3 ${stateStyle}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[var(--color-ink)]">{stateLabel}</span>
                  <span className="rounded-full border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[9px] text-[var(--color-blue)]">
                    {view.status.state === "idle" ? "vision_catalog" : view.status.operation === "catalog" ? "catalog" : "image info"}
                  </span>
                </div>
                {view.status.state !== "idle" && view.status.path !== undefined ? (
                  <p className="mt-2 truncate font-mono text-[10px] text-[var(--color-muted)]">{view.status.path}</p>
                ) : null}
                {view.status.state === "failed" || view.status.state === "cancelled" ? (
                  <p className="mt-2 break-words text-[10px] leading-4 text-[var(--color-red)]">{view.status.error}</p>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  [t("已扫描"), report?.scannedEntries ?? 0],
                  [t("候选图片"), report?.inspectedCandidates ?? 0],
                  [t("有效素材"), report?.assets.length ?? 0],
                  [t("问题"), report?.issues.length ?? 0],
                ].map(([label, count]) => (
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2" key={label}>
                    <span className="block text-[10px] text-[var(--color-faint)]">{label}</span>
                    <strong className="mt-1 block font-mono text-[16px] text-[var(--color-ink)]">{count}</strong>
                  </div>
                ))}
              </div>
              {shownAssets.length > 0 ? (
                <div className="max-h-52 overflow-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
                  {shownAssets.map((asset, index) => (
                    <div className="border-b border-[var(--color-line)] px-3 py-2 last:border-b-0" key={`${asset.path}-${index}`}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate font-mono text-[10px] text-[var(--color-ink)]" title={asset.path}>
                          {asset.path}
                        </span>
                        <span className="shrink-0 font-mono text-[9px] text-[var(--color-blue)]">
                          {asset.width === null ? "?×?" : `${asset.width}×${asset.height}`}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-[9px] text-[var(--color-faint)]">
                        <span>{asset.mimeType}</span>
                        <span>{asset.bytes.toLocaleString(formatLocale())} B</span>
                        {asset.headerTruncated ? <span className="text-[var(--color-amber)]">{t("仅扫描前 256 KiB")}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {report === null ? t("让 Agent 调用 vision_catalog 盘点工作区图片，或调用 vision_image_info 检查单张图片。") : t("未发现有效的受支持图片。")}
                </div>
              )}
              {shownIssues.length > 0 ? (
                <div className="rounded-lg border border-[#f1d7a8] bg-[var(--color-amber-soft)] px-3 py-3">
                  <p className="text-[10px] font-semibold text-[var(--color-amber)]">{t("图片问题（显示 {v0} 条）", { v0: shownIssues.length })}</p>
                  <div className="mt-2 grid gap-1.5">
                    {shownIssues.map((issue, index) => (
                      <p className="break-words font-mono text-[9px] leading-4 text-[var(--color-amber)]" key={`${issue.path}-${index}`}>
                        {issue.path}: {issue.reason}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {view.supportedTypes.map((type) => (
                  <span
                    className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[9px] text-[var(--color-blue)]"
                    key={type}
                  >
                    {type}
                  </span>
                ))}
                <span className="rounded-md border border-[var(--color-line)] bg-[var(--color-soft)] px-2 py-1 font-mono text-[9px] text-[var(--color-faint)]">
                  file≤{Math.round(view.limits.imageBytes / 1_048_576)}MiB
                </span>
                <span className="rounded-md border border-[var(--color-line)] bg-[var(--color-soft)] px-2 py-1 font-mono text-[9px] text-[var(--color-faint)]">
                  assets≤{view.limits.assets}
                </span>
              </div>
              {view.truncated ||
              report?.truncated === true ||
              report?.issuesTruncated === true ||
              (report !== null && (report.assets.length > shownAssets.length || report.issues.length > shownIssues.length)) ? (
                <p className="text-[10px] leading-4 text-[var(--color-amber)]">{t("面板或扫描结果已按固定安全上限截断；计数与警告会保留可见。")}</p>
              ) : null}
              <p className="rounded-lg border border-[#dce5f5] bg-[var(--color-soft)] px-3 py-2 text-[10px] leading-4 text-[var(--color-muted)]">
                {t("仅在当前 workspace 内本地读取图片头部，不上传图片、不调用外部视觉服务；这里展示的是元数据，不是完整图像解码结果。")}
              </p>
            </div>
          );
        })()
      ) : panel.id === "at-file-panel" ? (
        (() => {
          const view = atFilePanelView(panel.data);
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("最近附加")}</span>
                  <span className="font-mono text-[10px] text-[var(--color-faint)]">file_context</span>
                </div>
                {view.lastFile !== null ? (
                  <p className="mt-2 min-w-0 whitespace-normal break-all text-[11px] leading-4 text-[var(--color-muted)]">
                    {view.lastFile.path} · {view.lastFile.bytes} bytes
                  </p>
                ) : (
                  <p className="mt-2 text-[11px] text-[var(--color-faint)]">{t("还没有附加文件。可使用 @file 或让 Agent 调用 file_context。")}</p>
                )}
              </div>
              <div className="flex items-center justify-between text-[11px] text-[var(--color-faint)]">
                <span>{t("单文件上限")}</span>
                <strong className="font-mono text-[var(--color-blue)]">{view.maxBytes} bytes</strong>
              </div>
              {view.truncated ? <p className="text-[10px] leading-4 text-[var(--color-amber)]">{t("面板数据不完整或已按固定安全上限调整。")}</p> : null}
            </div>
          );
        })()
      ) : panel.id === "git-time-capsule-panel" ? (
        (() => {
          const report = gitTimeCapsulePanelView(data);
          const latest = report.latest;
          const statusLabel = latest?.status === "completed" ? t("已完成") : latest?.status === "cancelled" ? t("已取消") : t("失败");
          const statusStyle =
            latest?.status === "completed"
              ? "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"
              : latest?.status === "cancelled"
                ? "border-[#f1ddb1] bg-[var(--color-amber-soft)] text-[var(--color-amber)]"
                : "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]";
          return (
            <div className="mt-3 grid gap-3">
              <div className={`rounded-lg border px-3 py-3 ${latest === null ? "border-[var(--color-line)] bg-[var(--color-soft)]" : statusStyle}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[var(--color-ink)]">{latest?.action === "restore" ? t("最近撤销") : t("最近捕获")}</span>
                  {latest === null ? (
                    <span className="font-mono text-[10px] text-[var(--color-faint)]">git_snapshot</span>
                  ) : (
                    <span className="rounded-full border border-current px-2 py-0.5 text-[9px] font-semibold">{statusLabel}</span>
                  )}
                </div>
                {latest === null ? (
                  <p className="mt-2 text-[11px] leading-4 text-[var(--color-faint)]">
                    {t("当前没有撤销胶囊。先产生 unstaged tracked 改动，再让 Agent 调用 git_snapshot。")}
                  </p>
                ) : (
                  <div className="mt-2 grid gap-1 text-[11px] text-[var(--color-muted)]">
                    {latest.name !== null ? <p className="truncate font-mono text-[10px] text-[var(--color-ink)]">{latest.name}</p> : null}
                    <p>
                      {latest.status === "completed" ? (
                        <>
                          {latest.files} {t("个文件 ·")} {latest.bytes} bytes ·{" "}
                        </>
                      ) : null}
                      <time dateTime={latest.at}>{latest.at.replace("T", " ")}</time>
                    </p>
                    {latest.error !== null ? <p className="break-words text-[var(--color-red)]">{latest.error}</p> : null}
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("最近胶囊")}</span>
                  <span className="font-mono text-[10px] text-[var(--color-blue)]">
                    {report.inventory.shown} / {report.inventory.total}
                  </span>
                </div>
                {report.capsules.length > 0 ? (
                  <div className="mt-2 max-h-44 overflow-y-auto border-l-2 border-[#cbd8ef] pl-3">
                    {report.capsules.map((capsule) => (
                      <div className="flex min-w-0 items-center gap-2 border-b border-[#eef1f5] py-1.5 last:border-b-0" key={capsule.name}>
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-ink)]">{capsule.name}</span>
                        <span className="shrink-0 font-mono text-[9px] text-[var(--color-faint)]">{capsule.bytes} B</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-[var(--color-faint)]">{t("尚未保存 tracked diff。")}</p>
                )}
                {report.inventory.truncated || report.truncated ? (
                  <p className="mt-2 text-[10px] text-[var(--color-amber)]">
                    {t("列表已按安全上限截断，仅展示最近 {v0} 条有效记录。", { v0: report.inventory.displayLimit })}
                  </p>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2 text-[10px] text-[var(--color-faint)]">
                <span className="rounded-md bg-[var(--color-soft)] px-2 py-1.5">{t("Git 超时：{v0} ms", { v0: report.timeoutMs })}</span>
                <span className="rounded-md bg-[var(--color-soft)] px-2 py-1.5">{t("单胶囊：{v0} B", { v0: report.limits.capsuleBytes })}</span>
              </div>
              <p className="text-[10px] leading-4 text-[var(--color-faint)]">
                {t("git_snapshot 捕获当前 unstaged tracked 改动；git_restore 会反向应用该 patch。staged 与未跟踪文件不包含在内，恢复必须传入 confirm=true。")}
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
                <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-2 text-[10px]">
                  <span className="min-w-0 truncate font-mono text-[var(--color-muted)]">{report.manifest}</span>
                  <strong className="shrink-0 font-mono uppercase text-[var(--color-blue)]">{report.ecosystem}</strong>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {[
                    [t("声明"), report.declared],
                    [t("已安装"), report.installed],
                    [t("问题"), report.missingCount + report.invalidCount],
                    [t("可选缺席"), report.optionalMissingCount],
                    [t("未决"), report.unresolvedCount],
                  ].map(([label, item]) => (
                    <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                      <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                      <strong className="mt-1 block text-[17px] font-semibold text-[var(--color-ink)]">{value(item)}</strong>
                    </div>
                  ))}
                </div>
                <div
                  className={`min-w-0 break-words rounded-lg border px-3 py-3 text-[11px] [overflow-wrap:anywhere] ${hasProblems ? "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]" : isIndeterminate ? "border-[#f3dfab] bg-[var(--color-amber-soft)] text-[var(--color-amber)]" : "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"}`}
                >
                  {report.missingCount || report.invalidCount
                    ? t("缺失 {missing}、无效 {invalid}：{names}", {
                        missing: report.missingCount,
                        invalid: report.invalidCount,
                        names: [...report.missing, ...report.invalid].join(", "),
                      })
                    : report.conflictCount
                      ? t("本地安装存在 {count} 组声明约束冲突。", { count: report.conflictCount })
                      : report.unresolvedCount
                        ? t("{count} 组声明约束无法离线判定。", { count: report.unresolvedCount })
                        : report.truncated
                          ? t("报告不完整，无法确认依赖状态。")
                          : t("依赖声明与本地安装一致。")}
                </div>
                {report.optionalMissingCount > 0 ? (
                  <div className="min-w-0 break-words rounded-lg border border-[#f3dfab] bg-[var(--color-amber-soft)] px-3 py-2 text-[10px] text-[var(--color-amber)] [overflow-wrap:anywhere]">
                    {t("可选依赖未安装（{v0}）：{v1}", { v0: report.optionalMissingCount, v1: report.optionalMissing.join(", ") })}
                  </div>
                ) : null}
                {report.conflicts.length > 0 ? (
                  <div className="rounded-lg border border-[#f3dfab] bg-[var(--color-amber-soft)] px-3 py-3 text-[11px] text-[var(--color-amber)]">
                    <strong>{t("版本冲突")}</strong>
                    <ul className="mt-1 grid gap-1 pl-4">
                      {report.conflicts.map((conflict, index) => (
                        <li className="min-w-0 break-words [overflow-wrap:anywhere]" key={`${conflict.name}-${index}`}>
                          <code>{conflict.name}</code>: {conflict.constraints.join(" · ") || "—"}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {report.unresolved.length > 0 ? (
                  <div className="rounded-lg border border-[#f3dfab] bg-[var(--color-amber-soft)] px-3 py-3 text-[11px] text-[var(--color-amber)]">
                    <strong>{t("未决约束")}</strong>
                    <ul className="mt-1 grid gap-1 pl-4">
                      {report.unresolved.map((constraint, index) => (
                        <li className="min-w-0 break-words [overflow-wrap:anywhere]" key={`${constraint.name}-${index}`}>
                          <code>{constraint.name}</code>: {constraint.constraints.join(" · ") || "—"}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="flex items-center justify-between text-[10px] text-[var(--color-faint)]">
                  <span>{t("本地只读扫描 · 上限 {v0} 项", { v0: report.scanLimit })}</span>
                  {report.truncated ? <span>{t("面板明细已截断")}</span> : null}
                </div>
              </>
            );
          })()}
        </div>
      ) : panel.id === "token-guard-panel" ? (
        (() => {
          const view = tokenGuardPanelView(data);
          const contextExceeded = view.percent !== null && view.percent >= view.maxPercent;
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div
                  className={`rounded-lg border px-3 py-3 ${contextExceeded ? "border-[#f4caca] bg-[var(--color-red-soft)]" : "border-[#e3eaf8] bg-[var(--color-blue-soft)]"}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("上下文预算")}</span>
                    <strong className="font-mono text-[12px] text-[var(--color-blue)]">
                      {view.percent === null ? "—" : view.percent}% / {view.maxPercent}%
                    </strong>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-blue-soft)]">
                    <div
                      className={`h-full rounded-full ${contextExceeded ? "bg-[#d64545]" : "bg-[#5d8bea]"}`}
                      style={{ width: `${Math.min(100, view.percent ?? 0)}%` }}
                    />
                  </div>
                  <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                    {view.tokens === null
                      ? t("上下文 token 未知")
                      : `${view.tokens.toLocaleString(formatLocale())} / ${view.contextWindow?.toLocaleString(formatLocale()) ?? "—"} tokens`}
                    {t(" · 已请求停止 {count} 次", { count: view.aborts })}
                  </p>
                </div>
                <div
                  className={`rounded-lg border px-3 py-3 ${view.runExceeded ? "border-[#f4caca] bg-[var(--color-red-soft)]" : "border-[#e3eaf8] bg-[var(--color-blue-soft)]"}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("本次运行已报告用量")}</span>
                    <strong className="font-mono text-[12px] text-[var(--color-blue)]">
                      {view.runTokens === null ? "—" : view.runTokens.toLocaleString(formatLocale())} /{" "}
                      {view.maxRunTokens === 0 ? "—" : view.maxRunTokens.toLocaleString(formatLocale())}
                    </strong>
                  </div>
                  <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                    {view.maxRunTokens > 0 ? t("按 SDK 已报告用量请求停止；单次请求仍可能超额，不代表账单上限。") : t("未启用绝对 Token 上限。")}
                  </p>
                </div>
              </div>
              {view.lastError === null ? null : (
                <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-2 text-[10px] leading-4 text-[var(--color-red)]">
                  {t("保护器错误：{v0}", { v0: view.lastError })}
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
              ? t("验证通过")
              : run?.status === "failed"
                ? t("验证失败")
                : run?.status === "timed-out"
                  ? t("验证超时")
                  : run?.status === "cancelled"
                    ? t("验证已取消")
                    : t("等待验证");
          const statusStyle =
            run?.status === "passed"
              ? "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"
              : run?.status === "failed"
                ? "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]"
                : run?.status === "timed-out" || run?.status === "cancelled"
                  ? "border-[#f1d7a8] bg-[var(--color-amber-soft)] text-[var(--color-amber)]"
                  : "border-[var(--color-line)] bg-[var(--color-soft)] text-[var(--color-faint)]";
          return (
            <div className="mt-3 grid min-w-0 gap-3">
              <div className={`min-w-0 rounded-lg border px-3 py-3 ${statusStyle}`}>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="break-all font-mono text-[11px] font-semibold text-[var(--color-ink)]">{run?.command ?? "npm run test"}</span>
                  <span className="rounded-full border border-current px-2 py-0.5 text-[9px] font-semibold">{statusLabel}</span>
                </div>
                {run === null ? (
                  <p className="mt-2 text-[11px] leading-4 text-[var(--color-faint)]">{t("还没有执行验证脚本。可让 Agent 调用 run_project_tests。")}</p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--color-muted)]">
                    <span className="w-full break-all">
                      {t("执行目录：")}
                      {run.cwd}
                    </span>
                    <span>exit {run.exitCode ?? "—"}</span>
                    {run.signal === null ? null : <span>{run.signal}</span>}
                    <span>{run.durationMs} ms</span>
                    <span>{run.outputBytes.toLocaleString(formatLocale())} output bytes</span>
                  </div>
                )}
              </div>
              {run !== null && run.output !== "" ? (
                <div className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[#111318] p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[9px] text-[#9ba6b2]">
                    <span className="font-semibold uppercase tracking-[0.08em]">{t("输出末尾")}</span>
                    <span>{t("最多 {v0} bytes", { v0: view.limits.outputBytes })}</span>
                  </div>
                  <pre className="max-h-52 min-w-0 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-4 text-[#e6edf3]">
                    {run.output}
                  </pre>
                </div>
              ) : null}
              {run?.outputTruncated ? <p className="text-[10px] leading-4 text-[var(--color-amber)]">{t("输出只保留最后 12 KiB。")}</p> : null}
              {run?.outputSanitized ? <p className="text-[10px] leading-4 text-[var(--color-amber)]">{t("终端控制字符已清理。")}</p> : null}
              <div className="flex flex-wrap gap-2">
                {view.allowedScripts.map((script) => (
                  <span
                    className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]"
                    key={script}
                  >
                    {script}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-[var(--color-faint)]">
                <span>timeout {view.limits.timeoutMs} ms</span>
                <span>output {view.limits.outputBytes} bytes</span>
              </div>
              {view.truncated ? <p className="text-[10px] leading-4 text-[var(--color-amber)]">{t("面板数据不完整或已按固定安全上限调整。")}</p> : null}
              <p className="rounded-lg border border-[#f1d7a8] bg-[var(--color-amber-soft)] px-3 py-2 text-[10px] leading-4 text-[var(--color-amber)]">
                {t("npm scripts 会执行当前项目定义的代码；仅在可信 workspace 中使用。Test Harness 不是沙箱，也不会把脚本输出当作用户授权。")}
              </p>
            </div>
          );
        })()
      ) : panel.id === "session-insights-panel" ? (
        (() => {
          const view = sessionInsightsPanelView(panel.data, activeSessionId);
          const report = view.report;
          if (report === null)
            return (
              <div className="mt-3 rounded-lg border border-[#f3c4c4] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] leading-5 text-[var(--color-red)]">
                {t("会话统计数据无效，已停止展示指标，避免把损坏数据误报为健康状态。")}
              </div>
            );
          const contextUsage = report.contextUsage;
          const compactionLabels = {
            idle: t("尚未请求压缩"),
            queued: t("等待 Agent 空闲"),
            running: t("正在压缩"),
            completed: t("压缩已完成"),
            failed: t("压缩失败"),
            cancelled: t("压缩已取消"),
            unknown: t("压缩状态数据无效"),
          } as const;
          const compactionStyles = {
            idle: "border-[var(--color-line)] bg-[var(--color-soft)] text-[var(--color-faint)]",
            queued: "border-[#f1d7a8] bg-[var(--color-amber-soft)] text-[var(--color-amber)]",
            running: "border-[#cbdaf6] bg-[var(--color-blue-soft)] text-[var(--color-blue)]",
            completed: "border-[#bfe4cb] bg-[var(--color-green-soft)] text-[var(--color-green)]",
            failed: "border-[#f3c4c4] bg-[var(--color-red-soft)] text-[var(--color-red)]",
            cancelled: "border-[#f1d7a8] bg-[var(--color-amber-soft)] text-[var(--color-amber)]",
            unknown: "border-[#f3c4c4] bg-[var(--color-red-soft)] text-[var(--color-red)]",
          } as const;
          return (
            <div className="mt-3 grid min-w-0 gap-3">
              <p className="text-[10px] text-[var(--color-faint)]">
                {t("消息与用量累计整份日志（含历史分支及压缩），不等于当前上下文；成本为 SDK 报告值，不是账单。")}
              </p>
              <div className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
                <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-faint)]">Session</span>
                <p className="mt-1 min-w-0 break-all font-mono text-[10px] leading-4 text-[var(--color-ink)]">{report.sessionId}</p>
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-2 min-[360px]:grid-cols-3">
                {[
                  [t("消息"), report.totalMessages.toLocaleString("en-US")],
                  [t("工具调用 / 结果"), `${report.toolCalls.toLocaleString("en-US")} / ${report.toolResults.toLocaleString("en-US")}`],
                  [t("SDK 成本"), `$${report.cost.toFixed(4)}`],
                ].map(([label, item]) => (
                  <div className="min-w-0 rounded-lg bg-[var(--color-soft)] px-3 py-2" key={label}>
                    <span className="block text-[10px] text-[var(--color-faint)]">{label}</span>
                    <strong className="mt-1 block break-all text-[16px] font-semibold text-[var(--color-ink)]">{item}</strong>
                  </div>
                ))}
              </div>
              <div className="min-w-0 rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-3">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("累计 token")}</span>
                  <strong className="break-all font-mono text-[14px] text-[var(--color-blue)]">{report.tokens.total.toLocaleString("en-US")}</strong>
                </div>
                <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[10px] leading-4 text-[var(--color-muted)]">
                  <span>{t("输入 {v0}", { v0: report.tokens.input.toLocaleString("en-US") })}</span>
                  <span>{t("输出 {v0}", { v0: report.tokens.output.toLocaleString("en-US") })}</span>
                  <span>{t("缓存读取 {v0}", { v0: report.tokens.cacheRead.toLocaleString("en-US") })}</span>
                  <span>{t("缓存写入 {v0}", { v0: report.tokens.cacheWrite.toLocaleString("en-US") })}</span>
                </div>
              </div>
              <div className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("当前上下文")}</span>
                  {contextUsage === null ? null : contextUsage.percent === null ? (
                    <strong className="text-[11px] font-semibold text-[var(--color-amber)]">{t("待下一次模型响应")}</strong>
                  ) : (
                    <strong className="font-mono text-[12px] text-[var(--color-blue)]">{contextUsage.percent.toFixed(1)}%</strong>
                  )}
                </div>
                {contextUsage === null ? (
                  <p className="mt-2 text-[10px] leading-4 text-[var(--color-faint)]">{t("当前模型未提供上下文窗口。")}</p>
                ) : contextUsage.tokens === null ? (
                  <p className="mt-2 text-[10px] leading-4 text-[var(--color-faint)]">
                    {t("压缩后 token 暂不可估算 · 上下文窗口 {v0}", { v0: contextUsage.contextWindow.toLocaleString("en-US") })}
                  </p>
                ) : (
                  <p className="mt-2 text-[10px] leading-4 text-[var(--color-faint)]">
                    {contextUsage.tokens.toLocaleString("en-US")} / {contextUsage.contextWindow.toLocaleString("en-US")} tokens
                  </p>
                )}
              </div>
              <div className={`min-w-0 rounded-lg border px-3 py-3 ${compactionStyles[view.compaction.status]}`}>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em]">{t("会话压缩")}</span>
                  <strong className="text-[11px] font-semibold">{compactionLabels[view.compaction.status]}</strong>
                </div>
                {view.compaction.error === null ? null : <p className="mt-2 break-words text-[10px] leading-4">{view.compaction.error}</p>}
              </div>
              {view.malformed && view.compaction.status !== "unknown" ? (
                <p className="text-[10px] leading-4 text-[var(--color-red)]">{t("面板数据不完整或不一致。")}</p>
              ) : null}
            </div>
          );
        })()
      ) : panel.id === "session-bridge-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const view = sessionBridgePanelView(data);
            const sections: readonly [string, string][] = [
              [t("目标"), view.preview.goal],
              [t("当前状态"), view.preview.currentState],
              [t("下一步"), view.preview.nextStep],
            ];
            const lists: readonly (readonly [string, readonly string[]])[] = [
              [t("关键决策"), view.preview.decisions],
              [t("关键文件"), view.preview.keyFiles],
            ];
            return (
              <>
                <div className="rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3 text-[11px] leading-5 text-[var(--color-blue)]">
                  {t("预览不会创建目标会话，也不会修改源会话。运行中的导入先排队，当前轮结束后追加到会话，后续模型轮可见；排队不代表已保存。")}
                </div>
                {view.status.state === "failed" || view.status.state === "cancelled" ? (
                  <div
                    className={`rounded-lg border px-3 py-3 text-[11px] leading-5 ${
                      view.status.state === "failed"
                        ? "border-[#f3c4c4] bg-[var(--color-red-soft)] text-[var(--color-red)]"
                        : "border-[#f4d8a8] bg-[var(--color-amber-soft)] text-[var(--color-amber)]"
                    }`}
                  >
                    {view.status.operation === "import"
                      ? view.status.state === "failed"
                        ? t("导入失败")
                        : t("导入已取消")
                      : view.status.operation === "export"
                        ? view.status.state === "failed"
                          ? t("导出失败")
                          : t("导出已取消")
                        : view.status.state === "failed"
                          ? t("预览失败")
                          : t("预览已取消")}
                    {view.status.error === null ? null : <p className="mt-1">{t("原因：{v0}", { v0: view.status.error })}</p>}
                  </div>
                ) : null}
                {sections.map(([label, item]) => (
                  <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3" key={label}>
                    <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-faint)]">{label}</span>
                    <p className="mt-2 min-w-0 whitespace-pre-wrap text-[11px] leading-5 text-[var(--color-ink)] [overflow-wrap:anywhere]">
                      {item || t("暂无")}
                    </p>
                  </div>
                ))}
                <div className="grid gap-2 sm:grid-cols-2">
                  {lists.map(([label, items]) => (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3" key={value(label)}>
                      <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-faint)]">{value(label)}</span>
                      {items.length > 0 ? (
                        <ul className="mt-2 grid gap-1 text-[10px] leading-4 text-[var(--color-muted)]">
                          {items.map((item, index) => (
                            <li className="min-w-0 [overflow-wrap:anywhere]" key={`${item}-${index}`}>
                              {item}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-[10px] text-[var(--color-faint)]">{t("暂无")}</p>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 text-[10px] text-[var(--color-faint)]">
                  <span>{t("格式 v{v0}", { v0: view.formatVersion })}</span>
                  <span>{t("最多 {v0} 条消息", { v0: view.limits.messages })}</span>
                  <span>{t("正文 {v0} 字符", { v0: view.limits.totalMessageCharacters })}</span>
                  <span>{t("附件标记 {v0} 个", { v0: view.limits.attachments })}</span>
                  {view.source !== null ? (
                    <span className="max-w-full truncate">
                      {t("来源")} {view.source.sessionId}
                    </span>
                  ) : null}
                  {view.latest !== null ? <span>{view.latest.direction === "import" ? t("最近导入请求") : t("最近导出")}</span> : null}
                </div>
              </>
            );
          })()}
        </div>
      ) : panel.id === "session-compare-panel" ? (
        <div className="mt-3 grid gap-3">
          <p className="text-[10px] text-[var(--color-faint)]">
            {t("按日志位置比较去除首尾空白的非空文本消息。差异列表每侧保留 40 条，每条预览最多 4,000 字符。")}
          </p>
          {data?.left && typeof data.left === "object" && data?.right && typeof data.right === "object" ? (
            (() => {
              const left = data.left as Record<string, unknown>;
              const right = data.right as Record<string, unknown>;
              return (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[
                      [t("左侧会话"), left],
                      [t("右侧会话"), right],
                    ].map(([label, session]) => {
                      const item = session as Record<string, unknown>;
                      return (
                        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3" key={value(label)}>
                          <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-faint)]">{value(label)}</span>
                          <strong className="mt-2 block truncate text-[12px] text-[var(--color-ink)]">{value(item.name ?? item.id)}</strong>
                          <code className="mt-1 block truncate text-[10px] text-[var(--color-blue)]">{value(item.id)}</code>
                          <span className="mt-1 block text-[10px] text-[var(--color-muted)]">{t("{v0} 条消息", { v0: value(item.messageCount, "0") })}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      [t("共享"), data.shared ?? 0],
                      [t("右侧新增"), data.addedCount ?? 0],
                      [t("左侧删除"), data.removedCount ?? 0],
                    ].map(([label, item]) => (
                      <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                        <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                        <strong className="mt-1 block text-[17px] font-semibold text-[var(--color-ink)]">{value(item)}</strong>
                      </div>
                    ))}
                  </div>
                  <div
                    className={`rounded-lg border px-3 py-3 text-[11px] ${data.changed === true ? "border-[#f4d8a8] bg-[var(--color-amber-soft)] text-[var(--color-amber)]" : "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"}`}
                  >
                    {data.changed === true ? t("两个会话的文本消息在对应位置存在差异。") : t("两个会话的文本消息投影一致；未比较图片、工具调用参数及元数据。")}
                  </div>
                  {data.addedTruncated === true || data.removedTruncated === true ? (
                    <p className="text-[11px] text-[var(--color-amber)]">{t("工具返回的差异预览已截断；上方计数仍为完整差异数量。")}</p>
                  ) : null}
                  {[
                    { key: "removed", label: t("左侧差异预览（最多显示 4 条）"), messages: data.removed },
                    { key: "added", label: t("右侧差异预览（最多显示 4 条）"), messages: data.added },
                  ].map(({ key, label, messages }) =>
                    Array.isArray(messages) && messages.length > 0 ? (
                      <div key={key} className="min-w-0 rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3">
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-faint)]">{label}</span>
                        <ul className="mt-2 grid gap-1 text-[10px] leading-4 text-[var(--color-muted)]">
                          {messages.slice(0, 4).map((item, index) => {
                            const message = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                            return (
                              <li className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]" key={`${value(message.role)}-${index}`}>
                                [{value(message.role)}] {value(message.text)}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null,
                  )}
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("执行 session_compare 后显示两个会话的差异。")}
            </div>
          )}
        </div>
      ) : panel.id === "secure-audit-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="grid grid-cols-4 gap-2">
            {[
              [t("扫描文件"), data?.scanned ?? 0],
              [t("严重"), data?.critical ?? 0],
              [t("高风险"), data?.high ?? 0],
              [t("总发现"), data?.total ?? 0],
            ].map(([label, item]) => (
              <div className="rounded-lg bg-[var(--color-soft)] px-2 py-2 text-center" key={value(label)}>
                <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                <strong className="mt-1 block text-[16px] font-semibold text-[var(--color-ink)]">{value(item)}</strong>
              </div>
            ))}
          </div>
          <div
            className={`rounded-lg border px-3 py-3 text-[11px] ${Number(data?.total ?? 0) > 0 ? "border-[#f4d8a8] bg-[var(--color-amber-soft)] text-[var(--color-amber)]" : "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"}`}
          >
            {data?.hasRun !== true ? t("尚未扫描。") : Number(data.total) > 0 ? t("发现需要人工确认的安全风险。") : t("本次扫描范围内未命中规则，不代表安全。")}
          </div>
          {data?.incomplete === true || data?.truncated === true ? (
            <p className="text-[10px] text-[var(--color-amber)]">
              {t("扫描或显示不完整：跳过 {v0} 个文件/目录，{v1} 行未检查通用凭据赋值；明细最多 200 项。", {
                v0: value(data.skipped),
                v1: value(data.credentialLinesSkipped),
              })}
            </p>
          ) : null}
          {Array.isArray(data?.findings) && data.findings.length > 0 ? (
            <div className="grid max-h-96 gap-2 overflow-auto">
              {data.findings.slice(0, 200).map((item, index) => {
                const finding = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                const severity = value(finding.severity, "medium");
                return (
                  <div
                    className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                    key={`${value(finding.path)}-${value(finding.line)}-${index}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <code className="min-w-0 truncate text-[10px] text-[var(--color-blue)]">{value(finding.path)}</code>
                      <span
                        className={`shrink-0 text-[10px] font-semibold ${severity === "critical" ? "text-[var(--color-red)]" : "text-[var(--color-amber)]"}`}
                      >
                        {severity}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-[var(--color-muted)]">
                      {t("第 {v0} 行 · {v1}", { v0: value(finding.line), v1: value(finding.message) })}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("运行 security_audit 后显示脱敏结果。")}
            </div>
          )}
        </div>
      ) : panel.id === "context-doctor-panel" ? (
        (() => {
          const view = contextDoctorPanelView(data, activeSessionId);
          if (view.malformed) return <p className="mt-3 text-[11px] text-[var(--color-red)]">{t("面板数据不完整或不一致。")}</p>;
          const compactionLabel = {
            idle: t("尚未请求"),
            queued: t("已排队"),
            running: t("压缩中"),
            completed: t("已完成"),
            failed: t("失败"),
            cancelled: t("已取消"),
            unknown: t("未知"),
          } as const;
          const compactionTone =
            view.compaction.status === "completed"
              ? "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"
              : view.compaction.status === "failed"
                ? "border-[#f3c4c4] bg-[var(--color-red-soft)] text-[var(--color-red)]"
                : view.compaction.status === "cancelled"
                  ? "border-[#f4d8a8] bg-[var(--color-amber-soft)] text-[var(--color-amber)]"
                  : "border-[#dce5f5] bg-[var(--color-blue-soft)] text-[var(--color-blue)]";
          return (
            <div className="mt-3 grid gap-3">
              <div
                className={`rounded-lg border px-3 py-3 text-[11px] ${
                  view.status === "warning"
                    ? "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]"
                    : view.status === "ok"
                      ? "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"
                      : "border-[var(--color-line)] bg-[var(--color-soft)] text-[var(--color-faint)]"
                }`}
              >
                {view.status === "warning" ? t("需要关注上下文风险。") : view.status === "ok" ? t("上下文状态正常。") : t("上下文状态不可用。")}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  [t("占用"), view.usagePercent === null ? "—" : `${view.usagePercent}%`],
                  [t("超限/不可测"), view.oversizedMessages],
                  [t("无法安全检查"), view.uninspectableMessages],
                  [t("工具错误"), view.toolErrors],
                ].map(([label, item]) => (
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2" key={String(label)}>
                    <span className="block text-[10px] text-[var(--color-faint)]">{label}</span>
                    <strong className="mt-1 block text-[17px] text-[var(--color-ink)]">{item}</strong>
                  </div>
                ))}
              </div>
              {view.compaction.status === "idle" || view.compaction.status === "unknown" ? null : (
                <div className={`rounded-lg border px-3 py-3 text-[11px] ${compactionTone}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span>{t("最近压缩")}</span>
                    <strong>{compactionLabel[view.compaction.status]}</strong>
                  </div>
                  {view.compaction.error === null ? null : <p className="mt-2 break-words text-[10px] leading-4">{view.compaction.error}</p>}
                </div>
              )}
              {view.recommendations.length > 0 ? (
                <ul className="grid gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-[10px] text-[var(--color-muted)]">
                  {view.recommendations.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                  {view.recommendationsTruncated ? <li>{t("部分建议因浏览器显示上限被省略。")}</li> : null}
                </ul>
              ) : null}
              <div className="flex flex-wrap gap-2 text-[10px] text-[var(--color-faint)]">
                <span className="rounded bg-[var(--color-soft)] px-2 py-1">
                  {t("扫描 {v0} / {v1} 条消息{v2}", { v0: view.scannedMessages, v1: view.messageCount, v2: view.messagesTruncated ? t("（已截断）") : "" })}
                </span>
                <span className="rounded bg-[var(--color-soft)] px-2 py-1">{t("告警阈值 {v0}%", { v0: view.warnPercent })}</span>
                <span className="rounded bg-[var(--color-soft)] px-2 py-1">{t("大消息阈值 {v0}B", { v0: view.maxMessageBytes })}</span>
                <span className="rounded bg-[var(--color-soft)] px-2 py-1">
                  {t("结构预算 {v0} 节点 / 深度 {v1}", { v0: view.limits.jsonNodesPerAudit, v1: view.limits.jsonDepth })}
                </span>
              </div>
            </div>
          );
        })()
      ) : panel.id === "history-compressor-panel" ? (
        (() => {
          const view = historyCompressorPanelView(panel.data, activeSessionId);
          if (view.malformed) return <p className="mt-3 text-[11px] text-[var(--color-red)]">{t("面板数据不完整或不一致。")}</p>;
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3">
                <span className="font-mono text-[11px] text-[var(--color-ink)]">{view.enabled ? t("自动压缩已启用") : t("自动压缩已停用")}</span>
                <strong className="font-mono text-[11px] text-[var(--color-blue)]">{t("阈值 {v0}%", { v0: view.thresholdPercent ?? "—" })}</strong>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                  <span className="block text-[10px] text-[var(--color-faint)]">{t("已压缩")}</span>
                  <strong className="mt-1 block text-[17px] text-[var(--color-ink)]">{view.compactions}</strong>
                </div>
                <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                  <span className="block text-[10px] text-[var(--color-faint)]">{t("当前占用")}</span>
                  <strong className="mt-1 block text-[17px] text-[var(--color-ink)]">
                    {view.lastUsagePercent === null ? "—" : `${view.lastUsagePercent}%`}
                  </strong>
                </div>
              </div>
              {view.lastError ? <p className="text-[11px] text-[var(--color-red)]">{t("最近错误：{v0}", { v0: view.lastError })}</p> : null}
            </div>
          );
        })()
      ) : panel.id === "session-export-panel" ? (
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3">
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const latest = data.latest as Record<string, unknown>;
              return (
                <div className="min-w-0 rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3">
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-faint)]">{t("最近导出")}</span>
                  <code className="mt-2 block whitespace-pre-wrap text-[11px] text-[var(--color-blue)] [overflow-wrap:anywhere]">
                    {value(latest.path ?? "pi-session.md")}
                  </code>
                  <p className="mt-1 text-[10px] text-[var(--color-muted)]">
                    {t("{v0} 个文本段 · {v1} bytes", { v0: value(latest.messages ?? 0), v1: value(latest.bytes ?? 0) })}
                  </p>
                  <dl className="mt-2 grid gap-1 text-[10px] text-[var(--color-muted)]">
                    <dt>{t("会话")}</dt>
                    <dd className="break-all font-mono">{value(latest.sessionId, "—")}</dd>
                    <dt>{t("工作区：")}</dt>
                    <dd className="break-all font-mono">{value(latest.workspace, "—")}</dd>
                  </dl>
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("还没有导出当前会话。")}
            </div>
          )}
          <p className="text-[10px] leading-4 text-[var(--color-faint)]">
            {t("导出调用开始时的会话文本快照，不包含图片、思考块和工具调用参数。文件写入该会话工作区内的 .md 路径，覆盖需要显式确认，权限为 0600。")}
          </p>
        </div>
      ) : panel.id === "session-search-panel" ? (
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3">
          <p className="text-[10px] leading-4 text-[var(--color-faint)]">
            {t("只搜索持久化日志中的用户和助手文本，包含历史分支；不含图片、思考或工具输出。以下为最近一次搜索，最多显示 8 个会话。")}
          </p>
          {data?.query ? (
            <p className="text-[10px] leading-4 text-[var(--color-faint)]">
              {t("已扫描 {v0} 个文件，跳过 {v1} 个；{v2}。跳过的文件不计入匹配结果。", {
                v0: value(data.scanned),
                v1: value(data.skipped),
                v2: data.truncated ? t("扫描范围或结果预览已截断") : t("未触及扫描或预览上限"),
              })}
            </p>
          ) : null}
          {data?.query ? (
            <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3">
              <code className="min-w-0 truncate text-[11px] text-[var(--color-blue)]">{value(data.query)}</code>
              <strong className="ml-3 shrink-0 text-[11px] text-[var(--color-blue)]">
                {t(typeof data.nextCursor === "string" || data.nextCursor === null ? "本页匹配 {v0} 个会话" : "{v0} 个会话", { v0: value(data.total ?? 0) })}
              </strong>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("输入查询后显示匹配的历史会话。")}
            </div>
          )}
          {data?.query && typeof data.nextCursor === "string" && data.nextCursor.length > 0 ? (
            <div className="grid min-w-0 gap-2 text-[10px] leading-4 text-[var(--color-muted)]">
              <p>{t("还有未扫描的会话。即使本页没有匹配，也可使用相同查询和 nextCursor 继续搜索。")}</p>
              <code className="block break-all whitespace-pre-wrap rounded-lg bg-[var(--color-soft)] p-2">
                {JSON.stringify({ query: data.query, cursor: data.nextCursor })}
              </code>
            </div>
          ) : data?.query && data.nextCursor === null ? (
            <p className="text-[10px] leading-4 text-[var(--color-faint)]">{t("目录扫描已结束；跳过的文件和省略的预览不代表已完整检查。")}</p>
          ) : null}
          {Array.isArray(data?.items) && data.items.length > 0 ? (
            <div className="grid min-w-0 grid-cols-1 gap-2">
              {data.items.slice(0, 8).map((item, index) => {
                const session = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                const hits = Array.isArray(session.hits) ? session.hits : [];
                return (
                  <div
                    className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                    key={`${value(session.id ?? "session")}-${index}`}
                  >
                    <strong className="block truncate text-[11px] text-[var(--color-ink)]">{value(session.name ?? session.id ?? t("未命名会话"))}</strong>
                    <p className="mt-1 text-[10px] text-[var(--color-faint)]">
                      {t("{v0} 条匹配消息 · 返回 {v1} 条预览", { v0: value(session.totalHits), v1: hits.length })}
                    </p>
                    <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-[10px] leading-4 text-[var(--color-muted)] [overflow-wrap:anywhere]">
                      {hits
                        .map((hit) => (hit !== null && typeof hit === "object" ? value((hit as Record<string, unknown>).text ?? "") : value(hit)))
                        .join(" | ")}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : data?.query ? (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("已扫描范围内没有匹配的用户或助手文本。")}
            </div>
          ) : null}
        </div>
      ) : panel.id === "session-bookmarks-panel" ? (
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3">
            <span className="text-[11px] text-[var(--color-muted)]">{t("当前会话书签")}</span>
            <strong className="font-mono text-[11px] text-[var(--color-blue)]">{t("{v0} 个书签", { v0: value(data?.total ?? 0) })}</strong>
          </div>
          {Array.isArray(data?.bookmarks) && data.bookmarks.length > 0 ? (
            <div className="grid max-h-96 min-w-0 grid-cols-1 gap-2 overflow-y-auto">
              {data.bookmarks.map((item, index) => {
                const bookmark = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div
                    className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                    key={`${value(bookmark.id ?? "bookmark")}-${index}`}
                  >
                    <strong className="block whitespace-pre-wrap text-[11px] text-[var(--color-ink)] [overflow-wrap:anywhere]">
                      {value(bookmark.label ?? t("未命名书签"))}
                    </strong>
                    <code className="mt-1 block whitespace-pre-wrap text-[10px] text-[var(--color-faint)] [overflow-wrap:anywhere]">
                      entry: {value(bookmark.entryId ?? "—")}
                    </code>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("还没有标记重要节点。")}
            </div>
          )}
          <p className="text-[10px] leading-4 text-[var(--color-faint)]">{t("书签以标签追加到 Pi 原生会话记录，不修改已有消息；内存会话不会落盘。")}</p>
        </div>
      ) : panel.id === "llm-verifier-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3">
            <span className="text-[11px] text-[var(--color-muted)]">{t("校验模型")}</span>
            <code className="max-w-[65%] truncate text-[11px] text-[var(--color-blue)]">
              {value(data?.provider ?? "—")}/{value(data?.model ?? "—")}
            </code>
          </div>
          {data?.history && typeof data.history === "object"
            ? (() => {
                const history = data.history as Record<string, unknown>;
                const counts = history.counts && typeof history.counts === "object" ? (history.counts as Record<string, unknown>) : {};
                return (
                  <div className="grid grid-cols-4 gap-2">
                    <div className="rounded-lg bg-[var(--color-soft)] px-2 py-2 text-center">
                      <span className="block text-[10px] text-[var(--color-faint)]">{t("累计")}</span>
                      <strong className="mt-1 block text-[15px] text-[var(--color-ink)]">{value(history.total ?? 0)}</strong>
                    </div>
                    <div className="rounded-lg bg-[var(--color-green-soft)] px-2 py-2 text-center">
                      <span className="block text-[10px] text-[var(--color-green)]">{t("通过")}</span>
                      <strong className="mt-1 block text-[15px] text-[var(--color-green)]">{value(counts.pass ?? 0)}</strong>
                    </div>
                    <div className="rounded-lg bg-[var(--color-red-soft)] px-2 py-2 text-center">
                      <span className="block text-[10px] text-[var(--color-red)]">{t("失败")}</span>
                      <strong className="mt-1 block text-[15px] text-[var(--color-red)]">{value(counts.fail ?? 0)}</strong>
                    </div>
                    <div className="rounded-lg bg-[var(--color-amber-soft)] px-2 py-2 text-center">
                      <span className="block text-[10px] text-[var(--color-amber)]">{t("未知")}</span>
                      <strong className="mt-1 block text-[15px] text-[var(--color-amber)]">{value(counts.unknown ?? 0)}</strong>
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
                  className={`rounded-lg border px-3 py-3 text-[11px] ${verdict === "pass" ? "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]" : verdict === "fail" ? "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]" : "border-[#f3dfab] bg-[var(--color-amber-soft)] text-[var(--color-amber)]"}`}
                >
                  <div className="flex items-center justify-between">
                    <strong className="uppercase">{verdict}</strong>
                    <span className="font-mono text-[10px]">{value(latest.evidenceChars ?? 0)} chars</span>
                  </div>
                  <p className="mt-2 leading-4">{value(latest.rationale ?? t("没有返回校验理由。"))}</p>
                  <p className="mt-2 truncate text-[10px] opacity-70">{t("声明：{v0}", { v0: value(latest.claim ?? "—") })}</p>
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("还没有执行模型校验。")}
            </div>
          )}
          <p className="text-[10px] leading-4 text-[var(--color-faint)]">{t("证据按不可信数据处理，输入有长度上限；模型返回非结构化结果时显示 unknown。")}</p>
        </div>
      ) : panel.id === "module-search-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const latest = data.latest as Record<string, unknown>;
              const matches = Array.isArray(latest.matches) ? latest.matches : [];
              return (
                <>
                  <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3">
                    <code className="min-w-0 truncate text-[11px] text-[var(--color-blue)]">{value(latest.query ?? "")}</code>
                    <strong className="ml-3 shrink-0 text-[11px] text-[var(--color-blue)]">{t("{v0} 个结果", { v0: value(matches.length) })}</strong>
                  </div>
                  {latest.truncated === true || (typeof latest.skippedFiles === "number" && latest.skippedFiles > 0) ? (
                    <p className="text-[10px] text-[var(--color-amber)]">{t("结果不完整：已达到扫描、读取或结果上限，存在跳过文件，或匹配片段已裁剪。")}</p>
                  ) : null}
                  {matches.length > 0 ? (
                    <div className="grid gap-2">
                      {matches.slice(0, 10).map((item, index) => {
                        const match = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                        return (
                          <div
                            className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                            key={`${value(match.path ?? "module")}:${value(match.line ?? index)}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <code className="min-w-0 truncate text-[10px] text-[var(--color-blue)]">
                                {value(match.path ?? "—")}:{value(match.line ?? "—")}
                              </code>
                              <span className="shrink-0 text-[10px] uppercase text-[var(--color-faint)]">{value(match.kind ?? "symbol")}</span>
                            </div>
                            <p className="mt-1 truncate text-[10px] text-[var(--color-muted)]">{value(match.name ?? t("未命名符号"))}</p>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                      {t("没有找到匹配的模块符号。")}
                    </div>
                  )}
                  <p className="text-[10px] leading-4 text-[var(--color-faint)]">
                    {t("扫描 {v0} 个源码文件，跳过依赖和构建目录。", { v0: value(latest.scannedFiles ?? 0) })}
                  </p>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("输入符号名后显示模块检索结果。")}
            </div>
          )}
        </div>
      ) : panel.id === "better-sidebar-panel" ? (
        (() => {
          const view = betterSidebarPanelView(data, activeSessionId);
          if (view.malformed) {
            return (
              <div className="mt-3 rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("Better Sidebar 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不一致。")}</span>
              </div>
            );
          }
          return (
            <div className="mt-3 grid min-w-0 grid-cols-1 gap-3">
              <div className="rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <code className="min-w-0 whitespace-pre-wrap text-[11px] text-[var(--color-blue)] [overflow-wrap:anywhere]">{view.cwd}</code>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${view.clean ? "bg-[var(--color-green-soft)] text-[var(--color-green)]" : view.gitAvailable ? "bg-[var(--color-red-soft)] text-[var(--color-red)]" : "bg-[var(--color-soft)] text-[var(--color-faint)]"}`}
                  >
                    {!view.gitAvailable ? t("不可用") : view.clean ? "clean" : t("{count} 个变更", { count: view.changedCount })}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap font-mono text-[10px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
                  {view.gitAvailable ? (view.branch ?? "detached HEAD") : betterSidebarGitFailureText(view.gitFailureReason)}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-[10px] text-[var(--color-faint)] [overflow-wrap:anywhere]">
                  {t("会话 {v0} · 目录 {v1} · 文件 {v2}", {
                    v0: view.sessionId,
                    v1: view.directoryCount,
                    v2: view.fileCount,
                  })}
                </p>
              </div>
              {view.changedFiles.length > 0 ? (
                <div
                  aria-label={t("工作区 Git 变更")}
                  className="grid max-h-[40rem] min-w-0 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-blue)]"
                  tabIndex={0}
                >
                  <p className="text-[10px] text-[var(--color-faint)]">
                    {t("显示 {v0} / {v1} 个变更", { v0: Math.min(view.changedFiles.length, 8), v1: view.changedCount })}
                  </p>
                  {view.changedFiles.slice(0, 8).map((entry) => (
                    <code
                      className="whitespace-pre-wrap py-0.5 text-[10px] text-[var(--color-muted)] [overflow-wrap:anywhere]"
                      key={`${entry.status}\0${entry.path}`}
                    >
                      {entry.status} {entry.originalPath === undefined ? "" : `${entry.originalPath} → `}
                      {entry.path}
                    </code>
                  ))}
                </div>
              ) : null}
              {view.truncated ? <p className="text-[10px] text-[var(--color-faint)]">{t("概览包含截断的结果，显示数量与总数见上方。")}</p> : null}
            </div>
          );
        })()
      ) : panel.id === "workspace-navigator-panel" ? (
        (() => {
          const view = workspaceNavigatorPanelView(data);
          if (view.malformed) {
            return (
              <div className="mt-3 rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("Workspace Navigator 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不一致。")}</span>
              </div>
            );
          }
          const latest = view.latest;
          const git = view.git;
          return (
            <div className="mt-3 grid min-w-0 gap-3">
              <p className="whitespace-pre-wrap text-[10px] text-[var(--color-faint)] [overflow-wrap:anywhere]">
                {t("工作区：")}
                {view.cwd}
              </p>
              {latest !== null ? (
                <>
                  <div className="flex min-w-0 items-start justify-between gap-2 rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3">
                    <code className="min-w-0 whitespace-pre-wrap text-[11px] text-[var(--color-blue)] [overflow-wrap:anywhere]">{latest.path}</code>
                    <strong className="shrink-0 text-[11px] text-[var(--color-blue)]">{t("{v0} 个节点", { v0: latest.nodes.length })}</strong>
                  </div>
                  {latest.nodes.length > 0 ? (
                    <ul
                      aria-label={t("工作区目录树节点")}
                      className="grid max-h-[40rem] min-w-0 gap-1 overflow-y-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-blue)]"
                      role="tree"
                      tabIndex={0}
                    >
                      {latest.nodes.map((node) => (
                        <li
                          aria-label={`${node.kind === "directory" ? t("目录") : t("文件")}：${node.path}`}
                          aria-level={node.depth}
                          className="flex min-w-0 items-start gap-2 py-1 text-[10px] text-[var(--color-muted)]"
                          key={node.path}
                          role="treeitem"
                        >
                          <span className="shrink-0 text-[var(--color-faint)]">
                            {"· ".repeat(node.depth - 1)}
                            {node.kind === "directory" ? "▾" : "·"}
                          </span>
                          <code className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{node.path}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                      {t("当前目录为空。")}
                    </div>
                  )}
                  <p className="text-[10px] leading-4 text-[var(--color-faint)]">
                    {t("目录 {v0} 个，文件 {v1} 个；跳过依赖和构建目录。", { v0: latest.directoryCount, v1: latest.fileCount })}
                  </p>
                  <p className="text-[10px] leading-4 text-[var(--color-faint)]">
                    {t("已扫描 {v0} 个目录条目 · 深度上限 {v1} · 节点上限 {v2}", {
                      v0: latest.scannedEntries,
                      v1: latest.maxDepth,
                      v2: latest.maxNodes,
                    })}
                  </p>
                  {latest.truncated ? (
                    <p className="text-[10px] text-[var(--color-amber)]">{t("目录树结果不完整：已达到发现、深度、节点或序列化上限。")}</p>
                  ) : null}
                </>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("执行 workspace_tree 后显示工作区结构。")}
                </div>
              )}
              {git !== null ? (
                <div className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-[var(--color-ink)]">{t("Git 状态")}</span>
                    <span
                      className={`shrink-0 text-[10px] ${!git.available ? "text-[var(--color-faint)]" : git.clean ? "text-[var(--color-green)]" : "text-[var(--color-red)]"}`}
                    >
                      {!git.available ? t("不可用") : git.clean ? "clean" : t("{count} 个变更", { count: git.changedCount })}
                    </span>
                  </div>
                  {git.available ? (
                    <p className="mt-1 whitespace-pre-wrap font-mono text-[10px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
                      {git.branch ?? "detached HEAD"}
                    </p>
                  ) : (
                    <p className="mt-1 text-[10px] leading-4 text-[var(--color-faint)]">
                      {git.failureReason === "not-repository"
                        ? t("当前工作区不在 Git 仓库中。")
                        : git.failureReason === "timeout"
                          ? t("Git 状态读取超时；请提高 gitTimeoutMs 或缩小工作区。")
                          : git.failureReason === "git-unavailable"
                            ? t("未找到 Git 可执行文件。")
                            : git.failureReason === "output-limit"
                              ? t("Git 输出超过安全上限；请缩小工作区。")
                              : git.failureReason === "invalid-output"
                                ? t("Git 返回了无法安全解析的状态。")
                                : t("Git 状态读取失败。")}
                    </p>
                  )}
                  {git.truncated ? (
                    <p className="text-[10px] text-[var(--color-amber)]">
                      {t("Git 结果不完整：显示 {v0} / {v1} 个变更。", { v0: git.entries.length, v1: git.changedCount })}
                    </p>
                  ) : null}
                  {git.entries.length > 0 ? (
                    <ul
                      aria-label={t("工作区 Git 变更")}
                      className="mt-2 grid max-h-[40rem] min-w-0 gap-1 overflow-y-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-blue)]"
                      tabIndex={0}
                    >
                      {git.entries.map((entry) => (
                        <li className="min-w-0" key={`${entry.status}\0${entry.path}`}>
                          <code className="block min-w-0 whitespace-pre-wrap text-[10px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
                            {entry.status} {entry.originalPath === undefined ? "" : `${entry.originalPath} → `}
                            {entry.path}
                          </code>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })()
      ) : panel.id === "prompt-library-panel" ? (
        (() => {
          const view = promptLibraryPanelView(data);
          if (view.malformed) {
            return (
              <div className="mt-3 rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("Prompt Library 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不可信，请重新加载后再查询。")}</span>
              </div>
            );
          }
          return (
            <div className="mt-3 grid gap-3">
              {view.templates.length > 0 ? (
                <div className="grid max-h-[40rem] gap-2 overflow-y-auto">
                  {view.templates.map((template, index) => {
                    const tags = template.tags;
                    return (
                      <div className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3" key={`${template.id}-${index}`}>
                        <div className="grid min-w-0 gap-1">
                          <strong className="whitespace-pre-wrap text-[11px] text-[var(--color-ink)] [overflow-wrap:anywhere]">{template.title}</strong>
                          <code className="min-w-0 break-all text-[10px] text-[var(--color-faint)]">{template.id}</code>
                        </div>
                        <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-[10px] leading-4 text-[var(--color-muted)] [overflow-wrap:anywhere]">
                          {template.prompt}
                        </p>
                        {tags.length > 0 ? (
                          <div className="mt-2 flex min-w-0 flex-wrap gap-1">
                            {tags.map((tag) => (
                              <span
                                className="max-w-full whitespace-pre-wrap rounded bg-[var(--color-blue-soft)] px-1.5 py-0.5 text-[9px] text-[var(--color-blue)] [overflow-wrap:anywhere]"
                                key={tag}
                              >
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
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("还没有保存的提示词。可让 Agent 调用 prompt_library 保存模板。")}
                </div>
              )}
              {view.truncated ? (
                <p className="text-[10px] leading-4 text-[var(--color-amber)]">{t("列表已按安全上限截断，仅展示最近 {v0} 条有效记录。", { v0: view.shown })}</p>
              ) : null}
              <p className="text-[10px] leading-4 text-[var(--color-faint)]">{t("共 {v0} 个模板，数据跟随当前会话。", { v0: view.total })}</p>
            </div>
          );
        })()
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
                  <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3">
                    <span className="text-[11px] text-[var(--color-muted)]">{t("交接给")}</span>
                    <strong className="text-[11px] text-[var(--color-blue)]">{value(handoff.toRole)}</strong>
                  </div>
                  <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3 text-[11px] text-[var(--color-ink)]">
                    {value(handoff.objective)}
                  </div>
                  {handoff.context ? (
                    <p className="rounded-lg bg-[var(--color-soft)] px-3 py-2 text-[10px] leading-4 text-[var(--color-muted)]">{value(handoff.context)}</p>
                  ) : null}
                  {files.length > 0 ? (
                    <div className="grid gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
                      {files.map((file, index) => (
                        <code className="min-w-0 break-all text-[10px] text-[var(--color-muted)]" key={`${file}-${index}`}>
                          {file}
                        </code>
                      ))}
                    </div>
                  ) : null}
                  {constraints.length > 0 ? (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-amber-soft)] px-3 py-2">
                      <strong className="text-[10px] text-[var(--color-amber)]">{t("约束")}</strong>
                      <ul className="mt-1 grid gap-1 text-[10px] text-[var(--color-muted)]">
                        {constraints.map((constraint, index) => (
                          <li key={`${constraint}-${index}`}>• {constraint}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {acceptance.length > 0 ? (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-green-soft)] px-3 py-2">
                      <strong className="text-[10px] text-[var(--color-green)]">{t("验收条件")}</strong>
                      <ul className="mt-1 grid gap-1 text-[10px] text-[var(--color-muted)]">
                        {acceptance.map((criterion, index) => (
                          <li key={`${criterion}-${index}`}>• {criterion}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2 text-[10px] text-[var(--color-muted)]">
                    <span>{t("约束 {v0} 条", { v0: constraints.length })}</span>
                    <span>{t("验收 {v0} 条", { v0: acceptance.length })}</span>
                  </div>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("执行 colleague_handoff 后显示角色交接包。")}
            </div>
          )}
        </div>
      ) : panel.id === "reverse-skill-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3">
            <span className="text-[11px] text-[var(--color-muted)]">{t("复核风险内容的默认策略")}</span>
            <strong className="font-mono text-[11px] text-[var(--color-blue)]">{data?.allowReviewByDefault === true ? t("允许返回") : t("拒绝返回")}</strong>
          </div>
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const latest = data.latest as Record<string, unknown>;
              const risk = value(latest.risk);
              const findings = Array.isArray(latest.findings) ? latest.findings : [];
              return (
                <div
                  className={`rounded-lg border px-3 py-3 text-[11px] ${risk === "blocked" ? "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]" : risk === "review" ? "border-[#f3dfab] bg-[var(--color-amber-soft)] text-[var(--color-amber)]" : "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"}`}
                >
                  <div className="flex items-center justify-between">
                    <strong className="uppercase">{risk}</strong>
                    <span className="font-mono text-[10px]">{latest.contentIncluded === true ? t("已返回不可信文本") : t("未返回原文")}</span>
                  </div>
                  <p className="mt-2">{t("{v0} · {v1} 个风险项", { v0: value(latest.name ?? t("未命名 Skill")), v1: value(findings.length) })}</p>
                  {findings.length > 0 ? (
                    <p className="mt-1 text-[10px] opacity-80">
                      {findings
                        .slice(0, 2)
                        .map((item) => value((item as Record<string, unknown>).message))
                        .join(" · ")}
                    </p>
                  ) : null}
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("执行 skill_inject 后显示隔离结果。")}
            </div>
          )}
          <p className="text-[10px] leading-4 text-[var(--color-faint)]">
            {t("未命中规则不代表安全；review 默认不返回原文，blocked 始终拒绝。文本标记不是执行沙箱，也不会自动激活 Skill。")}
          </p>
        </div>
      ) : panel.id === "reviewer-bot-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.status === "running" ? (
            <p role="status" className="text-[11px] text-[var(--color-muted)]">
              {t("运行中")}
            </p>
          ) : null}
          {typeof data?.lastError === "string" && data.lastError.length > 0 ? (
            <p role="alert" className="break-words rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
              {t("操作失败：{v0}", { v0: data.lastError })}
            </p>
          ) : null}
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
              const status = value(report.status);
              const isError = (finding: unknown) =>
                typeof finding === "object" && finding !== null && (finding as Record<string, unknown>).severity === "error";
              const findings = Array.isArray(report.findings)
                ? [...(report.findings as unknown[])].sort((a, b) => Number(isError(b)) - Number(isError(a)))
                : [];
              return (
                <>
                  <code className="break-all text-[10px] text-[var(--color-faint)]">{value(report.cwd)}</code>
                  <div
                    className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${data.latestStale === true ? "border-[var(--color-line)] bg-[var(--color-soft)] text-[var(--color-muted)]" : status === "error" ? "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]" : status === "warning" ? "border-[#f3dfab] bg-[var(--color-amber-soft)] text-[var(--color-amber)]" : "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"}`}
                  >
                    <span>
                      {data.latestStale === true
                        ? t("上次成功结果（非本次审阅）")
                        : status === "error"
                          ? t("发现错误风险")
                          : status === "warning"
                            ? t("需要关注")
                            : t("未命中检查规则")}
                    </span>
                    <strong className="font-mono">{value(report.findingCount)} findings</strong>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      [t("文件"), report.changedFiles ?? 0],
                      [t("新增"), report.addedLines ?? 0],
                      [t("删除"), report.removedLines ?? 0],
                    ].map(([label, item]) => (
                      <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                        <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                        <strong className="mt-1 block text-[17px] text-[var(--color-ink)]">{value(item)}</strong>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-[var(--color-faint)]">
                    {t("仅检查相对 HEAD 的已跟踪改动；不含未跟踪文件，也不执行测试。显示 {v0}/{v1} 个风险项。", {
                      v0: Math.min(findings.length, 4),
                      v1: value(report.findingCount),
                    })}
                  </p>
                  {report.filesTruncated === true || report.findingsTruncated === true ? (
                    <p className="text-[10px] text-[var(--color-amber)]">{t("明细超过上限，结果已截断；总数仍包含全部检查结果。")}</p>
                  ) : null}
                  {findings.length > 0 ? (
                    <ul className="grid gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-[10px] text-[var(--color-muted)]">
                      {findings.slice(0, 4).map((finding, index) => {
                        const item = typeof finding === "object" && finding !== null ? (finding as Record<string, unknown>) : undefined;
                        return (
                          <li className="grid gap-1" key={index}>
                            {typeof item?.path === "string" ? <code className="break-all">{item.path}</code> : null}
                            {value(item?.message ?? finding)}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("还没有审查当前改动。可让 Agent 调用 review_changes。")}
            </div>
          )}
        </div>
      ) : panel.id === "auto-mode-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px]">
            <span className="font-medium text-[var(--color-ink)]">{data?.mode === "confirm" ? t("确认模式") : t("安全模式")}</span>
            <span className="font-mono text-[var(--color-muted)]">{t("超时 {v0} ms", { v0: value(data?.timeoutMs ?? "—") })}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
              <span className="block text-[10px] text-[var(--color-faint)]">{t("阻断次数")}</span>
              <strong className="mt-1 block text-[17px] text-[var(--color-ink)]">{t("{v0} 次", { v0: value(data?.blocked ?? 0) })}</strong>
            </div>
            <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
              <span className="block text-[10px] text-[var(--color-faint)]">{t("最近命令")}</span>
              <strong className="mt-1 block truncate font-mono text-[11px] text-[var(--color-ink)]">
                {data?.last && typeof data.last === "object" ? value((data.last as Record<string, unknown>).command ?? "—") : "—"}
              </strong>
            </div>
          </div>
          {data?.last && typeof data.last === "object" ? (
            <>
              <span
                className={`text-[11px] ${(data.last as Record<string, unknown>).exitCode === 0 ? "text-[var(--color-green)]" : "text-[var(--color-red)]"}`}
              >
                exit {value((data.last as Record<string, unknown>).exitCode ?? "—")}
              </span>
              <pre className="max-h-32 overflow-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 text-[10px] leading-4 text-[var(--color-muted)]">
                {[value((data.last as Record<string, unknown>).stdout, ""), value((data.last as Record<string, unknown>).stderr, "")]
                  .filter(Boolean)
                  .join("\n") || t("无输出")}
              </pre>
            </>
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("尚未执行命令。Agent 可调用 auto_mode_exec。")}
            </div>
          )}
        </div>
      ) : panel.id === "plan-execute-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3">
            <span className="truncate text-[11px] font-medium text-[var(--color-ink)]">{data?.title ? value(data.title) : t("尚未创建计划")}</span>
            <span className="font-mono text-[11px] text-[var(--color-blue)]">
              {value(data?.completed ?? 0)} / {value(data?.total ?? 0)}
            </span>
          </div>
          {Array.isArray(data?.steps) && data.steps.length > 0 ? (
            <ol className="grid gap-1.5">
              {data.steps.map((step, index) => {
                const item = step && typeof step === "object" ? (step as Record<string, unknown>) : {};
                const status = value(item.status ?? "pending");
                return (
                  <li
                    className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[11px]"
                    key={value(item.id ?? index)}
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${status === "done" ? "bg-[#32a35a]" : status === "in_progress" ? "bg-[#3565c5]" : status === "skipped" ? "bg-[#a0a7b0]" : "bg-[var(--color-blue-soft)]"}`}
                    />
                    <span className={`min-w-0 flex-1 truncate ${status === "done" ? "text-[var(--color-green)]" : "text-[var(--color-ink)]"}`}>
                      {value(item.title ?? t("步骤"))}
                    </span>
                    {Array.isArray(item.dependsOn) && item.dependsOn.length > 0 && (
                      <span className="text-[10px] text-[var(--color-faint)]">
                        {t("依赖步骤 {v0}", { v0: item.dependsOn.map((id) => value(id)).join(", ") })}
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-[var(--color-faint)]">{status}</span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("Agent 可调用 plan_create 创建执行计划。")}
            </div>
          )}
        </div>
      ) : panel.id === "plugin-stars-panel" ? (
        (() => {
          const view = pluginStarsPanelView(data);
          if (view.malformed) {
            return (
              <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("Plugin Stars 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不可信，请重新加载排行榜。")}</span>
              </div>
            );
          }
          const latest = view.latest;
          const rows = latest?.results ?? [];
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px]">
                <span className="font-medium text-[var(--color-ink)]">{t("社区排行榜")}</span>
                <span className="font-mono text-[var(--color-muted)]">{t("结果上限 {v0}", { v0: view.limit })}</span>
              </div>
              {latest !== null ? (
                <>
                  <div className="flex items-center justify-between text-[11px] text-[var(--color-muted)]">
                    <span>{t("查询：{v0}", { v0: latest.query || t("全部") })}</span>
                    <strong className="font-mono text-[var(--color-blue)]">
                      {t("显示 {v0}/{v1}", { v0: view.inventory.shown, v1: view.inventory.total })}
                    </strong>
                  </div>
                  {rows.length > 0 ? (
                    <ol className="grid gap-1.5">
                      {rows.map((row) => (
                        <li
                          className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                          key={row.fullName}
                        >
                          <span className="w-5 shrink-0 text-center font-mono text-[10px] text-[var(--color-amber)]">#{row.rank}</span>
                          <div className="min-w-0 flex-1">
                            <a
                              className="block truncate font-mono text-[11px] text-[var(--color-blue)] hover:underline"
                              href={row.htmlUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {row.fullName}
                            </a>
                            <span className="block truncate text-[10px] text-[var(--color-faint)]">{t("更新于 {v0}", { v0: row.updatedAt || t("未知") })}</span>
                          </div>
                          <span className="shrink-0 font-mono text-[10px] text-[var(--color-amber)]">★ {row.stars.toLocaleString(formatLocale())}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                      {t("没有找到匹配的社区插件。")}
                    </div>
                  )}
                  <p className="text-[10px] leading-4 text-[var(--color-faint)]">
                    {t("来源：{v0} · 仅展示公开仓库信息，不会自动安装。", { v0: latest.source })}
                  </p>
                </>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {view.source === ""
                    ? t("需要配置榜单来源 sourceUrl，尚未连接 Pi Harness 排行榜。")
                    : t("Agent 可调用 plugin_stars_search 拉取并筛选社区排行榜。")}
                </div>
              )}
            </div>
          );
        })()
      ) : panel.id === "plugin-finder-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px]">
            <span className="font-medium text-[var(--color-ink)]">{t("只读 Registry 搜索")}</span>
            <span className="font-mono text-[var(--color-muted)]">
              {t("关键词 {v0} · 上限 {v1}", { v0: value(data?.keyword ?? "pi-harness"), v1: value(data?.limit ?? "—") })}
            </span>
          </div>
          {data?.query ? (
            <>
              <div className="flex items-center justify-between text-[11px] text-[var(--color-muted)]">
                <span>{t("查询：{v0}", { v0: value(data.query) })}</span>
                <strong className="font-mono text-[var(--color-blue)]">{t("{v0} 个结果", { v0: value(data.total ?? 0) })}</strong>
              </div>
              {data?.truncated === true && <p className="text-[10px] text-[var(--color-faint)]">{t("仅显示部分匹配结果，请缩小查询范围。")}</p>}
              {Array.isArray(data?.results) && data.results.length > 0 ? (
                <ul className="grid max-h-96 gap-1.5 overflow-auto">
                  {data.results.slice(0, 25).map((result, index) => {
                    const item = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
                    return (
                      <li
                        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                        key={`${value(item.name ?? "plugin")}-${index}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <strong className="truncate font-mono text-[11px] text-[var(--color-ink)]">{value(item.name ?? t("未知插件"))}</strong>
                          <span className="font-mono text-[10px] text-[var(--color-faint)]">v{value(item.version ?? "—")}</span>
                        </div>
                        <p className="mt-1 truncate text-[10px] text-[var(--color-faint)]">{value(item.description, "")}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("没有找到匹配插件。")}
                </div>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("Agent 可调用 plugin_search 搜索 npm Registry。")}
            </div>
          )}
        </div>
      ) : panel.id === "memory-panel" ? (
        (() => {
          const view = memoryPanelView(data);
          if (view.malformed) {
            return (
              <div className="mt-3 rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("Memory 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不可信，请重新加载后再查询。")}</span>
              </div>
            );
          }
          const renderMemories = (memories: typeof view.memories, label: string) => (
            <ul aria-label={label} className="grid max-h-[40rem] gap-1.5 overflow-y-auto" tabIndex={0}>
              {memories.map((memory, index) => (
                <li className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2" key={`${memory.id}-${index}`}>
                  <strong className="block whitespace-pre-wrap font-mono text-[11px] text-[var(--color-ink)] [overflow-wrap:anywhere]">{memory.key}</strong>
                  <p
                    aria-label={memory.key}
                    className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-[10px] text-[var(--color-faint)] [overflow-wrap:anywhere]"
                    role="region"
                    tabIndex={0}
                  >
                    {memory.value}
                  </p>
                  {memory.tags.length > 0 ? (
                    <div className="mt-2 flex min-w-0 flex-wrap gap-1">
                      {memory.tags.map((tag) => (
                        <span
                          className="max-w-full whitespace-pre-wrap rounded bg-[var(--color-blue-soft)] px-1.5 py-0.5 text-[9px] text-[var(--color-blue)] [overflow-wrap:anywhere]"
                          key={tag}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          );
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px]">
                <span className="font-medium text-[var(--color-ink)]">{t("跨会话记忆")}</span>
                <span className="font-mono text-[var(--color-blue)]">{t("{v0} 条", { v0: view.count })}</span>
              </div>
              {view.memories.length > 0 ? (
                renderMemories(view.memories, t("跨会话记忆"))
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("尚未保存记忆。Agent 可调用 memory_set 明确写入。")}
                </div>
              )}
              {view.truncated ? (
                <p className="text-[10px] leading-4 text-[var(--color-amber)]">{t("列表已按安全上限截断，仅展示最近 {v0} 条有效记录。", { v0: view.shown })}</p>
              ) : null}
              {view.last !== null ? (
                <section className="grid gap-1.5 border-t border-[var(--color-line)] pt-3">
                  <div className="flex min-w-0 items-center justify-between gap-2 text-[11px]">
                    <span className="min-w-0 whitespace-pre-wrap text-[var(--color-muted)] [overflow-wrap:anywhere]">
                      {t("最近搜索：{v0}", { v0: view.last.query })}
                    </span>
                    <strong className="shrink-0 font-mono text-[var(--color-blue)]">{t("{v0} 条", { v0: `${view.last.shown} / ${view.last.total}` })}</strong>
                  </div>
                  {view.last.memories.length > 0 ? (
                    renderMemories(view.last.memories, t("最近搜索：{v0}", { v0: view.last.query }))
                  ) : (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                      {t("没有匹配项。")}
                    </div>
                  )}
                  {view.last.truncated ? (
                    <p className="text-[10px] leading-4 text-[var(--color-amber)]">{t("面板按固定安全上限展示；完整计数保留在上方。")}</p>
                  ) : null}
                </section>
              ) : null}
            </div>
          );
        })()
      ) : panel.id === "graph-memory-panel" ? (
        (() => {
          const report = graphMemoryPanelView(data);
          if (report.malformed) {
            return (
              <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("Graph Memory 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不可信，请重新加载后再查询。")}</span>
              </div>
            );
          }
          const kinds = report.kinds;
          const recent = report.recent;
          const recentRelations = report.recentRelations;
          const renderNodes = (entries: typeof recent, label: string) => (
            <ul aria-label={label} className="grid max-h-[40rem] gap-1.5 overflow-y-auto" tabIndex={0}>
              {entries.map((entry) => {
                const kindLabel = entry.kind === "task" ? t("任务") : entry.kind === "skill" ? t("技能") : t("事件");
                const kindClass =
                  entry.kind === "task"
                    ? "bg-[var(--color-blue-soft)] text-[var(--color-blue)]"
                    : entry.kind === "skill"
                      ? "bg-[var(--color-green-soft)] text-[var(--color-green)]"
                      : "bg-[var(--color-amber-soft)] text-[var(--color-amber)]";
                return (
                  <li className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2" key={entry.id}>
                    <div className="flex min-w-0 items-start gap-2">
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${kindClass}`}>{kindLabel}</span>
                      <strong className="min-w-0 flex-1 whitespace-pre-wrap text-[11px] text-[var(--color-ink)] [overflow-wrap:anywhere]">{entry.label}</strong>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap font-mono text-[9px] text-[var(--color-faint)] [overflow-wrap:anywhere]">{entry.id}</p>
                    <p className="mt-1 whitespace-pre-wrap font-mono text-[8px] text-[var(--color-faint)] [overflow-wrap:anywhere]">
                      {t("创建：{v0} · 更新：{v1}", { v0: entry.createdAt, v1: entry.updatedAt })}
                    </p>
                    <p
                      className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-[10px] leading-4 text-[var(--color-muted)] [overflow-wrap:anywhere]"
                      tabIndex={0}
                    >
                      {entry.summary}
                    </p>
                    {entry.source !== undefined ? (
                      <p className="mt-1 whitespace-pre-wrap font-mono text-[9px] text-[var(--color-faint)] [overflow-wrap:anywhere]">
                        {t("来源：{v0}", { v0: entry.source })}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          );
          const renderRelations = (
            entries: ReadonlyArray<{ id: string; from: string; to: string; relation: string; createdAt: string; fromLabel?: string; toLabel?: string }>,
            label: string,
          ) => (
            <div aria-label={label} className="grid max-h-[40rem] gap-1.5 overflow-y-auto" role="list" tabIndex={0}>
              {entries.map((entry) => (
                <div className="min-w-0 rounded border border-[var(--color-line)] bg-[var(--color-soft)] px-2 py-1.5" key={entry.id} role="listitem">
                  <p className="whitespace-pre-wrap font-mono text-[9px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
                    {entry.fromLabel ?? entry.from} <span className="text-[var(--color-blue)]">—{entry.relation}→</span> {entry.toLabel ?? entry.to}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap font-mono text-[8px] text-[var(--color-faint)] [overflow-wrap:anywhere]">{entry.id}</p>
                  <p className="mt-0.5 whitespace-pre-wrap font-mono text-[8px] text-[var(--color-faint)] [overflow-wrap:anywhere]">
                    {t("创建：{v0}", { v0: entry.createdAt })}
                  </p>
                </div>
              ))}
            </div>
          );
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-3 gap-2">
                {[
                  [t("任务"), kinds.task ?? 0, "bg-[#3565c5]"],
                  [t("技能"), kinds.skill ?? 0, "bg-[#22a06b]"],
                  [t("事件"), kinds.event ?? 0, "bg-[#d97706]"],
                ].map(([label, count, color]) => (
                  <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                    <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-faint)]">
                      <span className={`h-1.5 w-1.5 rounded-full ${value(color)}`}></span>
                      {value(label)}
                    </div>
                    <strong className="mt-1 block font-mono text-[17px] text-[var(--color-ink)]">{value(count)}</strong>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-2 text-[10px]">
                <span className="text-[var(--color-muted)]">{t("本地关系图")}</span>
                <span className="font-mono text-[var(--color-blue)]">{t("{v0} 节点 · {v1} 关系", { v0: report.nodes, v1: report.relations })}</span>
              </div>
              {recent.length > 0 ? (
                <section className="grid gap-1.5">
                  <span className="text-[9px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
                    {t("最近节点 {v0} / {v1}", { v0: recent.length, v1: report.nodes })}
                  </span>
                  {renderNodes(recent, t("最近节点"))}
                </section>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("尚未记录图记忆。Agent 可调用 graph_memory_record 创建任务、技能或事件节点。")}
                </div>
              )}
              {recentRelations.length > 0 ? (
                <div className="grid gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
                  <span className="text-[9px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
                    {t("最近关系 {v0} / {v1}", { v0: recentRelations.length, v1: report.relations })}
                  </span>
                  {renderRelations(recentRelations, t("最近关系"))}
                </div>
              ) : null}
              {report.lastSearch !== null ? (
                <section className="grid gap-2 border-t border-[var(--color-line)] pt-3">
                  <p className="whitespace-pre-wrap text-[10px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
                    {t("最近搜索：{v0}", { v0: report.lastSearch.query })}
                  </p>
                  <span className="text-[9px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
                    {t("搜索节点 {v0} / {v1}", { v0: report.lastSearch.nodes.length, v1: report.lastSearch.total })}
                  </span>
                  <p className="font-mono text-[9px] text-[var(--color-faint)]">
                    {t("节点页：偏移 {v0} · 下一偏移 {v1} · 已截断 {v2}", {
                      v0: report.lastSearch.offset,
                      v1: report.lastSearch.nextOffset ?? t("无"),
                      v2: report.lastSearch.nodesTruncated ? t("是") : t("否"),
                    })}
                  </p>
                  {report.lastSearch.nodes.length > 0 ? renderNodes(report.lastSearch.nodes, t("最近搜索节点")) : null}
                  <span className="text-[9px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
                    {t("搜索关系 {v0} / {v1}", { v0: report.lastSearch.relations.length, v1: report.lastSearch.relationsTotal })}
                  </span>
                  <p className="font-mono text-[9px] text-[var(--color-faint)]">
                    {t("关系页：偏移 {v0} · 下一偏移 {v1} · 已截断 {v2}", {
                      v0: report.lastSearch.relationsOffset,
                      v1: report.lastSearch.nextRelationsOffset ?? t("无"),
                      v2: report.lastSearch.relationsTruncated ? t("是") : t("否"),
                    })}
                  </p>
                  {report.lastSearch.relations.length > 0 ? renderRelations(report.lastSearch.relations, t("最近搜索关系")) : null}
                </section>
              ) : null}
              <div className="flex flex-wrap gap-2 font-mono text-[9px] text-[var(--color-faint)]">
                <span className="rounded bg-[var(--color-soft)] px-2 py-1">{t("节点 ≤ {v0}", { v0: report.limits.nodes })}</span>
                <span className="rounded bg-[var(--color-soft)] px-2 py-1">{t("关系 ≤ {v0}", { v0: report.limits.relations })}</span>
                <span className="rounded bg-[var(--color-soft)] px-2 py-1">{t("文件 ≤ {v0} B", { v0: report.limits.fileBytes })}</span>
              </div>
              {report.truncated ? <p className="text-[10px] text-[var(--color-amber)]">{t("面板内容已按安全显示上限截断。")}</p> : null}
            </div>
          );
        })()
      ) : panel.id === "taskboard-panel" ? (
        (() => {
          const view = taskboardPanelView(data);
          if (view.malformed) {
            return (
              <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("Taskboard 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不可信，请重新加载后再查询。")}</span>
              </div>
            );
          }
          const { counts, recent } = view;
          const lanes = [
            [t("待规划"), "backlog", "bg-[var(--color-blue-soft)] text-[var(--color-blue)]"],
            [t("阻塞"), "blocked", "bg-[var(--color-red-soft)] text-[var(--color-red)]"],
            [t("已取消"), "canceled", "bg-[var(--color-red-soft)] text-[var(--color-red)]"],
            [t("待办"), "todo", "bg-[var(--color-blue-soft)] text-[var(--color-blue)]"],
            [t("进行中"), "in_progress", "bg-[var(--color-amber-soft)] text-[var(--color-amber)]"],
            [t("待验收"), "in_review", "bg-[var(--color-blue-soft)] text-[var(--color-blue)]"],
            [t("已完成"), "done", "bg-[var(--color-green-soft)] text-[var(--color-green)]"],
          ] as const;
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-2 text-[10px]">
                <span className="text-[var(--color-muted)]">
                  {t("当前工作区任务：")}
                  {view.workspace}
                </span>
                <strong className="font-mono text-[var(--color-blue)]">{t("{v0} 个", { v0: view.total })}</strong>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {lanes.map(([label, key, color]) => (
                  <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-2" key={key}>
                    <div className="flex items-center justify-between text-[10px] text-[var(--color-faint)]">
                      <span>{label}</span>
                      <span className={`rounded px-1.5 py-0.5 ${color}`}>{value(counts[key] ?? 0)}</span>
                    </div>
                  </div>
                ))}
              </div>
              {recent.length > 0 ? (
                <ul className="grid max-h-[32rem] gap-1.5 overflow-y-auto">
                  <li className="text-[9px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
                    {t("最近任务 {v0} / {v1}", { v0: recent.length, v1: view.total })}
                  </li>
                  {recent.map((entry, index) => {
                    const task = entry;
                    const status = typeof task.status === "string" ? task.status : "unknown";
                    const priority = typeof task.priority === "string" ? task.priority : "medium";
                    const statusLabel =
                      status === "backlog"
                        ? t("待规划")
                        : status === "todo"
                          ? t("待办")
                          : status === "in_progress"
                            ? t("进行中")
                            : status === "in_review"
                              ? t("待验收")
                              : status === "blocked"
                                ? t("阻塞")
                                : status === "canceled"
                                  ? t("已取消")
                                  : status === "done"
                                    ? t("已完成")
                                    : t("未知");
                    const statusClass =
                      status === "done"
                        ? "bg-[var(--color-green-soft)] text-[var(--color-green)]"
                        : status === "blocked" || status === "canceled"
                          ? "bg-[var(--color-red-soft)] text-[var(--color-red)]"
                          : status === "unknown"
                            ? "bg-[var(--color-soft)] text-[var(--color-muted)]"
                            : "bg-[var(--color-blue-soft)] text-[var(--color-blue)]";
                    return (
                      <li
                        className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                        key={`${value(task.id ?? "task")}-${index}`}
                      >
                        <div className="flex min-w-0 items-start gap-2">
                          <code className="shrink-0 font-mono text-[10px] text-[var(--color-blue)]">{value(task.key ?? "PIH-?")}</code>
                          <strong className="min-w-0 flex-1 whitespace-pre-wrap text-[11px] text-[var(--color-ink)] [overflow-wrap:anywhere]">
                            {value(task.title ?? t("未命名任务"))}
                          </strong>
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${statusClass}`}>{statusLabel}</span>
                        </div>
                        <div className="mt-1 flex min-w-0 flex-wrap items-start gap-2 text-[9px] text-[var(--color-faint)]">
                          <span>{t("优先级 {v0}", { v0: priority })}</span>
                          {task.dueDate ? <span>{t("截止 {v0}", { v0: value(task.dueDate) })}</span> : null}
                          {Array.isArray(task.dependsOn) && task.dependsOn.length > 0 ? (
                            <span className="min-w-0 basis-full whitespace-pre-wrap [overflow-wrap:anywhere]">
                              {t("前置任务：")}
                              {task.dependsOn.map((key) => value(key)).join(", ")}
                            </span>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("尚未创建任务。Agent 可调用 taskboard_create 创建带稳定编号的任务。")}
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
                <div className="rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-2">
                  <span className="block text-[10px] text-[var(--color-faint)]">Skills</span>
                  <strong className="mt-1 block font-mono text-[17px] text-[var(--color-blue)]">{value(data?.skillCount ?? 0)}</strong>
                </div>
                <div className="rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-2">
                  <span className="block text-[10px] text-[var(--color-faint)]">{t("MCP 服务器")}</span>
                  <strong className="mt-1 block font-mono text-[17px] text-[var(--color-blue)]">
                    {data?.mcpAvailable === false ? t("不可用") : value(data?.mcpCount ?? 0)}
                  </strong>
                </div>
              </div>
              {data?.truncated ? <p className="text-[10px] text-[var(--color-amber)]">{t("目录结果或字段已截断，计数包含未展示条目。")}</p> : null}
              {skills.length > 0 ? (
                <ul className="grid gap-1.5">
                  {skills.slice(0, 8).map((entry, index) => {
                    const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <li
                        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                        key={`${value(item.name ?? "skill")}-${index}`}
                      >
                        <div className="flex items-center gap-2">
                          <strong className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-ink)]">{value(item.name, t("未命名技能"))}</strong>
                          <span className="rounded bg-[var(--color-soft)] px-1.5 py-0.5 text-[9px] text-[var(--color-muted)]">
                            {value(item.scope, "unknown")}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[10px] text-[var(--color-faint)]">{value(item.description, t("无描述"))}</p>
                        {item.modelInvocationDisabled ? <p className="mt-1 text-[10px] text-[var(--color-amber)]">{t("已加载，仅允许显式调用")}</p> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("当前运行时没有加载 Skill。")}
                </div>
              )}
              {servers.length > 0 ? (
                <div>
                  <div className="mb-1 text-[10px] font-semibold text-[var(--color-muted)]">{t("MCP 状态")}</div>
                  <ul className="grid gap-1.5">
                    {servers.slice(0, 6).map((entry, index) => {
                      const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                      const running = item.status === "running";
                      return (
                        <li
                          className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[10px]"
                          key={`${value(item.id ?? "server")}-${index}`}
                        >
                          <span className="truncate font-mono text-[var(--color-muted)]">{value(item.id, t("未命名服务器"))}</span>
                          <span
                            className={`rounded px-1.5 py-0.5 ${running ? "bg-[var(--color-green-soft)] text-[var(--color-green)]" : "bg-[var(--color-soft)] text-[var(--color-muted)]"}`}
                          >
                            {value(item.status, "unknown")}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              {diagnostics.length > 0 ? (
                <div className="rounded-lg border border-[#fff0c2] bg-[var(--color-amber-soft)] px-3 py-2 text-[10px] text-[var(--color-amber)]">
                  {t("资源诊断：{v0} 条", { v0: value(data?.diagnosticCount) })}
                </div>
              ) : null}
              <div className="text-[10px] text-[var(--color-faint)]">
                {t("只读展示当前已加载资源，最多显示 8 个技能和 6 个 MCP 状态；不激活技能或启动服务器。读取技能采用启发式检查，不保证内容安全。")}
              </div>
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
              ? "text-[var(--color-red)]"
              : budgetPercent !== null && budgetPercent >= 80
                ? "text-[var(--color-amber)]"
                : "text-[var(--color-green)]";
          return (
            <div className="mt-3 grid min-w-0 grid-cols-1 gap-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {[
                  [t("今日（UTC）"), `$${Number(data?.todayCost ?? 0).toFixed(4)}`],
                  [t("当前会话"), `$${Number(data?.sessionCost ?? 0).toFixed(4)}`],
                  [t("累计"), `$${Number(data?.lifetimeCost ?? 0).toFixed(4)}`],
                ].map(([label, item]) => (
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                    <strong className="mt-1 block font-mono text-[15px] font-semibold text-[var(--color-ink)]">{value(item)}</strong>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <span className="text-[var(--color-muted)]">{t("每日预算（UTC）")}</span>
                  <strong className={budgetClass}>{budget === null ? t("未设置") : `$${budget.toFixed(4)} · ${budgetPercent?.toFixed(2) ?? "0.00"}%`}</strong>
                </div>
                {budget !== null ? (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-blue-soft)]">
                    <div
                      className={`h-full ${budgetPercent !== null && budgetPercent >= 100 ? "bg-[#d64545]" : "bg-[#4c83e8]"}`}
                      style={{ width: `${Math.min(100, budgetPercent ?? 0)}%` }}
                    />
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2 text-[10px] text-[var(--color-faint)]">
                <span className="rounded bg-[var(--color-soft)] px-2 py-1">{t("{v0} 日账本", { v0: meterView.dayBasis })}</span>
                <span className="rounded bg-[var(--color-soft)] px-2 py-1">{t("展示上限 {v0} 条", { v0: meterView.entryLimit ?? "—" })}</span>
              </div>
              {meterView.lastError !== null ? (
                <div className="rounded-lg border border-[#f0c8c4] bg-[var(--color-red-soft)] px-3 py-2 text-[10px] text-[var(--color-red)]">
                  {t("最近写入错误：{v0}", { v0: meterView.lastError })}
                </div>
              ) : null}
              {meterView.entries.length > 0 ? (
                <ul className="grid min-w-0 grid-cols-1 gap-1.5">
                  {meterView.entries.map((entry, index) => (
                    <li
                      className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[10px]"
                      key={`${entry.sessionId}-${entry.utcDate}-${index}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate font-mono text-[var(--color-muted)]">{entry.sessionId}</span>
                        <strong className="shrink-0 font-mono text-[var(--color-ink)]">{t("${v0} 当日增量", { v0: entry.dailyCost.toFixed(4) })}</strong>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[var(--color-faint)]">
                        <span>UTC {entry.utcDate}</span>
                        <span>{t("会话累计 ${v0}", { v0: entry.sessionCost.toFixed(4) })}</span>
                        <span>{entry.tokens} tokens</span>
                        <span>{t("{v0} 消息", { v0: entry.messages })}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("尚未记录已完成会话。Agent 可调用 cost_report 的 refresh 操作写入账本。")}
                </div>
              )}
              <div className="text-[10px] text-[var(--color-faint)]">{t("仅记录运行时报告的实际成本，不内置或猜测模型价格。")}</div>
            </div>
          );
        })()
      ) : panel.id === "undo-savepoint-panel" ? (
        (() => {
          const savepoints = Array.isArray(data?.savepoints) ? data.savepoints : [];
          return (
            <div className="mt-3 grid min-w-0 grid-cols-1 gap-3">
              <p className="break-all text-[10px] text-[var(--color-faint)]">
                {t("工作区：")}
                {value(data?.cwd)}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-2">
                  <span className="block text-[10px] text-[var(--color-faint)]">{t("保存点")}</span>
                  <strong className="mt-1 block font-mono text-[17px] text-[var(--color-blue)]">{value(data?.count ?? savepoints.length)}</strong>
                </div>
                <div className="rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-2">
                  <span className="block text-[10px] text-[var(--color-faint)]">{t("跟踪路径")}</span>
                  <strong className="mt-1 block font-mono text-[17px] text-[var(--color-blue)]">
                    {value(Array.isArray(data?.trackedPaths) ? data.trackedPaths.length : 0)}
                  </strong>
                </div>
              </div>
              {savepoints.length > 0 ? (
                <ul className="grid min-w-0 grid-cols-1 gap-1.5">
                  {savepoints.slice(0, 6).map((entry, index) => {
                    const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <li
                        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                        key={`${value(item.id ?? "savepoint")}-${index}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="min-w-0 break-all font-mono text-[10px] text-[var(--color-blue)]">{value(item.id, "unknown")}</code>
                          <strong className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-ink)]">{value(item.reason, "manual savepoint")}</strong>
                          <span className="text-[9px] text-[var(--color-faint)]">
                            {t("{v0} 文件", { v0: value(item.fileCount, "0") })}
                            {item.truncated === true ? t(" · 不完整") : ""}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("尚未创建保存点。修改配置或插件代码前，让 Agent 调用 undo_savepoint 的 save 操作。")}
                </div>
              )}
              <div className="text-[10px] text-[var(--color-faint)]">
                {t("恢复会覆盖快照内文件，要求 confirm=true，不删除新增文件。列表为受限扫描结果，仅显示前 6 项；标为不完整的快照不能代表整个工作区。")}
              </div>
            </div>
          );
        })()
      ) : panel.id === "annotation-panel" ? (
        (() => {
          const panelSessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
          if (
            activeSessionId === undefined ||
            panelSessionId !== activeSessionId ||
            panelSessionId.length === 0 ||
            panelSessionId.length > 512 ||
            /[\0\p{Cc}]/u.test(panelSessionId)
          )
            return <p className="mt-3 text-[11px] text-[var(--color-red)]">{t("批注面板数据不完整或不一致。")}</p>;
          const annotations = Array.isArray(data?.annotations) ? data.annotations : [];
          const lastPrompt = typeof data?.lastPrompt === "string" ? data.lastPrompt : "";
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-2 text-[10px]">
                <span className="text-[var(--color-muted)]">{t("待发送批注")}</span>
                <strong className="font-mono text-[var(--color-blue)]">{t("{v0} 条", { v0: value(data?.count ?? 0) })}</strong>
              </div>
              {annotations.length > 0 ? (
                <ol className="grid gap-1.5">
                  {annotations.slice(0, 8).map((entry, index) => {
                    const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <li
                        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                        key={`${value(item.id ?? index)}-${index}`}
                      >
                        <div className="flex items-start gap-2 text-[10px]">
                          <span className="rounded bg-[var(--color-blue-soft)] px-1.5 py-0.5 font-mono text-[var(--color-blue)]">
                            #{value(item.id ?? index + 1)}
                          </span>
                          <p className="min-w-0 flex-1 whitespace-pre-wrap text-[var(--color-ink)]">{value(item.quote, "")}</p>
                        </div>
                        {item.note ? <p className="mt-1 pl-8 text-[10px] text-[var(--color-faint)]">{value(item.note)}</p> : null}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("尚未收集批注。Agent 可调用 annotation_manage 的 add 操作记录回复片段。")}
                </div>
              )}
              {lastPrompt ? (
                <details className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[10px]">
                  <summary className="cursor-pointer text-[var(--color-muted)]">{t("最近生成的提问上下文")}</summary>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] text-[var(--color-ink)]">{lastPrompt}</pre>
                </details>
              ) : null}
              <div className="text-[10px] text-[var(--color-faint)]">{t("批注按编号累积；生成上下文不会改写原会话消息。")}</div>
            </div>
          );
        })()
      ) : panel.id === "runtime-doctor-panel" ? (
        (() => {
          const status = value(data?.status ?? "unknown");
          const checks = Array.isArray(data?.checks) ? data.checks : [];
          const recommendations = Array.isArray(data?.recommendations) ? data.recommendations : [];
          const statusClass =
            status === "ok"
              ? "bg-[var(--color-green-soft)] text-[var(--color-green)]"
              : status === "warning"
                ? "bg-[var(--color-amber-soft)] text-[var(--color-amber)]"
                : "bg-[var(--color-red-soft)] text-[var(--color-red)]";
          return (
            <div className="mt-3 grid min-w-0 grid-cols-1 gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-2">
                <span className="text-[11px] text-[var(--color-muted)]">{t("运行时边界检查")}</span>
                <span className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase ${statusClass}`}>{status}</span>
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-1.5">
                {checks.map((entry, index) => {
                  const check = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                  const checkStatus = value(check.status ?? "unknown");
                  const checkClass =
                    checkStatus === "ok"
                      ? "bg-[var(--color-green-soft)] text-[var(--color-green)]"
                      : checkStatus === "warning"
                        ? "bg-[var(--color-amber-soft)] text-[var(--color-amber)]"
                        : "bg-[var(--color-red-soft)] text-[var(--color-red)]";
                  return (
                    <div
                      className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[10px]"
                      key={`${value(check.id ?? "check")}-${index}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${checkStatus === "ok" ? "bg-[#22c55e]" : checkStatus === "warning" ? "bg-[#e6a21a]" : "bg-[#d64545]"}`}
                      ></span>
                      <code className="w-20 shrink-0 text-[var(--color-muted)]">{value(check.id ?? "check")}</code>
                      <span className="min-w-0 flex-1 truncate text-[var(--color-ink)]">{value(check.detail ?? "—")}</span>
                      <span className={`rounded px-1.5 py-0.5 font-mono ${checkClass}`}>{checkStatus}</span>
                    </div>
                  );
                })}
              </div>
              {recommendations.length > 0 ? (
                <div className="rounded-lg border border-[#f3dfab] bg-[var(--color-amber-soft)] px-3 py-2 text-[10px] text-[var(--color-amber)]">
                  <strong>{t("建议")}</strong>
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
          const checks =
            latest?.checks !== null && typeof latest?.checks === "object" && !Array.isArray(latest.checks)
              ? (latest.checks as Record<string, unknown>)
              : undefined;
          const errors: unknown[] = Array.isArray(latest?.errors) ? latest.errors : [];
          const warnings: unknown[] = Array.isArray(latest?.warnings) ? latest.warnings : [];
          const reports: unknown[] = Array.isArray(latest?.reports) ? latest.reports : [];
          const schema: unknown[] = Array.isArray(latest?.checks) ? latest.checks : [];
          const verdict = value(latest?.verdict ?? "—");
          const verdictClass =
            verdict === "pass"
              ? "bg-[var(--color-green-soft)] text-[var(--color-green)]"
              : verdict === "warn"
                ? "bg-[var(--color-amber-soft)] text-[var(--color-amber)]"
                : "bg-[var(--color-red-soft)] text-[var(--color-red)]";
          return (
            <div className="mt-3 grid gap-3">
              {latest?.scanned !== undefined ? (
                <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-2 text-[10px]">
                  <span className="text-[var(--color-muted)]">{t("目录扫描")}</span>
                  <strong className="font-mono text-[var(--color-blue)]">{t("{v0} 个仓库", { v0: value(latest.scanned) })}</strong>
                </div>
              ) : latest?.verdict !== undefined && schema.length === 0 ? (
                <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-2 text-[10px]">
                  <span className="truncate text-[var(--color-muted)]">{value(latest.repo ?? t("当前插件"))}</span>
                  <span className={`rounded px-1.5 py-0.5 font-mono ${verdictClass}`}>{verdict}</span>
                </div>
              ) : schema.length > 0 ? (
                <div className="rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-2 text-[10px] text-[var(--color-muted)]">
                  {t("检查清单：{v0} 项", { v0: schema.length })}
                </div>
              ) : null}
              {checks ? (
                <div className="grid grid-cols-3 gap-2">
                  {[
                    [t("通过"), checks.passed ?? 0],
                    [t("失败"), checks.failed ?? 0],
                    [t("警告"), checks.warned ?? 0],
                  ].map(([label, count]) => (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                      <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                      <strong className="mt-1 block font-mono text-[17px] text-[var(--color-ink)]">{value(count)}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
              {latest?.truncated === true || reports.length > 6 ? (
                <p className="text-[10px] text-[var(--color-amber)]">{t("结果不完整：已达到扫描、读取或结果上限，存在跳过文件，或匹配片段已裁剪。")}</p>
              ) : null}
              {schema.length > 0 ? (
                <ul className="grid gap-1.5">
                  {schema.map((entry, index) => {
                    const check = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <li
                        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[10px]"
                        key={`${value(check.code)}-${index}`}
                      >
                        <strong className="font-mono text-[var(--color-ink)]">{value(check.code)}</strong>
                        <p className="mt-1 text-[var(--color-muted)]">{value(check.label)}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : reports.length > 0 ? (
                <ul className="grid gap-1.5">
                  {reports.slice(0, 6).map((entry, index) => {
                    const report = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    const state = value(report.verdict ?? "—");
                    return (
                      <li
                        className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[10px]"
                        key={`${value(report.repo ?? "repo")}-${index}`}
                      >
                        <span className="truncate font-mono text-[var(--color-muted)]">{value(report.repo ?? t("未知仓库"))}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 ${state === "pass" ? "bg-[var(--color-green-soft)] text-[var(--color-green)]" : state === "warn" ? "bg-[var(--color-amber-soft)] text-[var(--color-amber)]" : "bg-[var(--color-red-soft)] text-[var(--color-red)]"}`}
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
                      <li
                        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[10px]"
                        key={`${value(item.code ?? "issue")}-${index}`}
                      >
                        <strong className="font-mono text-[var(--color-red)]">{value(item.code ?? "issue")}</strong>
                        <p className="mt-1 text-[var(--color-muted)]">{value(item.message, "")}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : latest === undefined ? (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("尚未检查插件。Agent 可调用 plugin_check 执行 check、scan 或 schema。")}
                </div>
              ) : null}
              <div className="text-[10px] text-[var(--color-faint)]">{t("只读检查，不修改、不构建被检仓库。")}</div>
            </div>
          );
        })()
      ) : panel.id === "plugin-radar-panel" ? (
        (() => {
          const results = Array.isArray(data?.results) ? data.results : [];
          return (
            <div className="mt-3 grid min-w-0 gap-3">
              <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-2 text-[10px]">
                <span className="text-[var(--color-muted)]">{t("GitHub Pi Harness 生态")}</span>
                <span className="font-mono text-[var(--color-blue)]">
                  {t("{v0} 个仓库 · {v1} 个来源", { v0: value(data?.total ?? 0), v1: Array.isArray(data?.sources) ? data.sources.length : 0 })}
                </span>
              </div>
              {data?.query ? <div className="text-[11px] text-[var(--color-muted)]">{t("查询：{v0}", { v0: value(data.query) })}</div> : null}
              {results.length > 0 ? (
                <ol className="grid min-w-0 gap-1.5">
                  {results.slice(0, 8).map((entry, index) => {
                    const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    const topics = Array.isArray(item.topics) ? item.topics.filter((topic): topic is string => typeof topic === "string").slice(0, 3) : [];
                    const url = typeof item.url === "string" ? item.url : undefined;
                    return (
                      <li
                        className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                        key={`${value(item.fullName ?? "repo")}-${index}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="w-4 shrink-0 text-right font-mono text-[10px] text-[var(--color-faint)]">{index + 1}</span>
                          {url ? (
                            <a
                              className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-blue)] hover:underline"
                              href={url}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {value(item.fullName ?? item.name ?? t("未知仓库"))}
                            </a>
                          ) : (
                            <strong className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-ink)]">
                              {value(item.fullName ?? item.name ?? t("未知仓库"))}
                            </strong>
                          )}
                          <span className="shrink-0 font-mono text-[10px] text-[var(--color-amber)]">★ {value(item.stars ?? 0)}</span>
                        </div>
                        <p className="mt-1 truncate pl-6 text-[10px] text-[var(--color-muted)]">{value(item.description, t("暂无描述"))}</p>
                        <div className="mt-1 flex min-w-0 items-center gap-2 pl-6 text-[9px] text-[var(--color-faint)]">
                          {item.language ? <span>{value(item.language)}</span> : null}
                          {item.updatedAt ? <span className="font-mono">{t("更新 {v0}", { v0: value(item.updatedAt) })}</span> : null}
                          {topics.length > 0 ? <span className="truncate">{topics.map((topic) => `#${topic}`).join(" ")}</span> : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {data?.fetchedAt ? t("未找到匹配的 Pi Harness 仓库。") : t("尚未搜索插件。Agent 可调用 plugin_radar_search 从 GitHub 发现 Pi Harness 插件。")}
                </div>
              )}
              {data?.truncated || results.length > 8 ? (
                <p className="text-[10px] text-[var(--color-faint)]">{t("仅展示部分结果，可缩小查询范围；GitHub 可能返回不完整结果。")}</p>
              ) : null}
              <div className="text-[10px] text-[var(--color-faint)]">{t("按 Star 排序的 Topic 匹配仓库，尚未验证插件可安装性；不会安装或执行仓库代码。")}</div>
            </div>
          );
        })()
      ) : panel.id === "hol-guard-panel" ? (
        (() => {
          const receipts = Array.isArray(data?.receipts) ? data.receipts : [];
          const latest = data?.latest !== null && typeof data?.latest === "object" ? (data.latest as Record<string, unknown>) : undefined;
          const riskLabel = (risk: unknown): string => (risk === "blocked" ? t("高风险") : risk === "review" ? t("需复核") : t("安全"));
          const riskClass = (risk: unknown): string =>
            risk === "blocked"
              ? "bg-[var(--color-red-soft)] text-[var(--color-red)]"
              : risk === "review"
                ? "bg-[var(--color-amber-soft)] text-[var(--color-amber)]"
                : "bg-[var(--color-green-soft)] text-[var(--color-green)]";
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-3 gap-2">
                {[
                  [t("高风险"), data?.blocked ?? 0],
                  [t("需复核"), data?.review ?? 0],
                  [t("安全"), data?.safe ?? 0],
                ].map(([label, count]) => (
                  <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                    <strong className="mt-1 block font-mono text-[17px] text-[var(--color-ink)]">{value(count)}</strong>
                  </div>
                ))}
              </div>
              {latest ? (
                <div className={`min-w-0 rounded-lg border border-[var(--color-line)] px-3 py-2 text-[10px] ${riskClass(latest.risk)}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{t("最近一次：{v0}", { v0: value(latest.source, "unknown") })}</span>
                    <strong className="shrink-0">
                      {t("{v0} · {v1} 项", {
                        v0: riskLabel(latest.risk),
                        v1: value(latest.findings && Array.isArray(latest.findings) ? latest.findings.length : 0),
                      })}
                    </strong>
                  </div>
                  {Array.isArray(latest.findings) && latest.findings.length > 0 ? (
                    <ul className="mt-2 grid gap-1 [overflow-wrap:anywhere]">
                      {latest.findings.map((finding, index) => (
                        <li key={index}>{value(finding !== null && typeof finding === "object" ? (finding as Record<string, unknown>).message : finding)}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {receipts.length > 0 ? (
                <ul className="grid gap-1.5">
                  <li className="text-[9px] uppercase tracking-[0.08em] text-[var(--color-faint)]">{t("最近风险摘要")}</li>
                  {receipts.slice(0, 8).map((entry, index) => {
                    const receipt = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    const findings = Array.isArray(receipt.findings) ? receipt.findings : [];
                    return (
                      <li
                        className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[10px]"
                        key={`${value(receipt.source)}-${index}`}
                      >
                        <span className={`rounded px-1.5 py-0.5 ${riskClass(receipt.risk)}`}>{riskLabel(receipt.risk)}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-muted)]">{value(receipt.source, "unknown")}</span>
                        <span className="text-[var(--color-faint)]">{t("{v0} 项", { v0: findings.length })}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("尚未收到工具调用。Agent 可调用 hol_guard_scan 预检命令或文本。")}
                </div>
              )}
              <div className="text-[10px] text-[var(--color-faint)]">
                {t("仅保存风险摘要和计数，不保存命令、路径或凭据原文；风险等级仅供审计，HOL Guard 不会阻止任何工具执行。")}
              </div>
            </div>
          );
        })()
      ) : panel.id === "tab-manager-panel" ? (
        (() => {
          const tabs = Array.isArray(data?.tabs) ? data.tabs : [];
          const activation = data?.activation !== null && typeof data?.activation === "object" ? (data.activation as Record<string, unknown>) : undefined;
          const states: Record<string, string> = {
            waiting: t("等待当前轮结束"),
            switching: t("正在切换会话"),
            completed: t("会话切换完成"),
            cancelled: t("会话切换已取消"),
            failed: t("会话切换失败"),
          };
          return (
            <div className="mt-3 grid gap-3 text-[11px]">
              <p>
                {t("当前会话：")}
                <code>{value(data?.currentSessionPath ?? t("未持久化"))}</code>
              </p>
              {activation ? (
                <div className="rounded-lg border border-[#dde3ec] p-3">
                  <strong>{states[value(activation.state)] ?? t("未知切换状态")}</strong>
                  <p className="break-all">{value(activation.sessionPath)}</p>
                  {activation.error ? <p className="text-[var(--color-red)]">{value(activation.error)}</p> : null}
                </div>
              ) : null}
              <p>{t("{v0} / 24 个标签 · {v1} 次存储写入", { v0: tabs.length, v1: value(data?.writes ?? 0) })}</p>
              <ul className="grid gap-2">
                {tabs.map((entry, index) => {
                  const tab = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                  return (
                    <li className="rounded-lg border border-[#dde3ec] p-3" key={index}>
                      <strong>{value(tab.label)}</strong> {tab.pinned === true ? t("已固定") : t("未固定")}
                      {tab.sessionPath === data?.currentSessionPath ? t(" · 当前会话") : ""}
                      <p className="break-all font-mono text-[10px]">{value(tab.sessionPath)}</p>
                    </li>
                  );
                })}
              </ul>
              <p className="text-[var(--color-faint)]">
                {t("通过 session_tab_manage 管理标签。activate 在当前轮结束后切换真实会话；移除标签不会删除会话文件。")}
              </p>
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
            <div className="mt-3 grid min-w-0 grid-cols-1 gap-3">
              <div className="grid grid-cols-3 gap-2">
                {[
                  [t("会话"), nodes.length],
                  [t("分支"), edges.length],
                  [t("父会话未显示"), data?.orphanCount ?? 0],
                ].map(([label, count]) => (
                  <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                    <strong className="mt-1 block font-mono text-[17px] text-[var(--color-ink)]">{value(count)}</strong>
                  </div>
                ))}
              </div>
              {data?.activeSessionId ? (
                <div className="flex flex-wrap items-baseline gap-1 rounded-lg border border-[#b9d0ff] bg-[var(--color-blue-soft)] px-3 py-2 text-[10px] text-[var(--color-blue)]">
                  {t("当前会话：")}
                  <code className="font-mono">{value(data.activeSessionId)}</code>
                </div>
              ) : null}
              {nodes.length > 0 ? (
                <ul className="grid min-w-0 grid-cols-1 gap-1.5">
                  <li className="text-[9px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
                    {t("最近会话 {v0} / {v1}", { v0: Math.min(nodes.length, 8), v1: nodes.length })}
                  </li>
                  {nodes.slice(0, 8).map((entry, index) => {
                    const node = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <li
                        className={`rounded-lg border px-3 py-2 ${node.active === true ? "border-[#b9d0ff] bg-[var(--color-blue-soft)]" : "border-[var(--color-line)] bg-[var(--color-surface)]"}`}
                        key={`${value(node.id ?? "session")}-${index}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${node.active === true ? "bg-[#3565c5]" : "bg-[var(--color-blue-soft)]"}`}></span>
                          <strong className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-ink)]">
                            {value(node.label ?? node.sessionId ?? t("未命名会话"))}
                          </strong>
                          <span className="font-mono text-[9px] text-[var(--color-faint)]">
                            {node.messagesTruncated === true
                              ? t("消息元数据未扫描（文件超过 4 MiB）")
                              : t("{v0} 条消息", { v0: value(node.messageCount ?? 0) })}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[9px] text-[var(--color-faint)]">
                          <span className="min-w-0 flex-1 truncate font-mono">{value(node.cwd ?? t("未知工作区"))}</span>
                          <span>{t("{v0} 个分支", { v0: value(node.branchCount ?? 0) })}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("当前工作区还没有可投影的持久化会话。")}
                </div>
              )}
              {edges.length > 0 ? (
                <div className="grid gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
                  <span className="text-[9px] uppercase tracking-[0.08em] text-[var(--color-faint)]">{t("Fork 关系")}</span>
                  {edges.slice(0, 5).map((entry, index) => {
                    const edge = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    const from = nodeById.get(value(edge.from));
                    const to = nodeById.get(value(edge.to));
                    return (
                      <div
                        className="flex min-w-0 items-center gap-1.5 font-mono text-[9px] text-[var(--color-muted)]"
                        key={`${value(edge.from)}-${value(edge.to)}-${index}`}
                      >
                        <span className="truncate">{value(from?.label ?? edge.from)}</span>
                        <span className="shrink-0 text-[var(--color-blue)]">→ fork →</span>
                        <span className="truncate">{value(to?.label ?? edge.to)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {Number(data?.metadataTruncated ?? 0) > 0 || Number(data?.metadataUnavailable ?? 0) > 0 ? (
                <div className="rounded-lg border border-[#f0d59b] bg-[#fff8e7] px-3 py-2 text-[10px] text-[#75520b]">
                  {Number(data?.metadataTruncated ?? 0) > 0
                    ? t("{v0} 个会话的消息元数据未扫描，因为文件超过 4 MiB。", { v0: value(data?.metadataTruncated) })
                    : null}
                  {Number(data?.metadataTruncated ?? 0) > 0 && Number(data?.metadataUnavailable ?? 0) > 0 ? " " : null}
                  {Number(data?.metadataUnavailable ?? 0) > 0
                    ? t("{v0} 个会话在扫描期间发生变化或无法读取，未显示。", { v0: value(data?.metadataUnavailable) })
                    : null}
                </div>
              ) : null}
              <div className="text-[10px] text-[var(--color-faint)]">
                {t(
                  "数据来源：Pi 原生 JSONL 会话；Agent 可调用 synapse_session_map 刷新。节点展示 {v0} / {v1}；{v2} 当前工作区：{v3}。面板最多显示 8 个节点和 5 条关系。",
                  {
                    v0: nodes.length,
                    v1: value(data?.total),
                    v2: data?.truncated === true ? t("结果已截断，未显示的父会话不代表文件丢失。") : t("已返回全部列出的会话。"),
                    v3: value(data?.cwd),
                  },
                )}
              </div>
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
                    <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                      <span className="block text-[10px] text-[var(--color-faint)]">{t("组件")}</span>
                      <strong className="mt-1 block text-[17px] text-[var(--color-ink)]">{value(components.length)}</strong>
                    </div>
                    <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                      <span className="block text-[10px] text-[var(--color-faint)]">{t("外部依赖")}</span>
                      <strong className="mt-1 block text-[17px] text-[var(--color-ink)]">{value(dependencies.length)}</strong>
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    {components.slice(0, 8).map((entry, index) => {
                      const component = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                      return (
                        <div
                          className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[11px]"
                          key={`${value(component.path ?? "component")}-${index}`}
                        >
                          <span className="h-2 w-2 rounded-full bg-[#3565c5]"></span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-ink)]">{value(component.path ?? t("组件"))}</span>
                          <span className="font-mono text-[10px] text-[var(--color-faint)]">{value(component.files ?? 0)} files</span>
                        </div>
                      );
                    })}
                  </div>
                  {dependencies.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {dependencies.slice(0, 12).map((dependency, index) => (
                        <span
                          className="rounded-md border border-[#dce5f5] bg-[var(--color-blue-soft)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]"
                          key={`${value(dependency)}-${index}`}
                        >
                          {value(dependency)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <pre className="max-h-48 overflow-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 text-[10px] leading-4 text-[var(--color-muted)]">
                    {value(report.mermaid, "")}
                  </pre>
                  {report.truncated === true ? <p className="text-[10px] text-[var(--color-amber)]">{t("扫描达到节点上限，架构图可能不完整。")}</p> : null}
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("Agent 可调用 architecture_map 生成当前工作区架构图。")}
            </div>
          )}
        </div>
      ) : panel.id === "canvas-draw-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px]">
            <span className="font-medium text-[var(--color-ink)]">{t("Mermaid 流程图")}</span>
            <span className="font-mono text-[var(--color-blue)]">
              {t("{v0} 节点 · {v1} 连线", { v0: value(data?.nodeCount ?? 0), v1: value(data?.edgeCount ?? 0) })}
            </span>
          </div>
          {data?.latest && typeof data.latest === "object" ? (
            <pre className="max-h-48 overflow-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 text-[10px] leading-4 text-[var(--color-muted)]">
              {value((data.latest as Record<string, unknown>).mermaid, "")}
            </pre>
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("Agent 可调用 canvas_draw 生成流程图源码。")}
            </div>
          )}
        </div>
      ) : panel.id === "image-compressor-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px]">
            <span className="font-medium text-[var(--color-ink)]">{t("PNG 无损压缩")}</span>
            <span className="font-mono text-[var(--color-muted)]">{t("上限 32 MiB")}</span>
          </div>
          {data?.last && typeof data.last === "object" ? (
            (() => {
              const report = data.last as Record<string, unknown>;
              return (
                <div className="rounded-lg border border-[#b9e6c9] bg-[var(--color-green-soft)] px-3 py-3 text-[11px] text-[var(--color-green)]">
                  {t("{v0} → {v1}，节省 {v2} bytes", {
                    v0: value(report.inputPath ?? t("图片")),
                    v1: value(report.outputPath ?? t("输出")),
                    v2: value(report.savedBytes ?? 0),
                  })}
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("Agent 可调用 image_compress，写入前必须 confirm=true。")}
            </div>
          )}
        </div>
      ) : panel.id === "workspace-search-panel" ? (
        (() => {
          const view = workspaceSearchPanelView(data);
          if (view.malformed) {
            return (
              <div className="mt-3 rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("Workspace Search 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不可信，请重新加载后再查询。")}</span>
              </div>
            );
          }
          const report = view.latest;
          return (
            <div className="mt-3 grid min-w-0 gap-3">
              <p className="whitespace-pre-wrap text-[10px] text-[var(--color-faint)] [overflow-wrap:anywhere]">
                {t("工作区：")}
                {view.cwd}
              </p>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px]">
                <span className="font-medium text-[var(--color-ink)]">{t("工作区文本检索")}</span>
                <span className="shrink-0 font-mono text-[var(--color-blue)]">{t("{v0} 个匹配", { v0: view.matchCount })}</span>
              </div>
              {report !== null ? (
                <>
                  <p className="whitespace-pre-wrap text-[10px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
                    {t("查询：{v0} · 路径：{v1}", { v0: report.query, v1: report.path })}
                  </p>
                  <p className="text-[10px] text-[var(--color-faint)]">
                    {t("已搜索 {v0} 个文件，跳过 {v1} 个；显示 {v2} / {v3} 条已收集匹配。", {
                      v0: report.scannedFiles,
                      v1: report.skippedFiles,
                      v2: report.matches.length,
                      v3: report.matchCount,
                    })}
                  </p>
                  <p className="text-[10px] text-[var(--color-faint)]">
                    {t("已扫描 {v0} 个目录条目 · 读取 {v1} bytes", { v0: report.scannedEntries, v1: report.readBytes })}
                  </p>
                  {report.truncated ? (
                    <p className="text-[10px] text-[var(--color-amber)]">{t("结果不完整：已达到扫描、读取或结果上限，存在跳过文件，或匹配片段已裁剪。")}</p>
                  ) : null}
                  {report.matches.length > 0 ? (
                    <ul
                      aria-label={t("工作区搜索结果")}
                      className="grid max-h-[40rem] min-w-0 gap-1.5 overflow-y-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-blue)]"
                      tabIndex={0}
                    >
                      {report.matches.map((match) => (
                        <li
                          className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                          key={`${match.path}\0${match.line}`}
                        >
                          <strong className="block whitespace-pre-wrap font-mono text-[10px] text-[var(--color-blue)] [overflow-wrap:anywhere]">
                            {match.path}:{match.line}
                          </strong>
                          <p className="mt-1 whitespace-pre-wrap font-mono text-[10px] text-[var(--color-muted)] [overflow-wrap:anywhere]">{match.text}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                      {t("没有找到匹配内容。")}
                    </div>
                  )}
                </>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("Agent 可调用 workspace_search 检索当前工作区。")}
                </div>
              )}
            </div>
          );
        })()
      ) : panel.id === "recall-unread-panel" ? (
        (() => {
          const view = recallUnreadPanelView(data);
          const visible = view.items.slice(0, 8);
          return (
            <div className="mt-3 grid gap-3">
              {view.status.state === "failed" || view.status.state === "cancelled" ? (
                <div
                  className={`rounded-lg border px-3 py-3 text-[11px] leading-5 ${
                    view.status.state === "failed"
                      ? "border-[#f3c4c4] bg-[var(--color-red-soft)] text-[var(--color-red)]"
                      : "border-[#f4d8a8] bg-[var(--color-amber-soft)] text-[var(--color-amber)]"
                  }`}
                >
                  {view.status.state === "failed" ? t("扫描失败") : t("扫描已取消")}
                  {view.status.error === null ? null : <p className="mt-1">{t("原因：{v0}", { v0: view.status.error })}</p>}
                </div>
              ) : null}
              <div className="grid grid-cols-3 gap-2">
                {[
                  [t("候选"), view.inventory.candidates],
                  [t("已扫描"), view.inventory.scanned],
                  [t("未回答"), view.total],
                ].map(([label, item]) => (
                  <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                    <strong className="mt-1 block font-mono text-[17px] text-[var(--color-ink)]">{value(item)}</strong>
                  </div>
                ))}
              </div>
              {visible.length > 0 ? (
                <div className="grid gap-2">
                  {visible.map((session, index) => (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2" key={`${session.id}-${index}`}>
                      <div className="flex items-center justify-between gap-2">
                        <strong className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-ink)]">{session.name}</strong>
                        <span className="shrink-0 font-mono text-[9px] text-[var(--color-faint)]">{t("{v0} 条消息", { v0: session.messageCount })}</span>
                      </div>
                      <p className="mt-1 min-w-0 line-clamp-2 whitespace-pre-wrap text-[10px] leading-4 text-[var(--color-muted)] [overflow-wrap:anywhere]">
                        {session.message}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {view.status.state === "idle"
                    ? t("当前会话尚未扫描，请运行 session_recall_unread。")
                    : view.status.state === "running"
                      ? t("正在扫描未回答的会话…")
                      : t("没有以未回答用户消息结束的会话。")}
                </div>
              )}
              <p className="text-[10px] leading-4 text-[var(--color-faint)]">
                {t("已扫描 {scanned}/{available} 个会话文件，界面显示 {shown}/{unread} 个；只读扫描，不会修改会话。{note}", {
                  scanned: view.inventory.scanned,
                  available: view.inventory.available,
                  shown: visible.length,
                  unread: view.inventory.unread,
                  note: view.inventory.truncated ? t(" 部分结果因发现、扫描或展示上限被截断。") : "",
                })}
              </p>
            </div>
          );
        })()
      ) : panel.id === "turn-rewind-panel" ? (
        (() => {
          const view = turnRewindPanelView(data);
          const statusLabel = {
            queued: t("已排队"),
            running: t("执行中"),
            completed: t("已回退"),
            failed: t("失败"),
            cancelled: t("已取消"),
          } as const;
          const statusTone = {
            queued: "border-[#dce5f5] bg-[var(--color-blue-soft)] text-[var(--color-blue)]",
            running: "border-[#dce5f5] bg-[var(--color-blue-soft)] text-[var(--color-blue)]",
            completed: "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]",
            failed: "border-[#f3c4c4] bg-[var(--color-red-soft)] text-[var(--color-red)]",
            cancelled: "border-[#f4d8a8] bg-[var(--color-amber-soft)] text-[var(--color-amber)]",
          } as const;
          return (
            <div className="mt-3 grid gap-3">
              {view.latest === null ? (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("还没有执行回退操作。")}
                </div>
              ) : (
                <div className={`rounded-lg border px-3 py-3 ${statusTone[view.latest.status]}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em]">{t("最近操作")}</span>
                    <span className="rounded-full bg-[var(--color-surface)]/70 px-2 py-1 text-[10px] font-semibold">{statusLabel[view.latest.status]}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-[var(--color-ink)]">{view.latest.target.text}</p>
                  {view.latest.error === null ? null : <p className="mt-2 break-words text-[10px] leading-4">{view.latest.error}</p>}
                  {view.latest.summarized ? <p className="mt-2 text-[10px] leading-4">{t("已请求分支摘要；该选项可能调用模型并产生费用。")}</p> : null}
                </div>
              )}
              <div className="grid gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-faint)]">{t("可回退轮次")}</span>
                {view.candidates.length > 0 ? (
                  view.candidates.map((candidate, index) => (
                    <div
                      className="flex items-start gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                      key={`${candidate.entryId}-${index}`}
                    >
                      <span className="mt-0.5 font-mono text-[10px] text-[var(--color-blue)]">{view.candidates.length - index}</span>
                      <span className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-4 text-[var(--color-muted)]">{candidate.text}</span>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                    {t("当前会话还没有可回退的用户轮次。")}
                  </div>
                )}
              </div>
              <p className="text-[10px] leading-4 text-[var(--color-faint)]">
                {t("已检查当前分支 {v0} 个条目；后端保留 {v1} 个候选，界面显示 {v2} 个。 {v3}", {
                  v0: view.inventory.scannedEntries,
                  v1: view.inventory.shown,
                  v2: view.candidates.length,
                  v3: view.inventory.truncated ? t(" 部分结果因扫描、候选或显示上限被截断。") : "",
                })}
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
                    view.status.state === "failed"
                      ? "border-[#f3c4c4] bg-[var(--color-red-soft)] text-[var(--color-red)]"
                      : "border-[#f4d8a8] bg-[var(--color-amber-soft)] text-[var(--color-amber)]"
                  }`}
                >
                  {view.status.state === "failed" ? t("扫描失败") : t("扫描已取消")}
                  {view.status.error === null ? null : <p className="mt-1">{t("原因：{v0}", { v0: view.status.error })}</p>}
                </div>
              ) : null}
              {data?.query ? (
                <p className="text-[10px] text-[var(--color-faint)]">
                  {t("最近完成扫描的查询：")}
                  {value(data.query)}
                </p>
              ) : null}
              <div className="grid grid-cols-3 gap-2">
                {[
                  [t("已扫描"), view.total],
                  [t("高风险"), view.blocked],
                  [t("待复核"), view.review],
                ].map(([label, item]) => (
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                    <strong className="mt-1 block text-[17px] font-semibold text-[var(--color-ink)]">{value(item)}</strong>
                  </div>
                ))}
              </div>
              <div className="grid gap-2">
                {view.reports.length > 0 ? (
                  view.reports.slice(0, 8).map((report, index) => (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2" key={`${report.name}-${index}`}>
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${report.risk === "blocked" ? "bg-[#d64545]" : report.risk === "review" ? "bg-[#e0a11a]" : "bg-[#22a06b]"}`}
                        ></span>
                        <strong className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-ink)]">{report.name}</strong>
                        <span className="text-[10px] text-[var(--color-faint)]">
                          {report.risk === "blocked" ? t("高风险") : report.risk === "review" ? t("复核") : t("未命中规则")}
                        </span>
                      </div>
                      {report.findings.length > 0 ? (
                        <p className="mt-1 truncate text-[10px] text-[var(--color-muted)]">{report.findings.map((finding) => finding.code).join(" · ")}</p>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                    {t("暂无 Skill 扫描结果，可让 Agent 调用 skill_guard_scan。")}
                  </div>
                )}
              </div>
              <p className="text-[10px] text-[var(--color-faint)]">
                {t("已加载 {v0} 个入口，本次查询匹配 {v1} 个，扫描 {v2} 个，面板显示 {v3} 个；风险等级仅供审计，不会禁用 Skill，也不证明内容安全。", {
                  v0: view.inventory.available,
                  v1: value(data?.matched),
                  v2: view.inventory.scanned,
                  v3: Math.min(view.reports.length, 8),
                })}
              </p>
            </div>
          );
        })()
      ) : panel.id === "prompt-guard-panel" ? (
        (() => {
          // Keep the highest risk in the current session visible after later benign messages.
          const highest = data?.highest && typeof data.highest === "object" ? (data.highest as Record<string, unknown>) : undefined;
          const highlighted = highest;
          const risk = highest?.risk;
          return (
            <div className="mt-3 grid gap-3">
              <div
                className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${risk === "blocked" ? "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]" : risk === "review" ? "border-[#f3dfab] bg-[var(--color-amber-soft)] text-[var(--color-amber)]" : "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"}`}
              >
                <span>
                  {risk === "blocked" ? t("高风险，需处理") : risk === "review" ? t("需要人工复核") : highest ? t("未命中检测规则") : t("尚未扫描")}
                  {highlighted && risk !== "safe" && risk !== undefined ? (
                    <span className="ml-2 font-mono text-[10px]">{value(highlighted.source, "unknown")}</span>
                  ) : null}
                </span>
                <strong className="font-mono">{t("{v0} 次扫描", { v0: value(data?.scans ?? 0) })}</strong>
              </div>
              {highlighted ? (
                (() => {
                  const report = highlighted;
                  const findings = Array.isArray(report.findings) ? report.findings : [];
                  return findings.length > 0 ? (
                    <ul className="grid gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-[10px] text-[var(--color-muted)]">
                      {findings.slice(0, 6).map((finding, index) => {
                        const item = finding && typeof finding === "object" ? (finding as Record<string, unknown>) : {};
                        return (
                          <li key={`${value(item.code ?? "finding")}-${index}`}>
                            <strong className="font-mono text-[var(--color-ink)]">{value(item.code ?? "finding")}</strong>: {value(item.message, "")}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                      {t("已扫描内容未命中当前检测规则，不代表没有风险。")}
                    </div>
                  );
                })()
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("尚未扫描任何内容。用户消息和工具输出会自动扫描，Agent 也可调用 prompt_guard_scan 检查不可信文本。")}
                </div>
              )}
              <p className="text-[10px] text-[var(--color-faint)]">{t("被动审计：不会阻断模型或工具执行。超出扫描上限的内容需要另行检查。")}</p>
            </div>
          );
        })()
      ) : panel.id === "code2skill-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("已生成技能")}</span>
              <strong className="font-mono text-[12px] text-[var(--color-blue)]">{value(data?.generated ?? 0)}</strong>
            </div>
            {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
              <p className="mt-2 truncate text-[11px] text-[var(--color-muted)]">
                {t("{slug} · {files} 个参考文件", {
                  slug: value((data.latest as Record<string, unknown>).slug ?? "skill"),
                  files: value(
                    Array.isArray((data.latest as Record<string, unknown>).files) ? ((data.latest as Record<string, unknown>).files as unknown[]).length : 0,
                  ),
                })}
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-[var(--color-faint)]">{t("还没有生成技能。可让 Agent 调用 skill_pack_create。")}</p>
            )}
          </div>
          <p className="text-[10px] text-[var(--color-faint)]">{t("输出目录：项目 .pi/skills/<name>，包含 SKILL.md 和原始参考文件。")}</p>
        </div>
      ) : panel.id === "genui-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const view = genUiPanelView(data);
            const toneClass: Record<string, string> = {
              neutral: "border-[var(--color-line)] bg-[var(--color-soft)] text-[var(--color-muted)]",
              info: "border-[#d9e4f7] bg-[var(--color-blue-soft)] text-[var(--color-blue)]",
              success: "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]",
              warning: "border-[#f3dfab] bg-[var(--color-amber-soft)] text-[var(--color-amber)]",
              danger: "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]",
            };
            return view.latest !== null ? (
              <div className="grid gap-2">
                <div className="flex items-start justify-between gap-3 text-[11px]">
                  <strong className="min-w-0 break-words text-[var(--color-ink)]">{view.latest.title}</strong>
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">{t("{v0} 次", { v0: view.rendered })}</span>
                </div>
                {view.latest.blocks.map((block, index) =>
                  block.type === "progress" ? (
                    <div className={`rounded-lg border px-3 py-2 ${toneClass[block.tone]}`} key={`${block.label}-${index}`}>
                      <div className="flex items-center justify-between gap-2 text-[10px]">
                        <span className="min-w-0 break-words">{block.label}</span>
                        <strong className="shrink-0">{block.value}%</strong>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface)]/70">
                        <div className="h-full rounded-full bg-current" style={{ width: `${block.value}%` }} />
                      </div>
                    </div>
                  ) : block.type === "text" ? (
                    <div className={`rounded-lg border px-3 py-2 text-[11px] ${toneClass[block.tone]}`} key={`${block.label}-${index}`}>
                      <strong className="block text-[10px]">{block.label}</strong>
                      <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] leading-4">{block.value}</p>
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
                <div className="flex flex-wrap gap-2 text-[10px] text-[var(--color-faint)]">
                  <span>{t("最多 {v0} 块", { v0: view.limits.blocks })}</span>
                  <span>{t("总文本上限 {v0} 字符", { v0: view.limits.totalText })}</span>
                  {view.latest.renderedAt !== null ? <span>{view.latest.renderedAt.slice(11, 19)} UTC</span> : null}
                  {view.latest.truncated ? <span>{t("面板明细已截断")}</span> : null}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                {t("还没有结构化卡片。可让 Agent 调用 genui_render。")}
              </div>
            );
          })()}
          <p className="text-[10px] text-[var(--color-faint)]">{t("仅渲染结构化文本、徽标和进度块；HTML 与脚本按普通文本显示。")}</p>
        </div>
      ) : panel.id === "anchored-standard-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const violations = Array.isArray(data?.violations) ? data.violations : [];
            const violated = data?.status === "violated";
            return (
              <>
                <div
                  className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${violated ? "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]" : "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"}`}
                >
                  <span>{violated ? t("轨迹存在违规") : data?.status === "anchored" ? t("运行已锚定") : t("等待 Agent 运行")}</span>
                  <strong className="font-mono">{t("{v0} 事件", { v0: value(data?.events ?? 0) })}</strong>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[10px] text-[var(--color-muted)]">
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                    {t("工具调用")} <strong className="ml-1 text-[var(--color-ink)]">{value(data?.toolCalls ?? 0)}</strong>
                  </div>
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                    {t("违规项")} <strong className="ml-1 text-[var(--color-ink)]">{value(violations.length)}</strong>
                  </div>
                </div>
                {violations.length > 0 ? (
                  <ul className="grid gap-1 rounded-lg border border-[#f4caca] bg-[var(--color-soft)] px-3 py-2 text-[10px] text-[var(--color-red)]">
                    {violations.slice(0, 5).map((item, index) => (
                      <li key={`${value(item)}-${index}`}>
                        {value(item && typeof item === "object" ? ((item as Record<string, unknown>).message ?? t("违规")) : item)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            );
          })()}
          <p className="text-[10px] text-[var(--color-faint)]">{t("可让 Agent 调用 trajectory_anchor_check 审计当前执行轨迹。")}</p>
          <p className="text-[10px] text-[var(--color-faint)]">{t("告警自插件加载以来累计，跨会话保留；只读审计，不会阻止工具执行。")}</p>
        </div>
      ) : panel.id === "telemetry-blocker-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#b9e6c9] bg-[var(--color-green-soft)] px-3 py-3 text-[11px] text-[var(--color-green)]">
            <span>{t("本地遥测服务不发送事件")}</span>
            <strong className="font-mono">{t("丢弃 {v0} 次 · 总线观察 {v1} 次", { v0: value(data?.discarded ?? 0), v1: value(data?.observed ?? 0) })}</strong>
          </div>
          <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[10px] text-[var(--color-muted)]">
            {Array.isArray(data?.names) && data.names.length > 0
              ? t("事件名：{names}", { names: data.names.slice(0, 8).map(String).join(t("、")) })
              : t("尚未收到遥测事件。")}
          </div>
          <p className="text-[10px] text-[var(--color-faint)]">
            {t("最多保留 100 个事件名，界面显示前 8 个；")}
            {data?.namesTruncated === true ? t("事件名已截断。") : ""}
            {t("不读取或保存事件属性。此服务不拦截网络，也不阻止其他事件监听器。")}
          </p>
        </div>
      ) : panel.id === "plugin-dev-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const view = pluginDevPanelView(data);
            const presentation = {
              idle: { label: t("等待重载"), style: "border-[var(--color-line)] bg-[var(--color-soft)] text-[var(--color-muted)]" },
              queued: { label: t("等待当前运行结束"), style: "border-[#d9e4f7] bg-[var(--color-blue-soft)] text-[var(--color-blue)]" },
              running: { label: t("正在重载会话资源"), style: "border-[#d9e4f7] bg-[var(--color-blue-soft)] text-[var(--color-blue)]" },
              reloaded: { label: t("会话资源已重载"), style: "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]" },
              failed: { label: t("会话资源重载失败"), style: "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]" },
              cancelled: { label: t("会话资源重载已取消"), style: "border-[#f3dfab] bg-[var(--color-amber-soft)] text-[var(--color-amber)]" },
            }[view.status];
            return (
              <>
                <div className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${presentation.style}`}>
                  <span>{presentation.label}</span>
                  <strong className="font-mono">{view.status}</strong>
                </div>
                <p className="break-words text-[10px] text-[var(--color-faint)]">{view.reason || t("修改本地扩展后调用 plugin_dev_reload")}</p>
                {view.error !== null ? (
                  <p className="break-words rounded-lg bg-[var(--color-red-soft)] px-3 py-2 text-[10px] text-[var(--color-red)]">{view.error}</p>
                ) : null}
                <div className="flex flex-wrap gap-2 text-[10px] text-[var(--color-faint)]">
                  <span>{t("原因上限 {v0} 字符", { v0: view.limits.reasonCharacters })}</span>
                  <span>{t("错误上限 {v0} 字符", { v0: view.limits.errorCharacters })}</span>
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
            const moodLabel = { idle: t("休息"), focused: t("专注"), happy: t("开心"), concerned: t("担心") }[view.mood];
            return (
              <>
                <div className="flex items-center gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-blue-soft)] text-[20px] text-[var(--color-blue)]">
                    ◉
                  </span>
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-[13px] text-[var(--color-ink)]">{view.name}</strong>
                    <span className="text-[10px] text-[var(--color-faint)]">{view.lastEvent}</span>
                  </div>
                  <span className="rounded-full bg-[var(--color-blue-soft)] px-2 py-1 text-[10px] text-[var(--color-blue)]">{moodLabel}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[10px] text-[var(--color-muted)]">
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                    {t("能量")} <strong className="ml-1 text-[var(--color-ink)]">{view.energy}%</strong>
                  </div>
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                    {t("互动")} <strong className="ml-1 text-[var(--color-ink)]">{view.interactions}</strong>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-[10px] text-[var(--color-faint)]">
                  <span>{t("恢复扫描 {v0} / {v1}", { v0: view.recovery.scanned, v1: view.recovery.sessionEntries })}</span>
                  <span>{view.recovery.restored ? t("已恢复状态") : t("使用初始状态")}</span>
                  <span>{t("持久化 {v0} / {v1}", { v0: view.persistence.attempts - view.persistence.failures, v1: view.persistence.attempts })}</span>
                  {view.updatedAt !== null ? <span>{view.updatedAt.slice(11, 19)} UTC</span> : null}
                </div>
                {view.persistence.lastError !== null ? (
                  <p className="break-words rounded-lg bg-[var(--color-red-soft)] px-3 py-2 text-[10px] text-[var(--color-red)]">
                    {view.persistence.lastError}
                  </p>
                ) : null}
                <p className="text-[10px] text-[var(--color-faint)]">{t("根据真实 Pi 会话事件自动反应，也可让 Agent 调用 pet_react 进行互动。")}</p>
              </>
            );
          })()}
        </div>
      ) : panel.id === "change-verifier-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.status === "running" ? (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-muted)]">
              {t("执行中")}
            </div>
          ) : data?.status === "failed" || data?.status === "cancelled" ? (
            <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
              <p>{data.status === "cancelled" ? t("验证已取消") : t("验证失败")}</p>
              {typeof data.lastError === "string" ? <p className="mt-2 break-words">{data.lastError}</p> : null}
            </div>
          ) : data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
              const tests = report.tests && typeof report.tests === "object" ? (report.tests as Record<string, unknown>) : {};
              const review = report.review && typeof report.review === "object" ? (report.review as Record<string, unknown>) : {};
              const status = value(report.status ?? "fail");
              return (
                <>
                  <div
                    className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${status === "pass" ? "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]" : status === "warning" ? "border-[#f3dfab] bg-[var(--color-amber-soft)] text-[var(--color-amber)]" : "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]"}`}
                  >
                    <span>{status === "pass" ? t("门禁通过") : status === "warning" ? t("门禁有警告") : t("门禁失败")}</span>
                    <strong className="font-mono">{t("{v0} 次", { v0: value(data.runs ?? 0) })}</strong>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10px] text-[var(--color-muted)]">
                    <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                      {t("测试 exit")} <strong className="ml-1 text-[var(--color-ink)]">{value(tests.exitCode ?? "—")}</strong>
                    </div>
                    <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                      {t("审查")} <strong className="ml-1 text-[var(--color-ink)]">{value(review.status ?? "—")}</strong>
                    </div>
                  </div>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("还没有执行发布门禁。可让 Agent 调用 verify_change_gate。")}
            </div>
          )}
          <p className="text-[10px] text-[var(--color-faint)]">{t("复用 run_project_tests 和 review_changes，不重复实现测试或审查逻辑。")}</p>
        </div>
      ) : panel.id === "readme-gen-panel" ? (
        (() => {
          const view = readmeGenPanelView(data);
          if (view.malformed)
            return (
              <div className="mt-3 rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] leading-5 text-[var(--color-red)]">
                {t("README 面板数据无效，暂不展示生成或写入结果。")}
              </div>
            );
          const statusLabel =
            view.status.state === "idle"
              ? t("等待生成")
              : view.status.state === "running"
                ? view.status.operation === "write"
                  ? t("正在写入")
                  : t("正在生成")
                : view.status.state === "completed"
                  ? view.status.operation === "write"
                    ? t("写入已完成")
                    : t("草稿已生成")
                  : view.status.state === "failed"
                    ? view.status.operation === "write"
                      ? t("写入失败")
                      : t("生成失败")
                    : view.status.operation === "write"
                      ? t("写入已取消")
                      : t("生成已取消");
          const statusTone =
            view.status.state === "failed" || view.status.state === "cancelled"
              ? "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]"
              : view.status.state === "completed"
                ? "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]"
                : "border-[#dce5f5] bg-[var(--color-blue-soft)] text-[var(--color-blue)]";
          return (
            <div className="mt-3 grid min-w-0 gap-3">
              <div className={`flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[10px] ${statusTone}`}>
                <strong className="font-semibold">{statusLabel}</strong>
                {view.status.at !== null ? <time className="shrink-0 font-mono">{view.status.at.slice(11, 19)} UTC</time> : null}
              </div>
              {view.generated === null ? (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] leading-5 text-[var(--color-faint)]">
                  {t("还没有生成 README 草稿。让 Agent 调用 readme_report 先检查内容。")}
                </div>
              ) : (
                <div className="min-w-0 border-l-2 border-[#7aa2e8] bg-[var(--color-blue-soft)] px-3 py-3">
                  <p className="break-all text-[12px] font-semibold leading-5 text-[var(--color-ink)]">{view.generated.name}</p>
                  <p className="mt-1 text-[10px] text-[var(--color-faint)]">
                    {t("{v0} 个脚本 · {v1} 个运行时插件", { v0: view.generated.scripts, v1: view.generated.plugins })}
                  </p>
                </div>
              )}
              {view.lastWrite !== null ? (
                <div className="min-w-0 rounded-lg border border-[#dce5f5] bg-[var(--color-surface)] px-3 py-2 text-[var(--color-blue)]">
                  <p className="break-all font-mono text-[10px] leading-4">{view.lastWrite.path}</p>
                  <p className="mt-1 text-[10px] text-[var(--color-faint)]">
                    {new Intl.NumberFormat(formatLocale()).format(view.lastWrite.bytes)} bytes · {view.lastWrite.overwritten ? t("已覆盖") : t("新文件")}
                  </p>
                </div>
              ) : null}
              {view.status.error !== null ? (
                <p className="break-words rounded-lg bg-[var(--color-red-soft)] px-3 py-2 text-[10px] leading-4 text-[var(--color-red)]">{view.status.error}</p>
              ) : null}
              {/* One sentence rather than fragments around <code>: the trailing full stop used to be a JSX literal, so every non-CJK locale ended the line with a Chinese period. */}
              <p className="text-[10px] leading-4 text-[var(--color-faint)]">{t("写入需要 confirm=true，覆盖已有 README 还需要 overwrite=true。")}</p>
            </div>
          );
        })()
      ) : panel.id === "sql-lens-panel" ? (
        (() => {
          const view = sqlLensPanelView(data);
          if (view.malformed) {
            return (
              <div className="mt-3 rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("SQL Lens 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不可信，请重新加载后再查询。")}</span>
              </div>
            );
          }
          const report = view.latest;
          const statusLabel =
            view.status.state === "running"
              ? t("查询中")
              : view.status.state === "completed"
                ? t("已完成")
                : view.status.state === "failed"
                  ? t("查询失败")
                  : view.status.state === "cancelled"
                    ? t("已取消")
                    : t("等待查询");
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between gap-3 text-[10px] text-[var(--color-faint)]">
                <span className="rounded-full border border-[#dce5f5] bg-[var(--color-soft)] px-2 py-1 font-semibold text-[var(--color-blue)]">
                  {statusLabel}
                </span>
                {view.status.at !== null ? <time className="font-mono">{new Date(view.status.at).toLocaleString(formatLocale())}</time> : null}
              </div>
              {view.status.error !== null ? (
                <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-2 text-[10px] leading-4 text-[var(--color-red)]">
                  {view.status.error}
                </div>
              ) : null}
              {report !== null ? (
                <>
                  <p className="break-all text-[10px] text-[var(--color-faint)]">
                    {t("查询工作区：")}
                    {report.cwd}
                  </p>
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-[11px] text-[var(--color-ink)]" title={report.database}>
                        {report.database}
                      </span>
                      <strong className="shrink-0 font-mono text-[12px] text-[var(--color-blue)]">{report.rowInventory.returned} rows</strong>
                    </div>
                    <code className="mt-2 block max-h-16 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-[var(--color-faint)]">
                      {sqlLensDisplayText(report.query, true)}
                    </code>
                  </div>
                  <p className="break-words text-[10px] text-[var(--color-faint)]">
                    {t("列：")}
                    {report.columns.map((column) => sqlLensDisplayText(column)).join(", ")}
                  </p>
                  <pre className="max-h-56 overflow-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 text-[10px] leading-4 text-[var(--color-muted)]">
                    {sqlLensRowsJson(report.rows)}
                  </pre>
                  {report.rowInventory.truncated ? (
                    <p className="text-[10px] text-[var(--color-amber)]">
                      {t("面板显示 {v0} / {v1} 行；已迭代 {v2} 行，行、列或单元格展示已截断。这不是匹配总行数。", {
                        v0: report.rowInventory.shown,
                        v1: report.rowInventory.returned,
                        v2: report.rowInventory.scanned,
                      })}
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("还没有查询数据库。可让 Agent 调用 sql_readonly。")}
                </div>
              )}
              <div className="flex flex-wrap gap-2 font-mono text-[10px] text-[var(--color-blue)]">
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1">timeout:{view.timeoutMs}ms</span>
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1">rows:{view.limits.rows}</span>
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1">
                  result:{Math.round(view.limits.resultBytes / 1_024)}KiB
                </span>
              </div>
            </div>
          );
        })()
      ) : panel.id === "theme-studio-panel" ? (
        (() => {
          const theme = themeStudioView(panel.data, activeSessionId);
          if (!theme) return <p className="mt-3 text-[11px] text-[var(--color-red)]">{t("主题数据无效，未应用颜色。")}</p>;
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3">
                <strong className="block text-[12px] text-[var(--color-ink)]">{theme.label}</strong>
                <p className="mt-1 text-[10px] text-[var(--color-muted)]">{theme.description}</p>
                <p className="mt-1 break-all text-[10px] text-[var(--color-muted)]">
                  {t("会话：")}
                  {theme.sessionId}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {["light", "midnight", "paper", "high-contrast"].map((id) => (
                  <div key={id} className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-[11px] text-[var(--color-ink)]">
                    {id}
                    {id === theme.theme ? t(" · 当前") : ""}
                  </div>
                ))}
              </div>
              <p className="text-[10px] leading-4 text-[var(--color-muted)]">
                {t("可让 Agent 调用 theme_set 切换预设。")}
                {theme.changedAt ? t("最近选择：{v0}", { v0: theme.changedAt }) : t("使用配置默认主题。")}
              </p>
            </div>
          );
        })()
      ) : panel.id === "mirage-bridge-panel" ? (
        <div className="mt-3 grid gap-3">
          <div
            className={`rounded-lg border px-3 py-3 ${data?.available === true ? "border-[#b9e6c9] bg-[var(--color-green-soft)]" : data?.available === false ? "border-[#f3dfab] bg-[var(--color-amber-soft)]" : "border-[var(--color-line)] bg-[var(--color-soft)]"}`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("官方 Mirage CLI")}</span>
              <strong
                className={`text-[11px] ${data?.available === true ? "text-[var(--color-green)]" : data?.available === false ? "text-[var(--color-amber)]" : "text-[var(--color-faint)]"}`}
              >
                {data?.available === true ? t("已连接") : data?.available === false ? t("未检测到") : t("未检查")}
              </strong>
            </div>
            <p className="mt-2 truncate font-mono text-[10px] text-[var(--color-muted)]">{value(data?.version ?? data?.executable ?? "mirage")}</p>
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">{t("虚拟工作区：{v0}", { v0: value(data?.workspaceId ?? t("未配置")) })}</p>
          </div>
          {data?.lastRun && typeof data.lastRun === "object" ? (
            (() => {
              const run = data.lastRun as Record<string, unknown>;
              return (
                <div
                  className={`rounded-lg border px-3 py-3 ${run.exitCode === 0 ? "border-[#b9e6c9] bg-[var(--color-green-soft)]" : "border-[#f4caca] bg-[var(--color-red-soft)]"}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-[10px] text-[var(--color-ink)]">{value(run.command ?? "")}</span>
                    <strong className={`shrink-0 text-[11px] ${run.exitCode === 0 ? "text-[var(--color-green)]" : "text-[var(--color-red)]"}`}>
                      exit {value(run.exitCode ?? "—")}
                    </strong>
                  </div>
                  <p className="mt-1 text-[10px] text-[var(--color-muted)]">{t("耗时 {v0} ms", { v0: value(run.durationMs ?? 0) })}</p>
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("先调用 mirage_doctor 检查 CLI，再调用 mirage_execute。")}
            </div>
          )}
          {data?.lastError ? <p className="text-[10px] leading-4 text-[var(--color-amber)]">{value(data.lastError)}</p> : null}
        </div>
      ) : panel.id === "docker-sandbox-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const view = dockerSandboxPanelView(data);
            if (view.malformed) {
              return (
                <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                  <strong className="block text-[12px]">{t("Docker Sandbox 面板数据异常")}</strong>
                  <span className="mt-1 block">{t("面板数据不完整或不可信，请重新加载后再运行。")}</span>
                </div>
              );
            }
            const run = view.latest;
            const successful = run?.status === "completed" && run.exitCode === 0;
            return (
              <>
                {run !== null ? (
                  <div
                    className={`rounded-lg border px-3 py-3 ${successful ? "border-[#b9e6c9] bg-[var(--color-green-soft)]" : "border-[#f4caca] bg-[var(--color-red-soft)]"}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-[11px] text-[var(--color-ink)]">{run.image}</span>
                      <strong className={`shrink-0 font-mono text-[12px] ${successful ? "text-[var(--color-green)]" : "text-[var(--color-red)]"}`}>
                        {run.status === "timed_out" ? t("超时") : `exit ${run.exitCode}`}
                      </strong>
                    </div>
                    <p className="mt-2 break-all font-mono text-[10px] leading-4 text-[var(--color-muted)]">
                      {run.command.map((argument) => JSON.stringify(argument)).join(" ")}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-[var(--color-faint)]">
                      <span>{run.write ? t("工作区可写（已确认）") : t("工作区只读")}</span>
                      <span>{t("{v0} 个 argv 参数", { v0: run.commandCount })}</span>
                      {run.truncated ? <span>{t("面板明细已截断")}</span> : null}
                    </div>
                    {run.output ? (
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--color-surface)]/70 px-2 py-2 text-[10px] leading-4 text-[var(--color-muted)]">
                        {run.output}
                      </pre>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                    {t("还没有沙箱运行。仅使用本地镜像，默认无网络、工作区只读。")}
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
                    <span
                      className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]"
                      key={key}
                    >
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
              <p className="break-all text-[10px] text-[var(--color-faint)]">
                {t("工作区：")}
                {view.cwd}
              </p>
              {view.status.state === "failed" || view.status.state === "cancelled" ? (
                <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-2 text-[11px] text-[var(--color-red)]">
                  {t("最近一次校验{v0}。{v1}", { v0: view.status.state === "cancelled" ? t("已取消") : t("失败"), v1: view.status.error ?? "" })}
                </div>
              ) : null}
              {report !== null ? (
                <>
                  <p className="break-all font-mono text-[10px] text-[var(--color-muted)]">{report.path}</p>
                  <div
                    className={`rounded-lg border px-3 py-3 text-[11px] ${report.valid ? "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]" : "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]"}`}
                  >
                    {report.valid ? t("YAML 语法有效。") : t("发现 {count} 个语法错误。", { count: report.errorCount })}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      [t("文档"), report.documents],
                      [t("错误"), report.errorCount],
                      [t("警告"), report.warningCount],
                    ].map(([label, entryValue]) => (
                      <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2" key={label}>
                        <span className="block text-[10px] text-[var(--color-faint)]">{label}</span>
                        <strong className="mt-1 block text-[17px] text-[var(--color-ink)]">{entryValue}</strong>
                      </div>
                    ))}
                  </div>
                  {!report.valid && report.errors.length > 0 ? (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[#f4caca] bg-[var(--color-soft)] p-3 text-[10px] leading-4 text-[var(--color-red)]">
                      {report.errors.map((error) => `${error.line ?? "?"}:${error.column ?? "?"} ${error.message}`).join("\n")}
                    </pre>
                  ) : null}
                  {report.warnings.length > 0 ? (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--color-amber-soft)] p-3 text-[10px] leading-4 text-[var(--color-amber)]">
                      {report.warnings.map((warning) => `${warning.line ?? "?"}:${warning.column ?? "?"} ${warning.message}`).join("\n")}
                    </pre>
                  ) : null}
                  {report.diagnosticsTruncated ? <p className="text-[10px] text-[var(--color-amber)]">{t("诊断预览已截断，完整计数保留在摘要中。")}</p> : null}
                </>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("还没有校验 YAML。可让 Agent 调用 yaml_validate。")}
                </div>
              )}
              <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]">
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
              <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("Browser Session 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不可信，请重新连接后再试。")}</span>
              </div>
            );
          }
          const tabs = view.tabs;
          const latest = view.latest;
          const latestAction = latest?.screenshot
            ? t("已截图")
            : latest?.clicked === true
              ? t("已点击")
              : latest?.status === "read" || typeof latest?.text === "string"
                ? t("已读取")
                : latest?.status === "navigated"
                  ? t("已导航")
                  : undefined;
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-[11px] text-[var(--color-ink)]">{view.endpoint || t("本地浏览器未连接")}</span>
                  <span
                    className={`rounded-full px-2 py-1 text-[10px] font-semibold ${view.connected ? "bg-[var(--color-green-soft)] text-[var(--color-green)]" : "bg-[var(--color-amber-soft)] text-[var(--color-amber)]"}`}
                  >
                    {view.connected ? t("已连接") : t("未连接")}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-[var(--color-faint)]">
                  {t("Chrome DevTools Protocol · 显示 {v0}/{v1} 个可调试页面", { v0: view.inventory.shown, v1: view.inventory.total })}
                </p>
                {!view.connected ? (
                  <p className="mt-2 text-[11px] text-[var(--color-red)]">{t("请使用 remote-debugging-port 启动 Chrome。{v0}", { v0: view.error ?? "" })}</p>
                ) : null}
              </div>
              {latestAction ? (
                <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-2 text-[11px]">
                  <span className="text-[var(--color-muted)]">{t("最近动作")}</span>
                  <strong className="font-mono text-[var(--color-blue)]">{latestAction}</strong>
                </div>
              ) : null}
              {latest?.text !== undefined ? (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3">
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-[var(--color-muted)]">{latest.text}</pre>
                  {latest.previewTruncated ? <p className="mt-2 text-[10px] text-[var(--color-amber)]">{t("面板正文预览已截断。")}</p> : null}
                </div>
              ) : null}
              {latest?.screenshot !== undefined ? (
                <div className="rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-2 text-[10px] text-[var(--color-blue)]">
                  {t("截图元数据：{v0} · {v1} bytes", { v0: latest.screenshot.mimeType, v1: latest.screenshot.bytes.toLocaleString(formatLocale()) })}
                </div>
              ) : null}
              {tabs.length > 0 ? (
                <div className="grid gap-2">
                  {tabs.map((tab) => (
                    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2" key={tab.targetId}>
                      <strong className="block truncate text-[11px] text-[var(--color-ink)]">{tab.title}</strong>
                      <span className="mt-1 block truncate font-mono text-[10px] text-[var(--color-faint)]">{tab.url}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("没有可调试的浏览器页面。")}
                </div>
              )}
              <div className="flex flex-wrap gap-2 text-[10px] text-[var(--color-faint)]">
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[var(--color-blue)]">tabs</span>
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[var(--color-blue)]">read</span>
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[var(--color-blue)]">click</span>
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[var(--color-blue)]">screenshot</span>
              </div>
            </div>
          );
        })()
      ) : panel.id === "mcp-client-panel" ? (
        (() => {
          const view = mcpClientPanelView(data);
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-[11px] text-[var(--color-ink)]">{value(view.server ?? t("尚未连接 MCP 服务器"))}</span>
                  <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-[var(--color-blue)]">
                    <span>{t("{v0} 工具", { v0: view.inventory.tools.total })}</span>
                    <span className="text-[var(--color-faint)]">·</span>
                    <span>{t("{v0} 资源", { v0: view.inventory.resources.total })}</span>
                    <span className="text-[var(--color-faint)]">·</span>
                    <span>{t("{v0} 提示", { v0: view.inventory.prompts.total })}</span>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-[var(--color-faint)]">
                  {view.lastCall === null ? t("使用 mcp_list_tools 发现 stdio 工具。") : t("最近调用：{call}", { call: view.lastCall })}
                </p>
              </div>
              {view.tools.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {view.tools.map((tool, index) => (
                    <span
                      className="max-w-full truncate rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]"
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
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-faint)]">{t("资源")}</span>
                  <div className="flex flex-wrap gap-2">
                    {view.resources.map((resource, index) => (
                      <span
                        className="max-w-full truncate rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-muted)]"
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
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-faint)]">{t("提示模板")}</span>
                  <div className="flex flex-wrap gap-2">
                    {view.prompts.map((prompt, index) => (
                      <span
                        className="max-w-full truncate rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-muted)]"
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
                      className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[10px]"
                      key={`${server.id}-${index}`}
                    >
                      <span className="truncate font-mono text-[var(--color-ink)]">{server.id}</span>
                      <span className={server.status === "running" ? "text-[var(--color-green)]" : "text-[var(--color-faint)]"}>{server.status}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {view.inventory.tools.truncated || view.inventory.resources.truncated || view.inventory.prompts.truncated || view.inventory.servers.truncated ? (
                <p className="text-[10px] text-[var(--color-faint)]">{t("面板仅显示受限预览；完整清单请使用对应 MCP 列表工具。")}</p>
              ) : null}
              <p className="font-mono text-[9px] text-[var(--color-faint)]">
                {t("响应上限 {v0} KiB · 请求超时 {v1} 秒", {
                  v0: Math.round(view.limits.responseBytes / 1024),
                  v1: Math.round(view.limits.requestTimeoutMs / 1000),
                })}
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
                      <li
                        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                        key={`${value(server.id ?? "server")}-${index}`}
                      >
                        <div className="flex items-center gap-2">
                          <strong className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-ink)]">
                            {value(server.id, t("未命名服务器"))}
                          </strong>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[9px] ${healthy ? "bg-[var(--color-green-soft)] text-[var(--color-green)]" : "bg-[var(--color-red-soft)] text-[var(--color-red)]"}`}
                          >
                            {value(server.status, "unknown")}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--color-faint)]">
                          <span>{typeof server.toolCount === "number" ? t("{v0} 个 MCP 工具", { v0: server.toolCount }) : t("工具尚未查询")}</span>
                          <span>·</span>
                          <span>{value(server.statusSource, "runtime")}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {data?.available === false ? `MCP ${t("不可用")}` : t("当前没有 MCP 服务器快照。")}
                </div>
              )}
              <div className="text-[10px] text-[var(--color-faint)]">
                {t("读取 MCP 运行状态；工具列表通过 mcp_panel 的 tools 操作查询，健康建议通过 health 操作查看。")}
                {data?.writesEnabled === true ? ` 已启用 profile patch 写入：${value(data.patchPath)}` : t(" profile patch 写入未配置，apply 会被拒绝。")}
              </div>
            </div>
          );
        })()
      ) : panel.id === "mock-server-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3">
            <span className="font-mono text-[11px] text-[var(--color-ink)]">{data?.running === true ? t("运行中") : t("未启动")}</span>
            <strong className="font-mono text-[11px] text-[var(--color-blue)]">{t("{v0} 路由", { v0: value(data?.routes ?? 0) })}</strong>
          </div>
          {data?.url ? <code className="rounded-md bg-[var(--color-surface)] px-3 py-2 text-[10px] text-[var(--color-muted)]">{value(data.url)}</code> : null}
          {data?.lastRequest ? <p className="text-[11px] text-[var(--color-faint)]">{t("最近请求：{v0}", { v0: value(data.lastRequest) })}</p> : null}
          {typeof data?.lastError === "string" && data.lastError.length > 0 ? (
            <p
              role="alert"
              className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-2 text-[11px] [overflow-wrap:anywhere] text-[var(--color-red)]"
            >
              {data.lastError.slice(0, 500)}
            </p>
          ) : null}
        </div>
      ) : panel.id === "cli-notifier-panel" ? (
        <div className="mt-3 grid gap-3">
          <p className="text-[10px] leading-4 text-[var(--color-faint)]">{t("提交成功不代表通知已显示或已读；请检查系统通知设置。")}</p>
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3">
            <span className="font-mono text-[11px] text-[var(--color-ink)]">{data?.enabled === true ? t("已启用") : t("已停用")}</span>
            <span className="font-mono text-[10px] text-[var(--color-faint)]">
              {value(data?.platform ?? "unknown")} · {value(data?.timeoutMs ?? 10_000)}ms
            </span>
          </div>
          {Array.isArray(data?.notifications) && data.notifications.length > 0 ? (
            <div className="grid gap-2">
              {data.notifications.slice(0, 5).map((notification, index) => {
                const item = typeof notification === "object" && notification !== null ? (notification as Record<string, unknown>) : {};
                return (
                  <div
                    className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[10px]"
                    key={`${value(item.time ?? "notification")}-${index}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-[var(--color-ink)]">{value(item.title ?? "Pi Harness")}</strong>
                      <span className={item.delivered === true ? "text-[var(--color-green)]" : "text-[var(--color-red)]"}>
                        {item.delivered === true ? t("已提交系统") : t("未提交系统")}
                      </span>
                    </div>
                    <span className="mt-1 block text-[var(--color-muted)]">{value(item.message, "")}</span>
                    {item.delivered !== true && item.reason ? (
                      <span className="mt-1 block break-words text-[var(--color-red)]">{value(item.reason)}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("还没有发送通知。")}
            </div>
          )}
        </div>
      ) : panel.id === "obsidian-sync-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3">
            <span className="font-mono text-[11px] text-[var(--color-ink)]">{data?.configured === true ? t("已配置") : t("未配置 vault")}</span>
            <span className="font-mono text-[10px] text-[var(--color-faint)]">Markdown</span>
          </div>
          {data?.vaultPath ? (
            <code className="truncate rounded-md bg-[var(--color-surface)] px-3 py-2 text-[10px] text-[var(--color-muted)]">{value(data.vaultPath)}</code>
          ) : null}
          {data?.last !== null && data?.last !== undefined && typeof data.last === "object" ? (
            <p className="text-[11px] text-[var(--color-faint)]">
              {t("最近写入：{v0}", { v0: value((data.last as Record<string, unknown>).relativePath ?? "note.md") })}
            </p>
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("还没有同步笔记。")}
            </div>
          )}
        </div>
      ) : panel.id === "web-research-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-3 text-[11px]">
            <span className="text-[var(--color-blue)]">{data?.keyless === true ? t("未配置搜索 API key") : t("已配置搜索 API key")}</span>
            <strong className="font-mono text-[var(--color-blue)]">{t("最多 {v0} 条", { v0: value(data?.maxResults ?? 8) })}</strong>
          </div>
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
              const items = Array.isArray(report.items) ? report.items : [];
              return (
                <>
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <strong className="truncate text-[var(--color-ink)]">{value(report.query ?? t("网页搜索"))}</strong>
                    <span className="shrink-0 font-mono text-[var(--color-faint)]">
                      {t("前 {v0} / 共 {v1}", { v0: Math.min(8, items.length), v1: items.length })}
                    </span>
                  </div>
                  {report.status === "degraded" ? (
                    <p className="rounded-lg bg-[var(--color-amber-soft)] px-3 py-2 text-[11px] text-[var(--color-amber)]">
                      {t("搜索结果不完整或没有可用来源。")}
                      {value(report.summary, "")}
                    </p>
                  ) : null}
                  <div className="grid gap-2">
                    {items.slice(0, 8).map((entry, index) => {
                      const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                      return (
                        <a
                          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 transition-colors hover:border-[#bdd0f5] hover:bg-[var(--color-soft)]"
                          href={value(item.url, "")}
                          key={`${value(item.url ?? "source")}-${index}`}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <strong className="block truncate text-[11px] text-[var(--color-ink)]">{value(item.title ?? item.url ?? t("来源"))}</strong>
                          <span className="mt-1 block truncate font-mono text-[10px] text-[var(--color-blue)]">{value(item.source ?? item.url, "")}</span>
                          {item.snippet ? (
                            <span className="mt-1 line-clamp-2 block text-[10px] leading-4 text-[var(--color-muted)]">{value(item.snippet)}</span>
                          ) : null}
                        </a>
                      );
                    })}
                  </div>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
              {t("还没有联网搜索。可让 Agent 调用 web_search；单页读取使用 read_page。")}
            </div>
          )}
          <p className="text-[10px] text-[var(--color-faint)]">
            {t("搜索词会发送到 Firecrawl；页面读取{v0}。", {
              v0: data?.readPageAvailable === true ? t("已复用本地 Browser Fetch") : t("需要启用 Browser Fetch"),
            })}
          </p>
        </div>
      ) : panel.id === "browser-fetch-panel" ? (
        (() => {
          const view = browserFetchPanelView(data);
          if (view.malformed) {
            return (
              <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("Browser Fetch 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不可信，请重新加载后再抓取。")}</span>
              </div>
            );
          }
          const result = view.latest;
          return (
            <div className="mt-3 grid gap-3">
              {result === null ? (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("还没有抓取网页。默认阻止本地和私有网络目标。")}
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-[var(--color-soft)] px-3 py-3">
                    <span className="truncate font-mono text-[11px] text-[var(--color-ink)]">{value(result.finalUrl || result.url || "page")}</span>
                    <strong className="font-mono text-[12px] text-[var(--color-green)]">HTTP {value(result.status || "—")}</strong>
                  </div>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 text-[10px] leading-4 text-[var(--color-muted)]">
                    {value(result.text, "")}
                  </pre>
                  {/* One notice per line. They used to sit next to each other inside a single paragraph, which reads fine in Chinese and runs two sentences together in every language that separates them with a space. */}
                  {result.truncated ? <p className="text-[10px] text-[var(--color-amber)]">{t("响应正文已达到抓取上限。")}</p> : null}
                  {result.previewTruncated ? <p className="text-[10px] text-[var(--color-amber)]">{t("面板仅显示有界预览。")}</p> : null}
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]">
                  max:{value(Math.round(view.limits.responseBytes / 1024))}KiB
                </span>
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]">
                  timeout:{value(view.limits.timeoutMs)}ms
                </span>
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]">
                  redirects:{value(view.limits.redirects)}
                </span>
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]">
                  scripts:disabled
                </span>
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]">
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
              ? t("数据异常")
              : view.status.state === "running"
                ? t("检查中")
                : view.status.state === "failed"
                  ? t("检查失败")
                  : view.status.state === "cancelled"
                    ? t("已取消")
                    : view.status.state === "completed"
                      ? t("已完成")
                      : t("等待检查");
          return (
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between gap-3 text-[10px] text-[var(--color-faint)]">
                <span className="rounded-full border border-[#dce5f5] bg-[var(--color-soft)] px-2 py-1 font-semibold text-[var(--color-blue)]">
                  {statusLabel}
                </span>
                {view.status.at !== null ? <time className="font-mono">{new Date(view.status.at).toLocaleString(formatLocale())}</time> : null}
              </div>
              {view.status.error !== null ? (
                <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-2 text-[10px] leading-4 text-[var(--color-red)]">
                  {view.status.error}
                </div>
              ) : null}
              {view.malformed ? (
                <div className="rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-2 text-[10px] leading-4 text-[var(--color-red)]">
                  {t("面板数据不完整或不可信，未显示语言包统计。")}
                </div>
              ) : null}
              {report !== null ? (
                <>
                  <div
                    className={`rounded-lg border px-3 py-3 text-[11px] ${healthy ? "border-[#b9e6c9] bg-[var(--color-green-soft)] text-[var(--color-green)]" : "border-[#f4caca] bg-[var(--color-red-soft)] text-[var(--color-red)]"}`}
                  >
                    {healthy ? t("语言包键完全一致。") : t("缺失 {missing} 个，额外 {extra} 个。", { missing: report.missingTotal, extra: report.extraTotal })}
                  </div>
                  <div className="grid gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3 font-mono text-[10px]">
                    <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                      <span className="text-[var(--color-faint)]">{t("基准")}</span>
                      <span className="truncate text-[var(--color-ink)]" title={report.base}>
                        {report.base}
                      </span>
                    </div>
                    <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                      <span className="text-[var(--color-faint)]">{t("目标")}</span>
                      <span className="truncate text-[var(--color-ink)]" title={report.target}>
                        {report.target}
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                      <span className="block text-[10px] text-[var(--color-faint)]">{t("基准键")}</span>
                      <strong className="mt-1 block text-[17px] text-[var(--color-ink)]">{report.baseKeys}</strong>
                    </div>
                    <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2">
                      <span className="block text-[10px] text-[var(--color-faint)]">{t("目标键")}</span>
                      <strong className="mt-1 block text-[17px] text-[var(--color-ink)]">{report.targetKeys}</strong>
                    </div>
                  </div>
                  {report.missing.length > 0 || report.extra.length > 0 ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {[
                        { label: t("缺失 · {count}", { count: report.missingTotal }), keys: report.missing, tone: "text-[var(--color-red)]" },
                        { label: t("额外 · {count}", { count: report.extraTotal }), keys: report.extra, tone: "text-[var(--color-amber)]" },
                      ].map((group) => (
                        <div className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3" key={group.label}>
                          <strong className={`text-[10px] ${group.tone}`}>{group.label}</strong>
                          <ul className="mt-2 max-h-36 space-y-1 overflow-auto font-mono text-[10px] text-[var(--color-ink)]">
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
                  {report.truncated ? (
                    <p className="text-[10px] text-[var(--color-amber)]">{t("面板仅显示有界键列表；完整结果保留在工具调用详情中。")}</p>
                  ) : null}
                </>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("还没有检查语言包。可让 Agent 调用 i18n_check。")}
                </div>
              )}
              <div className="flex flex-wrap gap-2 font-mono text-[10px] text-[var(--color-blue)]">
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1">
                  file:{Math.round(view.limits.fileBytes / 1_048_576)}MiB
                </span>
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1">depth:{view.limits.depth}</span>
                <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1">keys:{view.limits.keysPerFile}</span>
              </div>
            </div>
          );
        })()
      ) : panel.id === "cleaner-panel" ? (
        (() => {
          const view = cleanerPanelView(data);
          if (view.malformed || view.inventory === null) {
            return (
              <div className="mt-3 rounded-lg border border-[#f4caca] bg-[var(--color-red-soft)] px-3 py-3 text-[11px] text-[var(--color-red)]">
                <strong className="block text-[12px]">{t("Cleaner 面板数据异常")}</strong>
                <span className="mt-1 block">{t("面板数据不完整或不可信，请重新加载后再执行清理。")}</span>
              </div>
            );
          }
          const inventory = view.inventory;
          const activity = view.lastCleanup;
          const statusLabel =
            activity?.status === "running"
              ? t("清理中")
              : activity?.status === "completed"
                ? t("已完成")
                : activity?.status === "cancelled"
                  ? t("已取消")
                  : activity?.status === "failed"
                    ? t("清理失败")
                    : t("尚未清理");
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("Git 胶囊库存")}</span>
                  <strong className="font-mono text-[12px] text-[var(--color-blue)]">{t("{v0} 个", { v0: inventory.total })}</strong>
                </div>
                <p className="mt-2 text-[11px] text-[var(--color-faint)]">{t("仅清理 agent 数据目录中的 .patch 胶囊，必须显式 confirm=true。")}</p>
                <div className="mt-3 flex flex-wrap gap-2 font-mono text-[10px] text-[var(--color-blue)]">
                  <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1">capsules:{view.limits.capsules}</span>
                  <span className="rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1">scan:{view.limits.directoryEntries}</span>
                </div>
              </div>
              {activity !== null ? (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3">
                  <div className="flex items-center justify-between gap-3 text-[10px]">
                    <strong className={activity.status === "failed" ? "text-[var(--color-red)]" : "text-[var(--color-ink)]"}>{statusLabel}</strong>
                    {activity.at !== null ? (
                      <time className="font-mono text-[var(--color-faint)]">{new Date(activity.at).toLocaleString(formatLocale())}</time>
                    ) : null}
                  </div>
                  <div className="mt-2 flex gap-4 text-[11px] text-[var(--color-faint)]">
                    <span>
                      {t("已删")} <strong className="font-mono text-[var(--color-ink)]">{activity.removed}</strong>
                    </span>
                    <span>
                      {t("保留")} <strong className="font-mono text-[var(--color-ink)]">{activity.kept ?? "—"}</strong>
                    </span>
                    <span>
                      {t("请求保留")} <strong className="font-mono text-[var(--color-ink)]">{activity.requestedKeep}</strong>
                    </span>
                  </div>
                  {activity.error !== null ? <p className="mt-2 break-words text-[10px] leading-4 text-[var(--color-red)]">{activity.error}</p> : null}
                </div>
              ) : null}
              {view.capsules.length > 0 ? (
                <div className="max-h-48 overflow-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
                  {view.capsules.map((capsule, index) => (
                    <div
                      className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-3 py-2 last:border-b-0"
                      key={`${capsule.name}-${index}`}
                    >
                      <span className="truncate font-mono text-[10px] text-[var(--color-ink)]" title={capsule.name}>
                        {capsule.name}
                      </span>
                      <span className="shrink-0 font-mono text-[9px] text-[var(--color-faint)]">{capsule.bytes.toLocaleString(formatLocale())} B</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-soft)] px-3 py-3 text-[11px] text-[var(--color-faint)]">
                  {t("当前没有可清理的 Git 胶囊。")}
                </div>
              )}
              {inventory.truncated ? (
                <p className="text-[10px] text-[var(--color-amber)]">
                  {t("面板显示 {v0} / {v1} 个条目；清理工具仍按完整的有界库存执行。", { v0: inventory.shown, v1: inventory.total })}
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
                <div className="rounded-lg bg-[var(--color-red-soft)] px-3 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-[var(--color-red)]">{t("聚合后的失败记录")}</span>
                    <strong className="font-mono text-[17px] text-[var(--color-red)]">{view.total}</strong>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-[var(--color-red)]">
                    <span>{t("观测 {v0} 次", { v0: view.observed })}</span>
                    <span>{t("容量 {v0} / {v1}", { v0: view.total, v1: view.capacity })}</span>
                    {view.dropped > 0 ? <span>{t("已淘汰 {v0} 条旧记录", { v0: view.dropped })}</span> : null}
                    {view.truncated ? <span>{t("面板明细已截断")}</span> : null}
                  </div>
                </div>
                <div className="max-h-56 overflow-auto rounded-lg border border-[var(--color-line)]">
                  {view.failures.length > 0 ? (
                    view.failures.map((failure, index) => (
                      <div className="border-b border-[var(--color-line)] px-3 py-2 last:border-b-0" key={`${failure.time ?? "failure"}-${index}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] text-[var(--color-red)]">{failure.source}</span>
                          <span className="flex shrink-0 items-center gap-2 font-mono text-[9px] text-[var(--color-faint)]">
                            {failure.occurrences > 1 ? <strong className="text-[var(--color-red)]">×{failure.occurrences}</strong> : null}
                            {failure.time === null ? t("时间未知") : `${failure.time.slice(11, 19)} UTC`}
                          </span>
                        </div>
                        <p className="mt-1 break-words text-[11px] leading-4 text-[var(--color-muted)]">{failure.message}</p>
                      </div>
                    ))
                  ) : (
                    <div className="px-3 py-4 text-[12px] text-[var(--color-faint)]">{t("暂无失败记录。")}</div>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      ) : panel.id === "context-insight-panel" ? (
        (() => {
          const view = contextInsightsPanelView(data, activeSessionId ?? null);
          if (view.malformed) return <p className="mt-3 text-[11px] text-[var(--color-red)]">{t("上下文洞察面板数据不完整或不一致。")}</p>;
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[#e3eaf8] bg-[var(--color-blue-soft)] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-muted)]">{t("上下文占用")}</span>
                  <strong className="text-[13px] font-semibold text-[var(--color-blue)]">{view.percent === null ? "—" : `${view.percent}%`}</strong>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-blue-soft)]">
                  <div className="h-full rounded-full bg-[#5d8bea] transition-[width] duration-300" style={{ width: `${Math.min(100, view.percent ?? 0)}%` }} />
                </div>
                <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                  {view.tokens === null ? t("令牌数未知") : `${view.tokens.toLocaleString(formatLocale())} tokens`}
                  {view.contextWindow === null ? "" : t(" / {limit} 上限", { limit: view.contextWindow.toLocaleString(formatLocale()) })}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  [t("消息"), view.messages],
                  [t("事件"), view.events],
                  [t("压缩"), view.compactions],
                ].map(([label, item]) => (
                  <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2" key={value(label)}>
                    <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                    <strong className="mt-1 block text-[17px] font-semibold text-[var(--color-ink)]">{value(item)}</strong>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("消息组成")}</span>
                  <span className="text-[10px] text-[var(--color-faint)]">
                    {view.messagesTruncated
                      ? t("最近 {scanned} / {total} 条", { scanned: view.scannedMessages, total: view.messages })
                      : t("全部 {count} 条", { count: view.scannedMessages })}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-5 gap-1.5">
                  {[
                    [t("用户"), view.composition.user],
                    [t("助手"), view.composition.assistant],
                    [t("工具"), view.composition.toolResult],
                    [t("系统"), view.composition.system],
                    [t("其他"), view.composition.other],
                  ].map(([label, item]) => (
                    <div className="rounded bg-[var(--color-soft)] px-2 py-1.5 text-center" key={value(label)}>
                      <span className="block text-[10px] text-[var(--color-faint)]">{value(label)}</span>
                      <strong className="mt-0.5 block font-mono text-[13px] text-[var(--color-ink)]">{value(item)}</strong>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[var(--color-ink)]">{t("最近上下文事件")}</span>
                  <span className="text-[10px] text-[var(--color-faint)]">
                    {t("显示 {v0} / 保留 {v1} 条", { v0: view.limits.displayedEvents, v1: view.limits.retainedEvents })}
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
                          <span className="font-mono text-[10px] text-[var(--color-muted)]">{event.type}</span>
                          <span className="text-[10px] text-[var(--color-faint)]">
                            {event.at === null ? "—" : new Date(event.at).toLocaleTimeString(formatLocale())}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="py-2 text-[11px] text-[var(--color-faint)]">{t("暂无上下文事件。")}</div>
                  )}
                </div>
                {view.recentEventsTruncated ? <p className="mt-2 text-[10px] text-[var(--color-faint)]">{t("更早事件已按浏览器显示上限省略。")}</p> : null}
              </div>
            </div>
          );
        })()
      ) : (
        <div className="mt-3 grid gap-2">
          {entries.map(([key, item]) => (
            <div className="rounded-lg bg-[var(--color-soft)] px-3 py-2" key={key}>
              <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">{key}</span>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-[var(--color-ink)]">
                {pluginPanelValue(item)}
              </pre>
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
        aria-label={t("确认卸载插件")}
        aria-modal="true"
        className="plugin-confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <strong>{t("卸载插件？")}</strong>
            <small>{t("将从运行配置中移除，之后可以从插件市场重新安装。")}</small>
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
            {t("取消")}
          </button>
          <button className="danger" disabled={busy} onClick={onConfirm} type="button">
            {busy ? t("卸载中…") : t("确认卸载")}
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
        <button aria-label={t("向左查看更多分类")} className="marketplace-category-scroll previous" onClick={() => scroll(-1)} type="button">
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
              <span className={active ? "font-mono text-[10px] text-[var(--color-blue)]" : "font-mono text-[10px] text-[var(--color-faint)]"}>
                {category.count}
              </span>
            </button>
          );
        })}
      </nav>
      {canScrollRight && (
        <button aria-label={t("向右查看更多分类")} className="marketplace-category-scroll next" onClick={() => scroll(1)} type="button">
          ›
        </button>
      )}
    </div>
  );
}

function Plugins({
  plugins,
  panels,
  activeSessionId,
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
  activeSessionId?: string;
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
      const category = catalogByPackage.get(plugin.name)?.category ?? plugin.category ?? { id: "other", label: t("其他") };
      const current = counts.get(category.id);
      counts.set(category.id, { ...category, count: (current?.count ?? 0) + 1 });
    }
    return marketplaceCategoryTabs(
      [...counts.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, formatLocale())),
    );
  }, [catalogByPackage, installedPlugins]);
  const visiblePlugins = useMemo(() => {
    return installedPlugins.filter((plugin) => {
      const metadata = catalogByPackage.get(plugin.name);
      const category = metadata?.category ?? plugin.category ?? { id: "other", label: t("其他") };
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
      if (result?.restartRequired === true) setPluginNotice(restartRequiredNotice());
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
          <div aria-label={t("插件目录")} className="segmented">
            <button aria-pressed="true" className="active" type="button">
              {t("已安装")}
            </button>
            <button aria-pressed="false" onClick={onMarketplace} type="button">
              {t("插件市场")}
            </button>
          </div>
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              onToml();
            }}
          >
            {t("查看运行配置")}
          </a>
        </div>
        <div className="plugins-toolbar">
          <input
            aria-label={t("搜索已安装插件")}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("搜索名称、包名或能力…")}
            type="search"
            value={query}
          />
          <span aria-live="polite">
            {t("{v0} 个插件", { v0: query.trim() || categoryFilter ? `${visiblePlugins.length} / ${installedPlugins.length}` : `${installedPlugins.length}` })}
          </span>
        </div>
        <PluginCategoryNav activeCategory={categoryFilter} categories={installedCategories} label={t("已安装插件分类")} onChange={setCategoryFilter} />
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
                            {awaitingRestart ? t("重启后生效") : plugin.enabled ? t("运行中") : t("已停用")}
                          </span>
                          {categoryLabel && <span className="capability">{categoryLabel}</span>}
                          {categoryLabel !== shortName && <span className="capability">{shortName}</span>}
                        </div>
                        <div className="plugin-actions">
                          {plugin.removable ? (
                            <>
                              <button
                                aria-label={plugin.enabled ? t("停用 {plugin}", { plugin: pluginTitle }) : t("启用 {plugin}", { plugin: pluginTitle })}
                                aria-pressed={plugin.enabled}
                                className="plugin-switch-button"
                                disabled={busyPlugin !== undefined || awaitingRestart}
                                onClick={() => void runPluginAction(plugin, (item) => onToggle(item))}
                                title={awaitingRestart ? t("插件已安装但还没加载，重启 Pi Harness 后才能停用或启用") : undefined}
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
                                {t("卸载")}
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
                    <button
                      aria-label={t("查看 {plugin} 详情", { plugin: pluginTitle })}
                      className="plugin-detail-link"
                      onClick={() => onOpenDetail(plugin)}
                      type="button"
                    >
                      {t("查看详情 →")}
                    </button>
                    {panelPluginIds.has(plugin.name) ? <span>{t("实时面板")}</span> : null}
                  </footer>
                </article>
              );
            })}
            {!installedPlugins.length ? (
              <div className="empty-state">{t("还没有安装可管理的插件。去插件市场安装一个吧。")}</div>
            ) : !visiblePlugins.length ? (
              <div className="empty-state">{t("没有匹配当前搜索与分类条件的已安装插件。")}</div>
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
            <section className="mt-4 border-t border-[var(--color-line)] pt-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <div>
                  <strong className="text-[13px] font-semibold text-[var(--color-ink)]">{t("其他插件面板")}</strong>
                  <p className="mt-1 text-[12px] text-[var(--color-faint)]">{t("由已启用插件提供的实时状态。")}</p>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">LIVE</span>
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                {panels
                  .filter((panel) => !installedPlugins.some((plugin) => plugin.name === panel.pluginId))
                  .map((panel) => (
                    <PluginPanelCard activeSessionId={activeSessionId} key={panel.id} panel={panel} />
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
  activeSessionId,
  metadata,
  capabilityLabel,
  onBack,
  onToggle,
  onUninstall,
}: {
  plugin: ClientPlugin;
  panel?: ClientPluginPanel;
  activeSessionId?: string;
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
      if (result?.restartRequired === true) setNotice(restartRequiredNotice());
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
            {t("← 已安装插件")}
          </a>
          <span>{t("插件详情")}</span>
        </div>
        <div className="plugin-detail-content">
          <header className="border-b border-[var(--color-line)] pb-7">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span
                className={`rounded px-2 py-1 font-mono text-[10px] ${plugin.enabled ? "bg-[var(--color-green-soft)] text-[var(--color-green)]" : "bg-[var(--color-soft)] text-[var(--color-faint)]"}`}
              >
                {plugin.enabled ? t("运行中") : t("已停用")}
              </span>
              <span className="rounded bg-[var(--color-blue-soft)] px-2 py-1 text-[10px] text-[var(--color-blue)]">
                {metadata?.category.label ?? plugin.category?.label ?? t("运行时插件")}
              </span>
              <span className="rounded bg-[var(--color-blue-soft)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]">{capability(plugin.name)}</span>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-5">
              <div className="min-w-0">
                <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-faint)]">PLUGIN DETAIL</p>
                <h1 className="text-3xl font-semibold tracking-[-0.03em] text-[var(--color-ink)]">{title}</h1>
                <code className="mt-3 block break-all text-[12px] text-[var(--color-faint)]">
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
                    title={awaitingRestart ? t("插件已安装但还没加载，重启 Pi Harness 后才能停用或启用") : undefined}
                    type="button"
                  >
                    {busyAction === "toggle" ? t("处理中…") : awaitingRestart ? t("等待重启") : plugin.enabled ? t("停用插件") : t("启用插件")}
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
                    {t("卸载插件")}
                  </button>
                </div>
              ) : (
                <span className="rounded-full bg-[var(--color-soft)] px-3 py-1.5 text-[11px] text-[var(--color-faint)]">{t("内置组件")}</span>
              )}
            </div>
            <p className="mt-5 max-w-3xl text-[14px] leading-7 text-[var(--color-muted)]">
              {metadata?.description ?? (plugin.enabled ? t("由当前运行时加载并启用，能力与 hook 已注册。") : t("插件保留在运行配置中，但当前处于停用状态。"))}
            </p>
            {error && (
              <p className="mt-3 text-[12px] text-[var(--color-red)]" role="alert">
                {t("操作失败：{v0}", { v0: pluginActionErrorText(error) })}
              </p>
            )}
            {notice && (
              <p className="mt-3 text-[12px] text-[var(--color-amber)]" role="status">
                {notice}
              </p>
            )}
          </header>
          <div className="grid gap-4 py-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-4">
              <section className="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
                <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{t("影响范围")}</h2>
                <div className="mt-4 flex flex-wrap gap-2">
                  {(metadata?.capabilities.length ? metadata.capabilities.map(capabilityLabel) : [capability(plugin.name)]).map((item) => (
                    <span className="rounded-md bg-[var(--color-blue-soft)] px-2 py-1 text-[11px] text-[var(--color-muted)]" key={item}>
                      {item}
                    </span>
                  ))}
                </div>
              </section>
              {metadata?.hooks.length ? (
                <section className="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
                  <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{t("扩展点")}</h2>
                  <div className="mt-4 space-y-2">
                    {metadata.hooks.map((item) => (
                      <div className="rounded-md bg-[var(--color-soft)] px-3 py-2 font-mono text-[11px] text-[var(--color-muted)]" key={item}>
                        {item}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              <section className="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{t("实时详情")}</h2>
                    <p className="mt-1 text-[12px] text-[var(--color-faint)]">{t("当前本机会话中的插件运行状态。")}</p>
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">LIVE</span>
                </div>
                {panel ? (
                  <PluginPanelCard activeSessionId={activeSessionId} inline panel={panel} />
                ) : (
                  <div className="empty-state">{t("这个插件暂未提供实时面板。")}</div>
                )}
              </section>
            </div>
            <aside className="h-fit rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
              <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{t("插件信息")}</h2>
              <dl className="mt-4 divide-y divide-[#eef0f3] text-[12px]">
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[var(--color-faint)]">{t("运行状态")}</dt>
                  <dd className="font-mono text-[var(--color-ink)]">{awaitingRestart ? t("已安装，重启后生效") : plugin.state}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[var(--color-faint)]">{t("配置标识")}</dt>
                  <dd className="max-w-[150px] break-all text-right font-mono text-[var(--color-ink)]">{plugin.id}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[var(--color-faint)]">{t("分类")}</dt>
                  <dd className="text-right text-[var(--color-ink)]">{plugin.category?.label ?? t("运行时插件")}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[var(--color-faint)]">{t("管理方式")}</dt>
                  <dd className="text-right text-[var(--color-ink)]">{plugin.removable ? t("可配置") : t("随运行时加载")}</dd>
                </div>
                {metadata ? (
                  <div className="flex justify-between gap-4 py-3">
                    <dt className="text-[var(--color-faint)]">{t("版本")}</dt>
                    <dd className="font-mono text-[var(--color-ink)]">{metadata.version}</dd>
                  </div>
                ) : null}
              </dl>
              {metadata ? (
                <a
                  className="mt-4 block border-t border-[#eef0f3] pt-4 text-[12px] text-[var(--color-blue)]"
                  href={metadata.repository}
                  rel="noreferrer"
                  target="_blank"
                >
                  {t("查看源码 ↗")}
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
          <div aria-label={t("插件目录")} className="segmented">
            <button aria-pressed="false" onClick={onBack} type="button">
              {t("已安装")}
            </button>
            <button aria-pressed="true" className="active" type="button">
              {t("插件市场")}
            </button>
          </div>
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              onToml();
            }}
          >
            {t("查看运行配置")}
          </a>
        </div>
        <div className="marketplace-toolbar">
          <input
            className="marketplace-search"
            aria-label={t("搜索插件")}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("搜索名称、包名、影响范围…")}
            value={query}
          />
          <select
            className="marketplace-filter"
            aria-label={t("按影响范围筛选")}
            onChange={(event) => onCapabilityChange(event.target.value)}
            value={capabilityFilter}
          >
            <option value="">{t("全部影响")}</option>
            {capabilities.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} ({item.count})
              </option>
            ))}
          </select>
          <span className="marketplace-count">{t("{v0} 个已审核条目 · 推荐排序", { v0: total })}</span>
          {/* The result of an install belongs next to the button that started it: the card grid below scrolls, so a message under it is thousands of pixels away from the card the user clicked. The region is always in the markup so a screen reader announces the message that lands in it. */}
          <div aria-live="polite" className="marketplace-toolbar-message">
            {installError && (
              <p className="marketplace-message error" role="alert">
                {t("安装失败：{v0}", { v0: pluginActionErrorText(installError) })}
              </p>
            )}
            {showInstallNotice && (
              <p className="marketplace-message notice">
                {restartRequiredNotice()}
                <button className="marketplace-message-dismiss" onClick={() => setNoticeDismissed(true)} type="button">
                  {t("知道了")}
                </button>
              </p>
            )}
          </div>
        </div>
        <PluginCategoryNav activeCategory={categoryFilter} categories={categoryTabs} label={t("插件分类")} onChange={onCategoryChange} />
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
                            ? "rounded bg-[var(--color-green-soft)] px-1.5 py-px font-mono text-[10px] text-[var(--color-green)]"
                            : "rounded bg-[var(--color-amber-soft)] px-1.5 py-px font-mono text-[10px] text-[var(--color-amber)]"
                        }
                      >
                        {plugin.status === "verified" ? t("已验证") : t("实验性")}
                      </span>
                      <span
                        className={
                          plugin.source === "official"
                            ? "rounded bg-[var(--color-blue-soft)] px-1.5 py-px font-mono text-[10px] text-[var(--color-blue)]"
                            : "rounded bg-[var(--color-amber-soft)] px-1.5 py-px font-mono text-[10px] text-[var(--color-amber)]"
                        }
                      >
                        {plugin.source === "official" ? t("官方") : t("社区")}
                      </span>
                      <span className="rounded bg-[var(--color-blue-soft)] px-1.5 py-px text-[10px] text-[var(--color-blue)]">{plugin.category.label}</span>
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
                      <span className="rounded bg-[var(--color-blue-soft)] px-1.5 py-px text-[10px] text-[var(--color-muted)]" key={item}>
                        {capabilityLabel(item)}
                      </span>
                    ))}
                    {plugin.hooks.map((item) => (
                      <span className="rounded bg-[var(--color-blue-soft)] px-1.5 py-px font-mono text-[10px] text-[var(--color-muted)]" key={`hook:${item}`}>
                        hook:{item}
                      </span>
                    ))}
                  </div>
                  {plugin.statistics && (
                    <div className="marketplace-statistics mt-3 grid grid-cols-3 divide-x divide-[#e3e7ee] rounded-md border border-[var(--color-line)] bg-[var(--color-soft)]">
                      {marketplaceStatisticItems(plugin.statistics).map((item) => (
                        <span className="min-w-0 px-2 py-1.5" key={item.label} title={`${item.label} ${item.value}`}>
                          <small className="block truncate text-[9px] text-[var(--color-faint)]">{item.label}</small>
                          <strong className="mt-0.5 block truncate font-mono text-[10px] font-medium text-[var(--color-ink)]">{item.value}</strong>
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
                    {t("查看详情 →")}
                  </a>
                  <a href={plugin.repository} target="_blank" rel="noreferrer">
                    {t("查看源码 ↗")}
                  </a>
                  {/* A plugin that asked for a restart is installed on disk but missing from the loader, so the button says so rather than inviting the same install again. */}
                  <button
                    disabled={installedPackages.has(plugin.packageName) || restartPendingPackages.has(plugin.packageName) || installing !== undefined}
                    onClick={() => void install(plugin)}
                    type="button"
                  >
                    {installedPackages.has(plugin.packageName)
                      ? t("已安装")
                      : restartPendingPackages.has(plugin.packageName)
                        ? t("重启后生效")
                        : installing === plugin.id
                          ? t("安装中…")
                          : t("安装")}
                  </button>
                </footer>
              </article>
            ))}
            {!plugins.length && <div className="empty-state">{t("没有匹配的插件。")}</div>}
          </div>
          <div className="marketplace-pagination">
            <button className="marketplace-pagination-button" disabled={page === 0} onClick={() => onPageChange(page - 1)} type="button">
              {t("上一页")}
            </button>
            <span>{t("第 {v0} 页", { v0: page + 1 })}</span>
            <button className="marketplace-pagination-button" disabled={!hasNext} onClick={() => onPageChange(page + 1)} type="button">
              {t("下一页")}
            </button>
          </div>
          <div className="marketplace-contribute mt-3 flex items-center gap-2.5 rounded-[10px] border border-dashed border-[#b8ccf5] bg-[var(--color-blue-soft)] p-2.5 text-[11.5px] text-[var(--color-faint)]">
            <strong className="text-[12px] text-[var(--color-ink)]">{t("你有一个 Pi Harness 插件？")}</strong>
            <span>{t("在 entries 目录新增一个元数据文件，附测试和 README 后提交 PR；审核通过后会出现在这里。")}</span>
            <a
              className="ml-auto flex-none text-[var(--color-blue)]"
              href="https://github.com/pi-harness/pi-harness/blob/main/docs/plugin-marketplace.md"
              target="_blank"
              rel="noreferrer"
            >
              {t("查看贡献规范 ↗")}
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
      if (result.restartRequired === true) setNotice(restartRequiredNotice());
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
            {t("← 插件市场")}
          </a>
          <span>{t("插件详情")}</span>
        </div>
        <div className="plugin-detail-content">
          <header className="border-b border-[var(--color-line)] pb-7">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="rounded bg-[var(--color-blue-soft)] px-2 py-1 font-mono text-[10px] text-[var(--color-blue)]">
                {plugin.source === "official" ? t("官方插件") : t("社区插件")}
              </span>
              <span className="rounded bg-[var(--color-blue-soft)] px-2 py-1 text-[10px] text-[var(--color-blue)]">{plugin.category.label}</span>
              <span
                className={
                  plugin.status === "verified"
                    ? "rounded bg-[var(--color-green-soft)] px-2 py-1 font-mono text-[10px] text-[var(--color-green)]"
                    : "rounded bg-[var(--color-amber-soft)] px-2 py-1 font-mono text-[10px] text-[var(--color-amber)]"
                }
              >
                {plugin.status === "verified" ? t("已验证") : t("实验性")}
              </span>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-5">
              <div className="min-w-0">
                <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-faint)]">PLUGIN DETAIL</p>
                <h1 className="text-3xl font-semibold tracking-[-0.03em] text-[var(--color-ink)]">{plugin.name}</h1>
                <code className="mt-3 block break-all text-[12px] text-[var(--color-faint)]">
                  {plugin.packageName} · v{plugin.version}
                </code>
              </div>
              <div className="plugin-detail-actions">
                <button className="plugin-detail-action primary" disabled={installed || restartPending || busy} onClick={() => void install()} type="button">
                  {installed ? t("已安装") : restartPending ? t("重启后生效") : busy ? t("安装中…") : t("安装插件")}
                </button>
              </div>
            </div>
            <p className="mt-5 max-w-3xl text-[14px] leading-7 text-[var(--color-muted)]">{plugin.description}</p>
            {notice && (
              <p aria-live="polite" className="mt-3 text-[12px] text-[var(--color-blue)]">
                {notice}
              </p>
            )}
            {error && (
              <p className="mt-3 text-[12px] text-[var(--color-red)]" role="alert">
                {t("安装失败：{v0}", { v0: pluginActionErrorText(error) })}
              </p>
            )}
          </header>
          <div className="grid gap-4 py-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-4">
              <section className="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
                <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{t("影响范围")}</h2>
                <div className="mt-4 flex flex-wrap gap-2">
                  {plugin.capabilities.map((item) => (
                    <span className="rounded-md bg-[var(--color-blue-soft)] px-2 py-1 text-[11px] text-[var(--color-muted)]" key={item}>
                      {capabilityLabel(item)}
                    </span>
                  ))}
                </div>
              </section>
              <section className="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
                <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{t("扩展点")}</h2>
                <div className="mt-4 space-y-2">
                  {plugin.hooks.map((item) => (
                    <div className="rounded-md bg-[var(--color-soft)] px-3 py-2 font-mono text-[11px] text-[var(--color-muted)]" key={item}>
                      {item}
                    </div>
                  ))}
                </div>
              </section>
              <section className="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
                <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{t("运行配置")}</h2>
                <p className="mt-1 text-[12px] text-[var(--color-faint)]">{t("安装后会写入当前运行 profile。")}</p>
                <pre className="mt-4 overflow-auto rounded-lg bg-[var(--color-soft)] p-4 text-[11px] leading-6 text-[var(--color-ink)]">
                  <code>{JSON.stringify(plugin.profile, null, 2)}</code>
                </pre>
              </section>
            </div>
            <aside className="h-fit rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
              <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{t("插件信息")}</h2>
              <dl className="mt-4 divide-y divide-[#eef0f3] text-[12px]">
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[var(--color-faint)]">{t("作者")}</dt>
                  <dd className="text-right text-[var(--color-ink)]">{plugin.author}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[var(--color-faint)]">{t("许可证")}</dt>
                  <dd className="font-mono text-[var(--color-ink)]">{plugin.license}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[var(--color-faint)]">{t("分类")}</dt>
                  <dd className="text-right text-[var(--color-ink)]">{plugin.category.label}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-[var(--color-faint)]">{t("版本")}</dt>
                  <dd className="font-mono text-[var(--color-ink)]">{plugin.version}</dd>
                </div>
                {marketplaceStatisticItems(plugin.statistics).map((item) => (
                  <div className="flex justify-between gap-4 py-3" key={item.label}>
                    <dt className="text-[var(--color-faint)]">{item.label}</dt>
                    <dd className="font-mono text-[var(--color-ink)]">{item.value}</dd>
                  </div>
                ))}
              </dl>
              <a
                className="mt-4 block border-t border-[#eef0f3] pt-4 text-[12px] text-[var(--color-blue)]"
                href={plugin.repository}
                target="_blank"
                rel="noreferrer"
              >
                {t("查看源码 ↗")}
              </a>
            </aside>
          </div>
        </div>
      </div>
    </section>
  );
}

// Every config refresh path has to feed the source editor as well, otherwise the textarea keeps pre-reload text and the next 保存源码 overwrites the file that was just read from disk.
/** The settings page reports config progress as a kind plus already-translated prose, because the prose changes with the language and nothing may branch on it. */
export interface ConfigStatus {
  readonly text: string;
  readonly kind: "loading" | "progress" | "done" | "error";
}

export async function reloadRuntimeConfig(
  api: Pick<ClientApi, "reloadConfig">,
  apply: {
    config: (value: ClientPiConfig) => void;
    sourceDraft: (source: string) => void;
    state: (status: ConfigStatus | undefined) => void;
    busy: (value: boolean) => void;
  },
): Promise<void> {
  apply.busy(true);
  apply.state({ text: t("重载中…"), kind: "progress" });
  try {
    const value = await api.reloadConfig();
    apply.config(value);
    apply.sourceDraft(value.source);
    apply.state({ text: t("已从磁盘重载"), kind: "done" });
  } catch (cause: unknown) {
    apply.state({ text: cause instanceof Error ? cause.message : String(cause), kind: "error" });
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
  const [providerBusy, setProviderBusy] = useState<Record<string, "add" | "test" | "refresh" | undefined>>({});
  const [providerAddOpen, setProviderAddOpen] = useState(false);
  const [providerForm, setProviderForm] = useState<{
    provider: string;
    name: string;
    baseUrl: string;
    api: "openai-completions" | "openai-responses";
    apiKey: string;
    model: string;
  }>({ provider: "", name: "", baseUrl: "", api: "openai-completions", apiKey: "", model: "" });
  const locale = useLocale();
  const [config, setConfig] = useState<ClientPiConfig>();
  const [configMode, setConfigMode] = useState<"form" | "source">("form");
  const [configSourceDraft, setConfigSourceDraft] = useState("");
  const [configBusy, setConfigBusy] = useState(false);
  const [configState, setConfigState] = useState<ConfigStatus>();
  const notifierActive = data.plugins.some((plugin) => plugin.name.endsWith("/cli-notifier") && plugin.enabled);
  const providerDialogRef = useModalFocus(providerAddOpen, () => setProviderAddOpen(false), providerBusy.__add !== undefined);
  useEffect(() => {
    if (tab !== "general" && tab !== "toml") return;
    setConfigState({ text: t("读取中…"), kind: "loading" });
    void api
      .getConfig()
      .then((value) => {
        setConfig(value);
        setConfigSourceDraft(value.source);
        setConfigState(undefined);
      })
      .catch((cause: unknown) => setConfigState({ text: cause instanceof Error ? cause.message : String(cause), kind: "error" }));
  }, [api, tab]);
  const updateConfig = (input: Partial<ClientPiConfig["settings"]>, message: string) => {
    setConfigBusy(true);
    setConfigState({ text: message, kind: "progress" });
    void api
      .updateConfig(input)
      .then((value) => {
        setConfig(value);
        setConfigSourceDraft(value.source);
      })
      .then(() => setConfigState({ text: t("已保存"), kind: "done" }))
      .catch((cause: unknown) => setConfigState({ text: cause instanceof Error ? cause.message : String(cause), kind: "error" }))
      .finally(() => setConfigBusy(false));
  };
  const runProviderAction = (provider: string, action: "test" | "refresh") => {
    if (providerBusy[provider]) return;
    setProviderBusy((current) => ({ ...current, [provider]: action }));
    setProviderState((current) => ({ ...current, [provider]: action === "test" ? t("测试中…") : t("刷新中…") }));
    if (action === "test")
      void api
        .testProvider(provider)
        .then((result) => {
          const auth = result.auth;
          const label = auth && typeof auth === "object" && "label" in auth && typeof auth.label === "string" ? auth.label : undefined;
          setProviderState((current) => ({ ...current, [provider]: result.reachable ? t("连接正常") : (label ?? t("未检测到认证")) }));
        })
        .catch((cause: unknown) => setProviderState((current) => ({ ...current, [provider]: cause instanceof Error ? cause.message : String(cause) })))
        .finally(() => setProviderBusy((current) => ({ ...current, [provider]: undefined })));
    else
      void api
        .refreshProvider(provider)
        .then((result) => setProviderState((current) => ({ ...current, [provider]: t("{count} 个模型已刷新", { count: result.models.length }) })))
        .catch((cause: unknown) => setProviderState((current) => ({ ...current, [provider]: cause instanceof Error ? cause.message : String(cause) })))
        .finally(() => setProviderBusy((current) => ({ ...current, [provider]: undefined })));
  };
  return (
    <section className="view-panel settings-page">
      <div className="settings-dialog">
        <nav aria-label={t("设置分类")} className="settings-top-tabs">
          {(["general", "providers", "toml"] as const).map((item) => (
            <button aria-pressed={tab === item} className={`settings-tab ${tab === item ? "active" : ""}`} key={item} onClick={() => onTab(item)} type="button">
              {item === "general" ? t("通用") : item === "providers" ? t("提供商 {count}", { count: data.providers.length }) : t("运行配置")}
            </button>
          ))}
        </nav>
        <section>
          <header>
            <button className="settings-back" onClick={onClose} type="button">
              {t("← 返回会话")}
            </button>
            <div className="settings-header-copy">
              <strong>{tab === "general" ? t("通用") : tab === "providers" ? t("提供商") : t("运行配置")}</strong>
              <small>{tab === "toml" ? t("配置即代码，改完重载") : t("运行时状态与快捷键")}</small>
            </div>
          </header>
          <div className="settings-body">
            {tab === "general" && (
              <>
                <div className="general-row">
                  <div>
                    <strong>{t("界面语言")}</strong>
                    <small>{t("只改控制台自己的文字，你和模型对话用什么语言仍然由你决定。")}</small>
                  </div>
                  <select
                    aria-label={t("界面语言")}
                    className="setting-select"
                    onChange={(event) => {
                      const next = event.target.value;
                      writeStoredLocale(globalThis.localStorage, next);
                      void setLocale(next).then(() => {
                        document.documentElement.lang = next;
                      });
                    }}
                    value={locale}
                  >
                    {LOCALES.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                {[
                  [t("工作目录"), status?.cwd],
                  [t("agent 目录"), status?.agentDir],
                  [t("会话"), status ? t("{session} · {count} 条消息", { session: status.sessionId, count: status.messages }) : "—"],
                  [t("快捷键"), t("⌘K 命令 · ⌘, 设置 · ⌃C 中断")],
                  [t("权限策略"), t("当前 API 未提供修改接口")],
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
                    <strong>{t("任务结束提醒插件")}</strong>
                    <small>{t("由 CLI Notifier 提供，具体目标在插件配置中管理")}</small>
                  </div>
                  <span className={`setting-status ${notifierActive ? "on" : ""}`}>{notifierActive ? t("已加载") : t("未加载")}</span>
                </div>
                <div className="general-row">
                  <div>
                    <strong>{t("自动压缩上下文")}</strong>
                    <small>{t("接近上下文上限时自动整理历史消息，可在运行配置中修改")}</small>
                    {!config && configState && configState.kind !== "loading" ? (
                      <small className="setting-error" role="alert">
                        {t("配置读取失败：{v0}", { v0: configState.text })}
                      </small>
                    ) : null}
                  </div>
                  <span className={`setting-status ${config?.settings.compaction.enabled ? "on" : ""}`}>
                    {config ? (config.settings.compaction.enabled ? t("已开启") : t("已关闭")) : configState?.kind === "loading" ? t("读取中") : t("不可用")}
                  </span>
                </div>
              </>
            )}
            {tab === "providers" && (
              <>
                <div className="provider-add-head">
                  <div>
                    <strong>{t("已启用提供商")}</strong>
                    <small>{t("模型列表只显示当前会话和已配置提供商。")}</small>
                  </div>
                  <button className="primary" onClick={() => setProviderAddOpen(true)} type="button">
                    {t("添加提供商")}
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
                      aria-busy={providerBusy.__add !== undefined}
                      aria-label={t("添加提供商")}
                      aria-modal="true"
                      className="provider-add-modal"
                      onClick={(event) => event.stopPropagation()}
                      ref={providerDialogRef}
                      role="dialog"
                      tabIndex={-1}
                    >
                      <header>
                        <div>
                          <strong>{t("添加自定义提供商")}</strong>
                          <small>{t("注册 OpenAI 兼容接口，凭据只提交到本机 Pi runtime。")}</small>
                        </div>
                        <button
                          aria-label={t("关闭添加提供商")}
                          disabled={providerBusy.__add !== undefined}
                          onClick={() => setProviderAddOpen(false)}
                          type="button"
                        >
                          ×
                        </button>
                      </header>
                      <form
                        className="provider-add-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!providerForm.provider || !providerForm.baseUrl || !providerForm.apiKey || !providerForm.model) return;
                          setProviderBusy((current) => ({ ...current, __add: "add" }));
                          setProviderState((current) => ({ ...current, __add: t("添加中…") }));
                          void api
                            .addProvider(providerForm)
                            .then(async () => {
                              setProviderForm({ provider: "", name: "", baseUrl: "", api: "openai-completions", apiKey: "", model: "" });
                              setProviderState((current) => ({ ...current, __add: t("已添加") }));
                              await onRefresh();
                              setProviderAddOpen(false);
                            })
                            .catch((cause: unknown) =>
                              setProviderState((current) => ({ ...current, __add: cause instanceof Error ? cause.message : String(cause) })),
                            )
                            .finally(() => setProviderBusy((current) => ({ ...current, __add: undefined })));
                        }}
                      >
                        <label>
                          <span>{t("提供商 ID")}</span>
                          <input
                            aria-label={t("提供商 ID")}
                            data-dialog-initial-focus
                            maxLength={64}
                            minLength={2}
                            pattern="[a-z0-9][a-z0-9._-]{1,63}"
                            placeholder={t("例如 openrouter")}
                            required
                            value={providerForm.provider}
                            onChange={(event) => setProviderForm((current) => ({ ...current, provider: event.target.value }))}
                          />
                        </label>
                        <label>
                          <span>{t("显示名称")}</span>
                          <input
                            aria-label={t("提供商名称")}
                            placeholder={t("可选")}
                            value={providerForm.name}
                            onChange={(event) => setProviderForm((current) => ({ ...current, name: event.target.value }))}
                          />
                        </label>
                        <label className="provider-add-wide">
                          <span>{t("接口地址")}</span>
                          <input
                            aria-label={t("接口地址")}
                            placeholder="https://api.example.com/v1"
                            required
                            type="url"
                            value={providerForm.baseUrl}
                            onChange={(event) => setProviderForm((current) => ({ ...current, baseUrl: event.target.value }))}
                          />
                        </label>
                        <label>
                          <span>{t("模型 ID")}</span>
                          <input
                            aria-label={t("模型 ID")}
                            placeholder={t("例如 gpt-4o")}
                            required
                            value={providerForm.model}
                            onChange={(event) => setProviderForm((current) => ({ ...current, model: event.target.value }))}
                          />
                        </label>
                        <label>
                          <span>{t("协议")}</span>
                          <select
                            aria-label={t("协议")}
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
                            placeholder={t("只在本机提交，不会回显")}
                            required
                            type="password"
                            value={providerForm.apiKey}
                            onChange={(event) => setProviderForm((current) => ({ ...current, apiKey: event.target.value }))}
                          />
                        </label>
                        <div className="provider-add-actions">
                          <button className="primary" disabled={providerBusy.__add !== undefined} type="submit">
                            {providerBusy.__add ? t("添加中…") : t("添加提供商")}
                          </button>
                          {providerState.__add && <small aria-live="polite">{providerState.__add}</small>}
                        </div>
                      </form>
                    </div>
                  </div>
                )}
                <small>{t("已启用提供商 · /api/providers")}</small>
                {data.providers.length ? (
                  data.providers.map((provider) => (
                    <article className="provider-card" key={provider.provider}>
                      <div className="provider-head">
                        <span className="provider-dot">●</span>
                        <strong>{provider.name}</strong>
                        <span className="provider-state">
                          {provider.active ? t("当前会话") : provider.auth?.configured === true ? t("已配置") : t("未配置")}
                        </span>
                      </div>
                      <div className="provider-field">
                        <code>provider</code>
                        <input aria-label={t("{provider} 提供商 ID", { provider: provider.name })} disabled value={provider.provider} readOnly />
                      </div>
                      <div className="provider-field">
                        <code>model</code>
                        <div className="provider-model-value" title={provider.models.map((model) => model.id).join(", ") || t("暂无模型")}>
                          <span>{provider.activeModel ? `${provider.activeModel.provider}/${provider.activeModel.id}` : t("未选择模型")}</span>
                          {provider.models.length > 0 && (
                            <details className="provider-models-details">
                              <summary>{t("查看 {v0} 个模型", { v0: provider.models.length })}</summary>
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
                        <input aria-label={t("{provider} API key 状态", { provider: provider.name })} disabled value={t("不会在浏览器显示")} readOnly />
                      </div>
                      <div className="provider-footer">
                        <code>{t("{v0} 个模型", { v0: provider.models.length })}</code>
                        <button
                          disabled={providerBusy[provider.provider] !== undefined}
                          onClick={() => runProviderAction(provider.provider, "test")}
                          type="button"
                        >
                          {providerBusy[provider.provider] === "test" ? t("测试中…") : t("测试连接")}
                        </button>
                        <button
                          className="link-button"
                          disabled={providerBusy[provider.provider] !== undefined}
                          onClick={() => runProviderAction(provider.provider, "refresh")}
                          type="button"
                        >
                          {providerBusy[provider.provider] === "refresh" ? t("刷新中…") : t("拉取模型")}
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
                  <div className="empty-state">{t("运行时没有注册提供商。")}</div>
                )}
              </>
            )}
            {tab === "toml" && (
              <div className="config-editor">
                <div className="toml-toolbar">
                  <div>
                    <strong>{t("运行时配置")}</strong>
                    <span>{config?.path ?? "~/.pi/agent/settings.json"}</span>
                  </div>
                  <button className={configMode === "form" ? "active" : ""} onClick={() => setConfigMode("form")} type="button">
                    {t("表单")}
                  </button>
                  <button className={configMode === "source" ? "active" : ""} onClick={() => setConfigMode("source")} type="button">
                    {t("源码")}
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
                    {t("重载")}
                  </button>
                </div>
                {configState && (
                  <div aria-live="polite" className={`config-state ${configState.kind === "error" ? "error" : ""}`}>
                    {configState.text}
                  </div>
                )}
                {config ? (
                  configMode === "source" ? (
                    <div className="config-source-editor">
                      <textarea
                        aria-label={t("settings.json 源码")}
                        className="config-source"
                        onChange={(event) => setConfigSourceDraft(event.target.value)}
                        spellCheck={false}
                        value={configSourceDraft}
                      />
                      <div className="config-source-actions">
                        <small>{t("完整 JSON 配置，可编辑未知字段；保存前会校验语法。")}</small>
                        <button
                          className="primary"
                          disabled={configBusy || !configSourceDraft.trim()}
                          onClick={() => {
                            setConfigBusy(true);
                            setConfigState({ text: t("保存源码…"), kind: "progress" });
                            void api
                              .updateConfigSource(configSourceDraft)
                              .then((value) => {
                                setConfig(value);
                                setConfigSourceDraft(value.source);
                                setConfigState({ text: t("已保存源码"), kind: "done" });
                              })
                              .catch((cause: unknown) => setConfigState({ text: cause instanceof Error ? cause.message : String(cause), kind: "error" }))
                              .finally(() => setConfigBusy(false));
                          }}
                          type="button"
                        >
                          {t("保存源码")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="config-sections">
                      <section className="config-section">
                        <header>
                          <strong>{t("模型默认值")}</strong>
                          <small>{t("新会话启动时使用的模型和思考级别")}</small>
                        </header>
                        <label className="config-field">
                          <span>{t("提供商")}</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ defaultProvider: event.target.value }, t("保存提供商…"))}
                            value={config.settings.defaultProvider ?? ""}
                          >
                            <option value="">{t("跟随运行时")}</option>
                            {data.providers.map((provider) => (
                              <option key={provider.provider} value={provider.provider}>
                                {provider.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="config-field">
                          <span>{t("模型")}</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ defaultModel: event.target.value }, t("保存模型…"))}
                            value={config.settings.defaultModel ?? ""}
                          >
                            <option value="">{t("跟随提供商")}</option>
                            {data.models.map((model) => (
                              <option key={`${model.provider}/${model.id}`} value={model.id}>
                                {model.provider}/{model.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="config-field">
                          <span>{t("思考级别")}</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ defaultThinkingLevel: event.target.value }, t("保存思考级别…"))}
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
                          <strong>{t("运行策略")}</strong>
                          <small>{t("消息队列和网络传输行为")}</small>
                        </header>
                        <label className="config-field">
                          <span>{t("传输方式")}</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ transport: event.target.value }, t("保存传输方式…"))}
                            value={config.settings.transport}
                          >
                            <option value="auto">{t("自动")}</option>
                            <option value="sse">SSE</option>
                            <option value="websocket">WebSocket</option>
                          </select>
                        </label>
                        <label className="config-field">
                          <span>{t("Steering 消息")}</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ steeringMode: event.target.value }, t("保存队列策略…"))}
                            value={config.settings.steeringMode}
                          >
                            <option value="one-at-a-time">{t("逐条发送")}</option>
                            <option value="all">{t("一次发送全部")}</option>
                          </select>
                        </label>
                        <label className="config-field">
                          <span>{t("Follow-up 消息")}</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ followUpMode: event.target.value }, t("保存跟进策略…"))}
                            value={config.settings.followUpMode}
                          >
                            <option value="one-at-a-time">{t("逐条发送")}</option>
                            <option value="all">{t("一次发送全部")}</option>
                          </select>
                        </label>
                      </section>
                      <section className="config-section">
                        <header>
                          <strong>{t("上下文与显示")}</strong>
                          <small>{t("控制思考内容和自动压缩")}</small>
                        </header>
                        <label className="config-toggle">
                          <span>
                            <strong>{t("隐藏思考正文")}</strong>
                            <small>{t("只显示可展开的思考摘要")}</small>
                          </span>
                          <input
                            checked={config.settings.hideThinkingBlock}
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ hideThinkingBlock: event.target.checked }, t("保存显示设置…"))}
                            type="checkbox"
                          />
                        </label>
                        <label className="config-toggle">
                          <span>
                            <strong>{t("自动压缩上下文")}</strong>
                            <small>{t("接近上下文上限时自动整理历史消息")}</small>
                          </span>
                          <input
                            checked={config.settings.compaction.enabled}
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ compaction: { ...config.settings.compaction, enabled: event.target.checked } }, t("保存压缩设置…"))
                            }
                            type="checkbox"
                          />
                        </label>
                        <label className="config-toggle">
                          <span>
                            <strong>{t("自动重试")}</strong>
                            <small>{t("临时网络错误时自动重试请求")}</small>
                          </span>
                          <input
                            checked={config.settings.retry.enabled}
                            disabled={configBusy}
                            onChange={(event) => updateConfig({ retry: { ...config.settings.retry, enabled: event.target.checked } }, t("保存重试设置…"))}
                            type="checkbox"
                          />
                        </label>
                        <label className="config-toggle">
                          <span>
                            <strong>{t("显示图片")}</strong>
                            <small>{t("允许模型响应中的图片渲染")}</small>
                          </span>
                          <input
                            checked={config.settings.terminal.showImages}
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ terminal: { ...config.settings.terminal, showImages: event.target.checked } }, t("保存图片设置…"))
                            }
                            type="checkbox"
                          />
                        </label>
                      </section>
                      <section className="config-section">
                        <header>
                          <strong>{t("终端与导航")}</strong>
                          <small>{t("控制命令行界面和消息渲染行为")}</small>
                        </header>
                        <label className="config-toggle">
                          <span>
                            <strong>{t("安静启动")}</strong>
                            <small>{t("启动时隐藏版本和更新提示")}</small>
                          </span>
                          <input
                            checked={config.settings.advanced.quietStartup}
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ advanced: { ...config.settings.advanced, quietStartup: event.target.checked } }, t("保存启动设置…"))
                            }
                            type="checkbox"
                          />
                        </label>
                        <label className="config-field">
                          <span>{t("项目可信策略")}</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ advanced: { ...config.settings.advanced, projectTrust: event.target.value } }, t("保存信任策略…"))
                            }
                            value={config.settings.advanced.projectTrust}
                          >
                            <option value="ask">{t("每次询问")}</option>
                            <option value="always">{t("始终信任")}</option>
                            <option value="never">{t("从不信任")}</option>
                          </select>
                        </label>
                        <label className="config-field">
                          <span>{t("Mermaid 渲染")}</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ advanced: { ...config.settings.advanced, mermaid: event.target.value } }, t("保存 Mermaid 设置…"))
                            }
                            value={config.settings.advanced.mermaid}
                          >
                            <option value="off">{t("关闭")}</option>
                            <option value="final">{t("完成后渲染")}</option>
                            <option value="streaming">{t("流式渲染")}</option>
                          </select>
                        </label>
                        <label className="config-field">
                          <span>{t("双击 Escape")}</span>
                          <select
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ advanced: { ...config.settings.advanced, doubleEscapeAction: event.target.value } }, t("保存快捷键设置…"))
                            }
                            value={config.settings.advanced.doubleEscapeAction}
                          >
                            <option value="tree">{t("打开会话树")}</option>
                            <option value="fork">{t("创建分支")}</option>
                            <option value="none">{t("不执行")}</option>
                          </select>
                        </label>
                      </section>
                      <section className="config-section">
                        <header>
                          <strong>{t("诊断与隐私")}</strong>
                          <small>{t("控制缓存提示和匿名数据上报")}</small>
                        </header>
                        <label className="config-toggle">
                          <span>
                            <strong>{t("显示缓存未命中")}</strong>
                            <small>{t("在消息中显示模型缓存诊断")}</small>
                          </span>
                          <input
                            checked={config.settings.advanced.showCacheMissNotices}
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ advanced: { ...config.settings.advanced, showCacheMissNotices: event.target.checked } }, t("保存诊断设置…"))
                            }
                            type="checkbox"
                          />
                        </label>
                        <label className="config-toggle">
                          <span>
                            <strong>{t("安装遥测")}</strong>
                            <small>{t("发送匿名安装和版本统计")}</small>
                          </span>
                          <input
                            checked={config.settings.advanced.enableInstallTelemetry}
                            disabled={configBusy}
                            onChange={(event) =>
                              updateConfig({ advanced: { ...config.settings.advanced, enableInstallTelemetry: event.target.checked } }, t("保存隐私设置…"))
                            }
                            type="checkbox"
                          />
                        </label>
                      </section>
                    </div>
                  )
                ) : (
                  <div className="empty-state">{t("正在读取运行时配置…")}</div>
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
    <div aria-label={t("命令面板")} className="command-palette" id="command-menu" role="listbox">
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
                <span>{command.description ?? command.source ?? t("由当前运行时注册")}</span>
              </button>
            );
          })
        ) : (
          <div className="empty-state">
            {commands.length
              ? t("没有匹配的命令。")
              : t("还没有加载任何命令。命令由 pi 扩展注册：把扩展放进 ~/.pi/agent/extensions（或已信任工作区的 .pi/extensions）后重启 Pi Harness。")}
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
      aria-label={kind === "command" ? t("命令补全") : t("文件补全")}
      className="prompt-completion"
      data-prompt-completion
      id="prompt-completion-list"
      role="listbox"
    >
      <small>{kind === "command" ? t("命令") : t("文件")}</small>
      {items.length ? (
        items.slice(0, 12).map((item, index) => {
          const label = kind === "command" ? `/${(item as ClientCommand).invocationName}` : `@${(item as ClientFile).path}`;
          const detail =
            kind === "command" ? ((item as ClientCommand).description ?? (item as ClientCommand).source ?? t("由当前运行时注册")) : (item as ClientFile).status;
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
        <span className="prompt-completion-empty">{t("没有匹配项")}</span>
      )}
    </div>
  );
}

type GlobalSearchItem =
  | { kind: "command"; command: ClientCommand }
  | { kind: "session"; session: Record<string, unknown> }
  | { kind: "file"; file: ClientFile };

export function GlobalSearch({
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
      <div aria-label={t("全局搜索")} aria-modal="true" className="global-search-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="global-search-heading">
          <strong>{t("全局搜索")}</strong>
          <small>{t("命令 · 会话 · 文件")}</small>
          <button aria-label={t("关闭全局搜索")} onClick={onClose} type="button">
            ×
          </button>
        </div>
        <input
          aria-activedescendant={activeItemId}
          aria-autocomplete="list"
          aria-controls="global-search-results"
          aria-expanded="true"
          aria-label={t("全局搜索")}
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
          placeholder={t("搜索命令、会话或文件")}
          role="combobox"
          value={query}
        />
        <div aria-label={t("全局搜索结果")} className="global-search-results" id="global-search-results" role="listbox">
          {items.length ? (
            (["command", "session", "file"] as const).map((kind) => {
              const group = items.filter((item) => item.kind === kind);
              if (!group.length) return null;
              const label = kind === "command" ? t("命令") : kind === "session" ? t("会话") : t("文件");
              return (
                <section aria-label={label} className="global-search-group" key={kind} role="group">
                  <small aria-hidden="true">{label}</small>
                  {group.map((item) => {
                    const index = items.indexOf(item);
                    const title =
                      item.kind === "command"
                        ? `/${item.command.invocationName}`
                        : item.kind === "session"
                          ? value(item.session.name ?? item.session.firstMessage ?? item.session.sessionId, t("未命名会话"))
                          : item.file.label;
                    const detail =
                      item.kind === "command"
                        ? (item.command.description ?? item.command.source ?? t("由当前运行时注册"))
                        : item.kind === "session"
                          ? t("{count} 条消息", { count: value(item.session.messageCount, "0") })
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
            <div className="empty-state">{t("没有匹配的命令、会话或文件。")}</div>
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
  connection?: { readonly current: (state: ClientEventStreamState) => void },
): () => void {
  return api.subscribeEvents((payload) => handler.current(payload), connection === undefined ? undefined : (state) => connection.current(state));
}

export interface LocalRunActivity {
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly phase: ClientRunPhase;
}

export interface RunTelemetryView {
  readonly phase: ClientRunPhase;
  readonly tone: "active" | "quiet" | "connecting" | "reconnecting" | "disconnected" | "offline";
  readonly elapsedSeconds: number;
  readonly quietSeconds: number;
}

const RUN_QUIET_AFTER_MS = 30_000;

function clampedTimestamp(value: string, fallback: number, now: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.min(parsed, now) : fallback;
}

export function runActivityFromStatus(
  status: Pick<ClientStatus, "status" | "run"> | undefined,
  current: LocalRunActivity | undefined,
  now = Date.now(),
): LocalRunActivity | undefined {
  if (status?.status !== "running") return undefined;
  if (status.run === undefined) return current ?? { startedAt: now, lastActivityAt: now, phase: "starting" };
  const startedAt = clampedTimestamp(status.run.startedAt, now, now);
  const lastActivityAt = Math.max(startedAt, clampedTimestamp(status.run.lastActivityAt, startedAt, now));
  if (current?.startedAt === startedAt && current.lastActivityAt >= lastActivityAt) return current;
  return { startedAt, lastActivityAt, phase: status.run.phase };
}

export function runTelemetryView(
  activity: LocalRunActivity,
  connection: ClientEventStreamState,
  statusReachable: boolean | undefined,
  now = Date.now(),
): RunTelemetryView {
  const elapsedSeconds = Math.max(0, Math.floor((now - activity.startedAt) / 1000));
  const quietSeconds = Math.max(0, Math.floor((now - activity.lastActivityAt) / 1000));
  const tone =
    statusReachable === false && connection !== "open"
      ? "offline"
      : connection === "closed"
        ? "disconnected"
        : connection === "reconnecting"
          ? "reconnecting"
          : connection === "connecting"
            ? "connecting"
            : quietSeconds * 1000 >= RUN_QUIET_AFTER_MS
              ? "quiet"
              : "active";
  return { phase: activity.phase, tone, elapsedSeconds, quietSeconds };
}

export function formatRunClock(totalSeconds: number): string {
  const bounded = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(bounded / 3600);
  const minutes = Math.floor((bounded % 3600) / 60);
  const seconds = bounded % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function runPhaseText(phase: ClientRunPhase): string {
  if (phase === "thinking") return t("模型思考中");
  if (phase === "responding") return t("模型生成中");
  if (phase === "tool") return t("工具执行中");
  return t("等待模型");
}

function runToneText(view: RunTelemetryView): string {
  if (view.tone === "offline") return t("Pi runtime 不可达");
  if (view.tone === "disconnected") return t("实时更新已断开");
  if (view.tone === "reconnecting") return t("实时更新中断，正在重连");
  if (view.tone === "connecting") return t("正在连接实时更新");
  if (view.tone === "quiet") return t("模型暂时静默 · {seconds} 秒无新活动", { seconds: view.quietSeconds });
  return view.quietSeconds < 2 ? t("刚刚有新活动") : t("{seconds} 秒前有新活动", { seconds: view.quietSeconds });
}

function runAnnouncementText(view: RunTelemetryView): string {
  if (view.tone === "offline") return t("Pi runtime 不可达");
  if (view.tone === "disconnected") return t("实时更新已断开");
  if (view.tone === "reconnecting") return t("实时更新中断，正在重连");
  if (view.tone === "connecting") return t("正在连接实时更新");
  if (view.tone === "quiet") return t("模型暂时静默");
  return runPhaseText(view.phase);
}

type MarketplaceDetailPlan =
  | { readonly kind: "clear" }
  | { readonly kind: "show"; readonly plugin: ClientMarketplacePlugin }
  | { readonly kind: "keep" }
  | { readonly kind: "fetch" };

interface MarketplaceDetailSource {
  readonly locale: string;
  readonly plugins: readonly ClientMarketplacePlugin[];
}

interface MarketplaceDetailResolution {
  readonly pluginId: string;
  readonly locale: string;
}

// Sources carry their locale because a language switch must not reuse a previous catalog while the new request is still pending or failed. The resolved scope keeps a poll from blanking and refetching a detail only in the language that produced it.
export function marketplaceDetailPlan(
  pluginId: string | undefined,
  sources: readonly MarketplaceDetailSource[],
  locale: string,
  resolved: MarketplaceDetailResolution | undefined,
): MarketplaceDetailPlan {
  if (pluginId === undefined) return { kind: "clear" };
  const plugin = sources
    .filter((source) => source.locale === locale)
    .flatMap((source) => source.plugins)
    .find((item) => item.id === pluginId);
  if (plugin !== undefined) return { kind: "show", plugin };
  return resolved?.pluginId === pluginId && resolved.locale === locale ? { kind: "keep" } : { kind: "fetch" };
}

/** At most `limit` characters, collapsed to one line unless the caller wants the original line breaks kept. */
function previewText(value: string, limit: number, singleLine = true): string {
  const collapsed = singleLine ? value.replace(/\s+/gu, " ").trim() : value;
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

const SESSION_TITLE_LIMIT = 80;
function truncateSessionTitle(text: string): string {
  return previewText(text, SESSION_TITLE_LIMIT);
}

const TOOL_ARGUMENT_PREVIEW_LIMIT = 140;
// A tool result is untrusted text of any length, and the row it belongs to is collapsed, so the transcript keeps a readable head of it rather than pushing megabytes of file contents into the document.
const TOOL_RESULT_PREVIEW_LIMIT = 4_000;

function toolSignatureValue(input: unknown): string {
  if (input === undefined) return "<undefined>";
  if (typeof input === "string") return input;
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(input, (_key: string, nested: unknown): unknown => {
      if (nested !== null && typeof nested === "object") {
        if (seen.has(nested)) return "[Circular]";
        seen.add(nested);
      }
      return nested;
    });
    return serialized ?? "[Unavailable]";
  } catch {
    // Runtime payloads normally arrive through JSON, but a local adapter can hand
    // the client a cyclic object. The signature must never make rendering fail.
    return "[Unavailable]";
  }
}

/** The arguments of a call as one line, so the row says which file was read rather than only that `read` ran. */
export function toolArgumentSummary(args: unknown): string {
  if (args === undefined || args === null) return "";
  // A tool is free to take a bare scalar rather than an object of named arguments, and `value` already knows how to print one of those without falling back to [object Object].
  if (typeof args !== "object") return previewText(value(args, ""), TOOL_ARGUMENT_PREVIEW_LIMIT);
  const parts = Object.entries(args as Record<string, unknown>)
    .filter(([, item]) => item !== undefined && item !== null && item !== "")
    .map(([key, item]) => `${key}=${toolSignatureValue(item)}`);
  return previewText(parts.join(" · "), TOOL_ARGUMENT_PREVIEW_LIMIT);
}

export function toolSignature(tools: readonly ChatToolCall[]): string {
  return tools
    .map((tool) => `${tool.id}:${tool.name}:${tool.failed ? 1 : 0}:${toolSignatureValue(tool.arguments)}:${toolSignatureValue(tool.result)}`)
    .join("|");
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
    // The turn is memoised on its content, so the active language has to arrive as a prop: without it a switch would leave every turn already on screen labelled in the old language.
    locale?: string;
  }) {
    return (
      <article className={`turn ${role === "user" ? "user" : "text"}`}>
        {role === "user" ? (
          <UserMessageBubble text={text} />
        ) : (
          <>
            {/* A model that emits only whitespace as its reasoning would otherwise open an empty disclosure titled 思考. */}
            {thinking.trim() && (
              <details className="reasoning message-reasoning" open={false}>
                <summary className="reasoning-head">{t("思考")}</summary>
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
                  <span className="turn-tool-status">{tool.result === undefined ? t("执行中…") : tool.failed ? t("失败") : t("完成")}</span>
                </summary>
                {tool.result !== undefined && <pre className="turn-tool-output">{previewText(tool.result, TOOL_RESULT_PREVIEW_LIMIT, false)}</pre>}
              </details>
            ))}
            {text && <MarkdownMessage onMouseUp={onMouseUp} text={text} />}
            {/* An interrupted turn otherwise looks exactly like one that finished on its own, and the aborted flag the prompt call returns is gone after a reload, so the marker is read back from the stored message. */}
            {stopped && <p className="turn-stopped">{t("已中断")}</p>}
          </>
        )}
      </article>
    );
  },
  (previous, next) =>
    previous.locale === next.locale &&
    previous.role === next.role &&
    previous.text === next.text &&
    previous.thinking === next.thinking &&
    previous.stopped === next.stopped &&
    previous.onMouseUp === next.onMouseUp &&
    toolSignature(previous.tools ?? []) === toolSignature(next.tools ?? []),
);

export function ControlRoomView({ api = createClientApi(), appVersion }: { api?: ClientApi; appVersion?: string }) {
  // Subscribed at the root because every label below reads the catalog through t(), so a language switch has to re-render the whole console rather than any one panel.
  const locale = useLocale();
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
  const [initialSessionRestorePending, setInitialSessionRestorePending] = useState(Boolean(initialQueryState.sessionPath));
  const sessionNavigationRef = useRef<Promise<void>>(Promise.resolve());
  const sessionNavigationIntentRef = useRef(0);
  const pendingSessionNavigationRef = useRef<{ intent: number; path?: string; accepted: boolean } | undefined>(undefined);
  const [pendingSessionUrlPath, setPendingSessionUrlPath] = useState<string>();
  const [storedPromptUi, setStoredPromptUi] = useState<ClientPromptUiState>({
    sessionId: undefined,
    draft: "",
    pendingPrompt: "",
    busy: false,
    error: "",
  });
  const promptUi = promptUiForSession(storedPromptUi, data.session?.sessionId);
  const { draft, pendingPrompt, busy: promptBusy, error: promptError } = promptUi;
  const promptScopeRef = useRef<{ sessionId: string | undefined }>({ sessionId: data.session?.sessionId });
  const promptSubmissionIdRef = useRef(0);
  const setDraft = useCallback((value: string | ((current: string) => string)) => {
    setStoredPromptUi((current) => updatePromptDraft(current, promptScopeRef.current.sessionId, value));
  }, []);
  const setPromptError = useCallback((error: string) => {
    setStoredPromptUi((current) => ({ ...promptUiForSession(current, promptScopeRef.current.sessionId), error }));
  }, []);
  const setPromptErrorForScope = useCallback((scope: { sessionId: string | undefined }, error: string) => {
    if (promptScopeRef.current !== scope) return;
    setStoredPromptUi((current) => (current.sessionId === scope.sessionId ? { ...current, error } : current));
  }, []);
  useLayoutEffect(() => {
    promptScopeRef.current = { sessionId: data.session?.sessionId };
    setStoredPromptUi((current) => promptUiForSession(current, data.session?.sessionId));
  }, [data.session?.sessionId]);
  const [storedAnnotationDraft, setStoredAnnotationDraft] = useState<ClientAnnotationDraft>({
    sessionId: undefined,
    annotations: [],
    selection: "",
    note: "",
  });
  const annotationDraft = annotationDraftForSession(storedAnnotationDraft, data.session?.sessionId);
  const { annotations, selection: annotationSelection, note: annotationNote } = annotationDraft;
  const annotationSessionIdRef = useRef(data.session?.sessionId);
  const annotationSelectionFrameRef = useRef<number | undefined>(undefined);
  annotationSessionIdRef.current = data.session?.sessionId;
  useEffect(() => {
    setStoredAnnotationDraft((current) => annotationDraftForSession(current, data.session?.sessionId));
    return () => {
      if (annotationSelectionFrameRef.current !== undefined) {
        window.cancelAnimationFrame(annotationSelectionFrameRef.current);
        annotationSelectionFrameRef.current = undefined;
      }
    };
  }, [data.session?.sessionId]);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [marketplaceQuery, setMarketplaceQuery] = useState(initialQueryState.marketplaceQuery);
  const [marketplaceCapability, setMarketplaceCapability] = useState(initialQueryState.marketplaceCapability);
  const [marketplaceCategory, setMarketplaceCategory] = useState(initialQueryState.marketplaceCategory);
  const [marketplacePluginId, setMarketplacePluginId] = useState<string | undefined>(initialQueryState.marketplacePlugin);
  const [marketplaceDetail, setMarketplaceDetail] = useState<ClientMarketplacePlugin>();
  const [marketplaceDetailPending, setMarketplaceDetailPending] = useState(initialQueryState.marketplacePlugin !== undefined);
  const [marketplaceDetailError, setMarketplaceDetailError] = useState("");
  const [marketplaceCatalogState, setMarketplaceCatalogState] = useState<{ readonly locale: string; readonly plugins: readonly ClientMarketplacePlugin[] }>({
    locale: "",
    plugins: EMPTY_MARKETPLACE_PLUGINS,
  });
  const marketplaceCatalog = marketplaceCatalogState.locale === locale ? marketplaceCatalogState.plugins : EMPTY_MARKETPLACE_PLUGINS;
  const marketplacePageCurrent = data.marketplaceLocale === locale;
  const marketplacePagePlugins = marketplacePageCurrent ? data.marketplace : EMPTY_MARKETPLACE_PLUGINS;
  const marketplacePageCapabilities = marketplacePageCurrent ? data.marketplaceCapabilities : EMPTY_MARKETPLACE_CAPABILITIES;
  const marketplacePageCategories = marketplacePageCurrent ? data.marketplaceCategories : EMPTY_MARKETPLACE_CATEGORIES;
  const [installedPluginId, setInstalledPluginId] = useState<string | undefined>(initialQueryState.installedPlugin);
  const [installedPluginMetadata, setInstalledPluginMetadata] = useState<ClientMarketplacePlugin>();
  const [marketplacePage, setMarketplacePage] = useState(initialQueryState.marketplacePage);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [includeArchivedSessions, setIncludeArchivedSessions] = useState(false);
  const [sessionPage, setSessionPage] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [sessionHasNext, setSessionHasNext] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [selectedSessionPaths, setSelectedSessionPaths] = useState<ReadonlySet<string>>(new Set());
  const importInputRef = useRef<HTMLInputElement>(null);
  const sessionPopoverTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreSessionPopoverFocus = () => {
    const trigger = sessionPopoverTriggerRef.current;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };
  const [streamingAssistant, setStreamingAssistant] = useState<{ thinking: string; text: string }>();
  const [runActivity, setRunActivity] = useState<LocalRunActivity>();
  const [runClockAt, setRunClockAt] = useState(() => Date.now());
  const [eventStreamState, setEventStreamState] = useState<ClientEventStreamState>("connecting");
  const [statusReachable, setStatusReachable] = useState<boolean>();
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const refreshQueuedRef = useRef(false);
  const refreshSequenceRef = useRef({ requested: 0, applied: 0 });
  const liveRefreshSequenceRef = useRef({ status: 0, session: 0, pluginPanels: 0 });
  const resolvedMarketplaceDetailRef = useRef<MarketplaceDetailResolution | undefined>(undefined);
  const [promptCaret, setPromptCaret] = useState(0);
  const [promptCompletionSuppressed, setPromptCompletionSuppressed] = useState(false);
  const [promptCompletionIndex, setPromptCompletionIndex] = useState(0);
  const [initialRefreshPending, setInitialRefreshPending] = useState(true);
  const [refreshIssues, setRefreshIssues] = useState<readonly string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void loadMarketplaceCatalog(api, locale)
      .then((items) => {
        if (!cancelled) setMarketplaceCatalogState({ locale, plugins: items });
      })
      .catch(() => {
        if (!cancelled) setMarketplaceCatalogState({ locale, plugins: EMPTY_MARKETPLACE_PLUGINS });
      });
    return () => {
      cancelled = true;
    };
  }, [api, locale]);
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
  const capabilityLabel = useMemo(() => marketplaceCapabilityLabeller(marketplacePageCapabilities), [marketplacePageCapabilities]);
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
  // Plugins can switch the runtime without a sidebar click. Once loaded,
  // the URL describes the displayed session, not an earlier selection.
  const sessionUrlPath =
    pendingSessionUrlPath ?? (initialSessionRestorePending ? initialQueryState.sessionPath : data.session ? data.session.sessionFile : selectedSessionPath);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    params.set("page", page);
    if (view === "chat") params.delete("view");
    else params.set("view", view);
    if (settings) params.set("settings", settings);
    else params.delete("settings");
    if (sessionUrlPath) params.set("session", sessionUrlPath);
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
    sessionUrlPath,
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
    const plan = marketplaceDetailPlan(
      marketplacePluginId,
      [
        { locale: data.marketplaceLocale ?? "", plugins: data.marketplace },
        { locale: marketplaceCatalogState.locale, plugins: marketplaceCatalogState.plugins },
      ],
      locale,
      resolvedMarketplaceDetailRef.current,
    );
    if (plan.kind === "keep") return;
    if (plan.kind === "clear") {
      resolvedMarketplaceDetailRef.current = undefined;
      setMarketplaceDetail(undefined);
      setMarketplaceDetailPending(false);
      setMarketplaceDetailError("");
      return;
    }
    if (plan.kind === "show") {
      resolvedMarketplaceDetailRef.current = marketplacePluginId === undefined ? undefined : { pluginId: marketplacePluginId, locale };
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
      .listMarketplace("", "", 0, 100, "", locale)
      .then((result) => {
        if (cancelled) return;
        // Only a real answer marks the route resolved; a failed request stays retryable on the next poll.
        resolvedMarketplaceDetailRef.current = marketplacePluginId === undefined ? undefined : { pluginId: marketplacePluginId, locale };
        const plugin = result.items.find((item) => item.id === marketplacePluginId);
        if (plugin === undefined) setMarketplaceDetailError(t("没有找到这个市场插件，它可能已下架。"));
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
  }, [api, data.marketplace, data.marketplaceLocale, locale, marketplaceCatalogState, marketplacePluginId]);
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
      .listMarketplace("", "", 0, 100, "", locale)
      .then((result) => {
        if (!cancelled) setInstalledPluginMetadata(result.items.find((item) => item.packageName === installedPluginId));
      })
      .catch(() => {
        if (!cancelled) setInstalledPluginMetadata(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [api, installedPluginId, locale, marketplaceCatalog]);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current.requested;
    const pendingNavigation = pendingSessionNavigationRef.current;
    const pluginPanels = api.listPluginPanels();
    const requests = [
      api.getStatus(),
      api.getSession(),
      api.listSessions(sessionPage, 30, includeArchivedSessions),
      api.getFiles(),
      api.listModels(),
      api.listProviders(),
      api.listPlugins(),
      api.listMarketplace(marketplaceQuery, marketplaceCapability, marketplacePage, 24, marketplaceCategory, locale),
      api.listCommands(),
      api.listWorkspaces(),
    ] as const;
    const allResults = Promise.allSettled(requests);
    const applyLive = <K extends "status" | "session">(key: K, result: RoomData[K]) => {
      if (sequence < refreshSequenceRef.current.applied || sequence < liveRefreshSequenceRef.current[key]) return;
      liveRefreshSequenceRef.current[key] = sequence;
      // Do not advance the full-batch barrier: a fast status read must not
      // continually invalidate slower panel reads. Setters retain queue order
      // with authoritative navigation updates; updater functions stay pure.
      setData((current) => ({ ...current, [key]: result }));
    };
    const applyLiveStatus = (result: PromiseSettledResult<ClientStatus>) => {
      if (sequence < refreshSequenceRef.current.applied || sequence < liveRefreshSequenceRef.current.status) return;
      liveRefreshSequenceRef.current.status = sequence;
      setStatusReachable(result.status === "fulfilled");
      if (result.status === "fulfilled") setData((current) => ({ ...current, status: result.value }));
    };
    void requests[0].then(
      (value) => applyLiveStatus({ status: "fulfilled", value }),
      (reason: unknown) => applyLiveStatus({ status: "rejected", reason }),
    );
    void requests[1].then(
      (result) => applyLive("session", result),
      () => {},
    );
    const pluginPanelLabel = t("插件面板");
    const applyPluginPanels = (result: PromiseSettledResult<RoomData["pluginPanels"]>) => {
      if (sequence < refreshSequenceRef.current.applied || sequence < liveRefreshSequenceRef.current.pluginPanels) return;
      liveRefreshSequenceRef.current.pluginPanels = sequence;
      if (result.status === "fulfilled") setData((current) => ({ ...current, pluginPanels: result.value }));
      setRefreshIssues((current) => {
        const withoutPluginPanels = current.filter((label) => label !== pluginPanelLabel);
        return result.status === "fulfilled" ? withoutPluginPanels : [...withoutPluginPanels, pluginPanelLabel];
      });
    };
    void pluginPanels.then(
      (value) => applyPluginPanels({ status: "fulfilled", value }),
      (reason: unknown) => applyPluginPanels({ status: "rejected", reason }),
    );
    const results = await allResults;
    const [, session, sessions, files, models, providers, plugins, marketplace, commands, workspaces] = results;
    // Slow older batches must not overwrite a newer applied snapshot. An older
    // result can still render while a newer batch is pending, avoiding starvation.
    if (sequence < refreshSequenceRef.current.applied) return;
    refreshSequenceRef.current.applied = sequence;
    // Only an applied session read started after navigation was accepted can
    // settle its route. Failed reads and older refreshes must not revert it.
    if (session.status === "fulfilled" && pendingNavigation?.accepted && pendingSessionNavigationRef.current === pendingNavigation) {
      pendingSessionNavigationRef.current = undefined;
      setPendingSessionUrlPath(undefined);
    }
    const failedCoreLabels = failedRefreshLabels(
      [t("运行状态"), t("当前会话"), t("会话列表"), t("文件"), t("模型"), t("提供商"), t("插件"), t("插件市场"), t("命令"), t("工作区")],
      results,
    );
    setRefreshIssues((current) => (current.includes(pluginPanelLabel) ? [...failedCoreLabels, pluginPanelLabel] : failedCoreLabels));
    setInitialRefreshPending(false);
    setData((current) => ({
      // Live fields are applied independently above, including stale guards.
      // Reapplying them here could overwrite a newer partial response.
      status: current.status,
      session: current.session,
      sessions: sessions.status === "fulfilled" ? sessions.value.items : current.sessions,
      files: files.status === "fulfilled" ? files.value : current.files,
      models: models.status === "fulfilled" ? models.value : current.models,
      providers: providers.status === "fulfilled" ? providers.value : current.providers,
      plugins: plugins.status === "fulfilled" ? plugins.value : current.plugins,
      pluginPanels: current.pluginPanels,
      marketplace: marketplace.status === "fulfilled" ? marketplace.value.items : current.marketplace,
      marketplaceLocale: marketplace.status === "fulfilled" ? locale : current.marketplaceLocale,
      marketplaceCapabilities: marketplace.status === "fulfilled" ? marketplace.value.capabilities : current.marketplaceCapabilities,
      marketplaceCategories: marketplace.status === "fulfilled" ? marketplace.value.categories : current.marketplaceCategories,
      marketplaceTotal: marketplace.status === "fulfilled" ? marketplace.value.total : current.marketplaceTotal,
      marketplacePage: marketplace.status === "fulfilled" ? marketplace.value.page : current.marketplacePage,
      marketplaceHasNext: marketplace.status === "fulfilled" ? marketplace.value.hasNext : current.marketplaceHasNext,
      commands: commands.status === "fulfilled" ? commands.value : current.commands,
      workspaces: workspaces.status === "fulfilled" ? workspaces.value : current.workspaces,
    }));
    if (sessions.status === "fulfilled") {
      setSessionsLoaded(true);
      setSessionTotal(sessions.value.total);
      setSessionHasNext(sessions.value.hasNext);
    }
  }, [api, includeArchivedSessions, locale, marketplaceCapability, marketplaceCategory, marketplacePage, marketplaceQuery, sessionPage]);
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
      const now = Date.now();
      const receivedAt = typeof runtimeEvent.receivedAt === "number" && Number.isFinite(runtimeEvent.receivedAt) ? runtimeEvent.receivedAt : now;
      const observedAt = Math.min(receivedAt, now);
      const type = runtimeEvent.type;
      const nextPhase: ClientRunPhase | undefined =
        type === "message_update" && typeof runtimeEvent.assistantMessageEvent === "object" && runtimeEvent.assistantMessageEvent !== null
          ? (runtimeEvent.assistantMessageEvent as Record<string, unknown>).type === "thinking_delta"
            ? "thinking"
            : (runtimeEvent.assistantMessageEvent as Record<string, unknown>).type === "text_delta"
              ? "responding"
              : undefined
          : type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end"
            ? "tool"
            : type === "agent_start" || type === "turn_start"
              ? "starting"
              : undefined;
      setRunActivity((current) => {
        if (current === undefined && nextPhase === undefined) return current;
        const startedAt = type === "agent_start" ? observedAt : (current?.startedAt ?? observedAt);
        return {
          startedAt,
          lastActivityAt: Math.max(startedAt, current?.lastActivityAt ?? 0, observedAt),
          phase: nextPhase ?? current?.phase ?? "starting",
        };
      });
      setRunClockAt(now);
      if (type === "agent_start" || type === "turn_start") {
        setStreamingAssistant({ thinking: "", text: "" });
      }
      if (type !== "message_update" || typeof runtimeEvent.assistantMessageEvent !== "object" || runtimeEvent.assistantMessageEvent === null) return;
      const assistantMessageEvent = runtimeEvent.assistantMessageEvent as Record<string, unknown>;
      const deltaType = assistantMessageEvent.type;
      if (deltaType !== "thinking_delta" && deltaType !== "text_delta") return;
      const delta = typeof assistantMessageEvent.delta === "string" ? assistantMessageEvent.delta : "";
      if (!delta) return;
      setStreamingAssistant((current) => ({
        thinking: (current?.thinking ?? "") + (deltaType === "thinking_delta" ? delta : ""),
        text: (current?.text ?? "") + (deltaType === "text_delta" ? delta : ""),
      }));
    },
    [scheduleRefresh],
  );
  const handleRuntimeEventRef = useRef(handleRuntimeEvent);
  const handleEventStreamStateRef = useRef<(state: ClientEventStreamState) => void>((state) => setEventStreamState(state));
  const refreshRef = useRef(refresh);
  const createNewSession = useCallback(
    (workspace?: ClientWorkspace) => {
      const promptScope = promptScopeRef.current;
      setPromptError("");
      setWorkspaceError("");
      const intent = ++sessionNavigationIntentRef.current;
      pendingSessionNavigationRef.current = { intent, accepted: false };
      setPendingSessionUrlPath(undefined);
      sessionNavigationRef.current = sessionNavigationRef.current.then(async () => {
        try {
          const created = await api.createSession(workspace?.path);
          // The create response supersedes every refresh started before it.
          // Reserve a sequence so those batches cannot restore the old room
          // while the post-create refresh is still pending.
          refreshSequenceRef.current.applied = ++refreshSequenceRef.current.requested;
          if (pendingSessionNavigationRef.current?.intent === intent) {
            pendingSessionNavigationRef.current = { intent, path: created.sessionFile, accepted: true };
            setPendingSessionUrlPath(created.sessionFile);
          }
          if (created.sessionFile) setSelectedSessionPath(created.sessionFile);
          // The create response is authoritative for the newly selected
          // session. Apply it before the broad refresh so a concurrent stale
          // /api/session read cannot briefly put the previous session back in
          // the room or leave the active row showing its message count.
          setData((current) => ({ ...current, session: created }));
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
          if (pendingSessionNavigationRef.current?.intent === intent) {
            pendingSessionNavigationRef.current = undefined;
            setPendingSessionUrlPath(undefined);
          }
          const message = cause instanceof Error ? cause.message : String(cause);
          if (workspace) setWorkspaceError(message);
          else setPromptErrorForScope(promptScope, message);
        }
      });
      return sessionNavigationRef.current;
    },
    [api, refresh, setPromptError, setPromptErrorForScope],
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
  useEffect(() => subscribeRuntimeEvents(api, handleRuntimeEventRef, handleEventStreamStateRef), [api]);
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
    const now = Date.now();
    setRunActivity((current) => runActivityFromStatus(data.status, current, now));
    setRunClockAt(now);
    if (data.status?.status === "running") {
      setStreamingAssistant((current) => current ?? { thinking: "", text: "" });
    } else {
      setStreamingAssistant(undefined);
    }
  }, [data.status?.run?.lastActivityAt, data.status?.run?.phase, data.status?.run?.startedAt, data.status?.status]);
  useEffect(() => {
    if (data.status?.status !== "running") return;
    const timer = window.setInterval(() => setRunClockAt(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [data.status?.status]);
  useEffect(() => {
    const path = initialSessionPathRef.current;
    if (!path || sessionRestoreAttemptedRef.current || !sessionsLoaded) return;
    sessionRestoreAttemptedRef.current = true;
    if (sessionNavigationIntentRef.current > 0) {
      setInitialSessionRestorePending(false);
      return;
    }
    const target = data.sessions.find((session) => session.path === path);
    if (!target || typeof target.path !== "string") {
      setSelectedSessionPath(undefined);
      setInitialSessionRestorePending(false);
      return;
    }
    if (data.session?.sessionFile === target.path) {
      setInitialSessionRestorePending(false);
      return;
    }
    const promptScope = promptScopeRef.current;
    sessionNavigationRef.current = sessionNavigationRef.current
      .then(async () => {
        if (sessionNavigationIntentRef.current > 0) return;
        await api.openSession(path);
        if (sessionNavigationIntentRef.current === 0) {
          pendingSessionNavigationRef.current = { intent: 0, path, accepted: true };
          setPendingSessionUrlPath(path);
        }
        await refresh();
      })
      .catch((cause: unknown) => setPromptErrorForScope(promptScope, cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setInitialSessionRestorePending(false));
  }, [api, data.session?.sessionFile, data.sessions, refresh, sessionsLoaded, setPromptErrorForScope]);
  useEffect(() => {
    setCommandIndex(0);
    if (!commandOpen) return;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [commandOpen, commandQuery]);
  const stopRun = useCallback(() => {
    const promptScope = promptScopeRef.current;
    setPromptError("");
    void api
      .abort()
      .then(refresh)
      .catch((cause: unknown) => setPromptErrorForScope(promptScope, cause instanceof Error ? cause.message : String(cause)));
  }, [api, refresh, setPromptError, setPromptErrorForScope]);
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
  const events = useMemo(
    () => mergeTrajectoryEvents(data.session?.entries ?? [], data.session?.events ?? []),
    [data.session?.entries, data.session?.events],
  );
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
      value(session.name ?? session.firstMessage, t("未命名会话"))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    const prompt = annotations.length > 0 ? formatAnnotationPrompt(annotations, question) : question;
    const submittedSessionId = annotationDraft.sessionId;
    const delivery = promptDelivery(promptBusy, data.status?.status);
    if (!prompt || !delivery) return;
    const submissionId = ++promptSubmissionIdRef.current;
    setStoredPromptUi((current) => startPromptSubmission(current, data.session?.sessionId, submissionId, prompt));
    setStreamingAssistant(undefined);
    stickToBottomRef.current = true;
    void runPromptSubmission(() => api.prompt(prompt, delivery === "steer" ? "steer" : undefined), refresh, {
      accepted: () => {
        setStoredAnnotationDraft((current) => clearSubmittedAnnotations(current, submittedSessionId));
      },
      rejected: (cause) => {
        // A rejected request was never accepted as a turn. Keep it editable,
        // without replacing a new draft the user typed while awaiting it.
        setStoredPromptUi((current) => failPromptSubmission(current, submissionId, question, cause instanceof Error ? cause.message : String(cause)));
      },
      refreshRejected: (cause) => {
        setStoredPromptUi((current) => reportPromptRefreshFailure(current, submissionId, cause instanceof Error ? cause.message : String(cause)));
      },
      settled: () => setStoredPromptUi((current) => finishPromptSubmission(current, submissionId)),
    });
  };
  const captureAnnotationSelection = useCallback(() => {
    if (annotationSelectionFrameRef.current !== undefined) window.cancelAnimationFrame(annotationSelectionFrameRef.current);
    const scheduledSessionId = annotationSessionIdRef.current;
    annotationSelectionFrameRef.current = window.requestAnimationFrame(() => {
      annotationSelectionFrameRef.current = undefined;
      if (annotationSessionIdRef.current !== scheduledSessionId) return;
      const selected = window.getSelection()?.toString().trim() ?? "";
      if (selected.length > 0)
        setStoredAnnotationDraft((current) =>
          captureSelectionForSession(current, scheduledSessionId, annotationSessionIdRef.current, selected.slice(0, 4_000)),
        );
    });
  }, []);
  const addAnnotation = () => {
    const quote = annotationSelection.trim();
    if (!quote) return;
    setStoredAnnotationDraft((current) => {
      const scoped = annotationDraftForSession(current, data.session?.sessionId);
      return {
        ...scoped,
        annotations: [
          ...scoped.annotations,
          { id: scoped.annotations.length === 0 ? 1 : Math.max(...scoped.annotations.map((item) => item.id)) + 1, quote, note: annotationNote.trim() },
        ],
        selection: "",
        note: "",
      };
    });
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
    const promptScope = promptScopeRef.current;
    const intent = ++sessionNavigationIntentRef.current;
    pendingSessionNavigationRef.current = { intent, path, accepted: false };
    setPendingSessionUrlPath(path);
    setSettings(undefined);
    setCommandOpen(false);
    setGlobalSearchOpen(false);
    setPage("session");
    setView("chat");
    setDetails(undefined);
    setSelectedSessionPath(path);
    // Check the runtime, not the cached page snapshot: a newly created session
    // can be active before refresh has painted it. Reopening the actual active
    // session would discard session-scoped plugin state just to navigate back.
    // Serialize navigation, including the read, so an earlier slow switch
    // cannot finish after the user's latest selection and replace it.
    sessionNavigationRef.current = sessionNavigationRef.current
      .then(async () => {
        const current = await api.getSession();
        const opened = path !== current.sessionFile ? await api.openSession(path) : current;
        refreshSequenceRef.current.applied = ++refreshSequenceRef.current.requested;
        setData((previous) => ({ ...previous, session: opened }));
        if (pendingSessionNavigationRef.current?.intent === intent) {
          pendingSessionNavigationRef.current = { intent, path, accepted: true };
        }
      })
      .then(refresh)
      .catch((cause: unknown) => {
        if (pendingSessionNavigationRef.current?.intent === intent) {
          pendingSessionNavigationRef.current = undefined;
          setPendingSessionUrlPath(undefined);
        }
        setPromptErrorForScope(promptScope, cause instanceof Error ? cause.message : String(cause));
      });
  };
  const sessionAction = async (action: () => Promise<void>) => {
    if (sessionActionBusy) return;
    const promptScope = promptScopeRef.current;
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
      setPromptErrorForScope(promptScope, cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSessionActionBusy(false);
    }
  };
  const activeSessionPath = data.session?.sessionFile;
  const selectedSessionMetadata = [...selectedSessionPaths].map((path) => {
    const listed = data.sessions.find((session) => session.path === path);
    if (listed) return { archived: listed.archived === true, pinned: listed.pinned === true };
    if (path === activeSessionPath) return { archived: data.session?.archived === true, pinned: data.session?.pinned === true };
    return {};
  });
  const selectedArchiveAction = archiveActionForSessions(selectedSessionMetadata);
  const selectedPinAction = pinActionForSessions(selectedSessionMetadata);
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
    setSessionActionTarget({ name: name || t("未命名会话"), path });
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
  const runTelemetry =
    data.status?.status === "running" && runActivity !== undefined ? runTelemetryView(runActivity, eventStreamState, statusReachable, runClockAt) : undefined;
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
      activeSessionId={data.session?.sessionId}
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
    <section className="view-panel min-w-0 overflow-auto bg-[var(--color-soft)]">
      <div className="subnav plugin-detail-subnav bg-[var(--color-surface)]">
        <a
          href="?page=plugins"
          onClick={(event) => {
            event.preventDefault();
            pushInstalledPluginRoute(undefined);
          }}
        >
          {t("← 已安装插件")}
        </a>
        <span>{t("插件详情")}</span>
      </div>
      <div className="empty-state">{data.status ? t("没有找到这个已安装插件，它可能已被移除。") : t("正在读取插件详情…")}</div>
    </section>
  ) : page === "plugins" ? (
    <Plugins
      activeSessionId={data.session?.sessionId}
      capabilityLabel={capabilityLabel}
      plugins={data.plugins}
      panels={data.pluginPanels}
      catalog={marketplaceCatalog.length ? marketplaceCatalog : marketplacePagePlugins}
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
              {t("← 插件市场")}
            </a>
            <span>{t("插件详情")}</span>
          </div>
          <div className="empty-state">
            {marketplaceDetailPending ? t("正在读取插件详情…") : marketplaceDetailError || t("没有找到这个市场插件，它可能已下架。")}
          </div>
        </div>
      </section>
    ) : (
      <Marketplace
        plugins={marketplacePagePlugins}
        capabilities={marketplacePageCapabilities}
        capabilityLabel={capabilityLabel}
        categories={marketplacePageCategories}
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
        className={`chat-scroll ${data.session?.messages.length || data.status?.status === "running" ? "" : "is-empty"}`}
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
              locale={locale}
              onMouseUp={captureAnnotationSelection}
              role={turn.role}
              stopped={turn.stopped}
              text={turn.text}
              thinking={turn.thinking}
              tools={turn.tools}
            />
          ))
        ) : data.status?.status !== "running" ? (
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
        ) : null}
        {runTelemetry && data.status?.status === "running" && (
          <article className={`turn text streaming-turn ${runTelemetry.tone}`}>
            <span aria-live="polite" className="visually-hidden" role="status">
              {runAnnouncementText(runTelemetry)}
            </span>
            {streamingAssistant?.thinking && (
              <details className="reasoning message-reasoning" open={false}>
                <summary className="reasoning-head">
                  {t("思考中…")}
                  <span className="streaming-elapsed">{formatRunClock(runTelemetry.elapsedSeconds)}</span>
                </summary>
                <div className="reasoning-body">
                  <MarkdownMessage text={streamingAssistant.thinking} />
                </div>
              </details>
            )}
            {!streamingAssistant?.thinking && !streamingAssistant?.text && (
              <div className="streaming-placeholder">
                <span className="streaming-spinner" />
                {runPhaseText(runTelemetry.phase)}
                <span className="streaming-elapsed">{formatRunClock(runTelemetry.elapsedSeconds)}</span>
              </div>
            )}
            {streamingAssistant?.text && <MarkdownMessage onMouseUp={captureAnnotationSelection} text={streamingAssistant.text} />}
            {runTelemetry.tone !== "active" && <div className={`streaming-activity ${runTelemetry.tone}`}>{runToneText(runTelemetry)}</div>}
            {runTelemetry.elapsedSeconds > 300 && (
              <div className="streaming-timeout-warning">
                <span>{t("已运行 {seconds} 秒，模型响应较慢", { seconds: runTelemetry.elapsedSeconds })}</span>
                <button onClick={() => void api.abort()} type="button">
                  {t("停止")}
                </button>
              </div>
            )}
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
            <span className="context-label">{t("实时上下文")}</span>
            <div className="context-metrics">
              <span>
                <b>{data.status?.messages ?? 0}</b> {t("条消息")}
              </span>
              <span>
                <b>{data.status?.events ?? events.length}</b> {t("个事件")}
              </span>
              <span>
                <b>{value(data.status?.model)}</b>
              </span>
            </div>
          </div>
        </div>
        <div className="composer-stack">
          <ProviderAuthNotice model={data.status?.model} providers={data.providers} onConfigure={() => setSettings("providers")} />
          {promptError && <PromptError message={promptError} />}
          {annotationSelection ? (
            <div aria-label={t("添加批注")} className="rounded-lg border border-[#cdddf8] bg-[var(--color-blue-soft)] px-3 py-2">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-[var(--color-blue-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-blue)]">{t("选中片段")}</span>
                <p className="max-h-16 flex-1 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--color-ink)]">{annotationSelection}</p>
                <button
                  aria-label={t("取消批注")}
                  className="text-[12px] text-[var(--color-faint)]"
                  onClick={() =>
                    setStoredAnnotationDraft((current) => ({ ...annotationDraftForSession(current, data.session?.sessionId), selection: "", note: "" }))
                  }
                  type="button"
                >
                  ×
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  aria-label={t("批注备注")}
                  className="min-w-0 flex-1 rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1.5 text-[11px] outline-none"
                  onChange={(event) =>
                    setStoredAnnotationDraft((current) => ({ ...annotationDraftForSession(current, data.session?.sessionId), note: event.target.value }))
                  }
                  placeholder={t("备注（可选）")}
                  value={annotationNote}
                />
                <button className="rounded-md bg-[#3565c5] px-3 py-1.5 text-[11px] font-medium text-white" onClick={addAnnotation} type="button">
                  {t("加入批注")}
                </button>
              </div>
            </div>
          ) : null}
          {annotations.length > 0 ? (
            <div className="flex items-center gap-2 overflow-x-auto text-[10px]">
              <span className="shrink-0 rounded-md bg-[var(--color-blue-soft)] px-2 py-1 font-medium text-[var(--color-blue)]">
                {t("批注 ×{v0}", { v0: annotations.length })}
              </span>
              {annotations.map((annotation) => (
                <button
                  className="max-w-48 shrink-0 truncate rounded-md border border-[#dce5f5] bg-[var(--color-surface)] px-2 py-1 text-left text-[var(--color-muted)]"
                  key={annotation.id}
                  onClick={() =>
                    setStoredAnnotationDraft((current) => {
                      const scoped = annotationDraftForSession(current, data.session?.sessionId);
                      return { ...scoped, annotations: scoped.annotations.filter((item) => item.id !== annotation.id) };
                    })
                  }
                  title={t("点击移除批注")}
                  type="button"
                >
                  #{annotation.id} {annotation.quote}
                </button>
              ))}
              <button
                className="shrink-0 text-[var(--color-faint)]"
                onClick={() => setStoredAnnotationDraft((current) => ({ ...annotationDraftForSession(current, data.session?.sessionId), annotations: [] }))}
                type="button"
              >
                {t("清空")}
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
                workspaceReady
                  ? data.commands.length
                    ? t("描述要做的改动，⌘↵ 发送；@ 引用文件，/ 调用命令")
                    : t("描述要做的改动，⌘↵ 发送；@ 引用文件")
                  : t("先选择工作区，再描述要做的改动")
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
                aria-label={t("模型")}
                disabled={!data.models.length || promptBusy}
                value={data.status?.model ?? ""}
                onChange={(event) => {
                  const [provider, ...modelParts] = event.target.value.split("/");
                  const model = modelParts.join("/");
                  if (!provider || !model) return;
                  const promptScope = promptScopeRef.current;
                  setPromptError("");
                  void api
                    .selectModel(provider, model)
                    .then(refresh)
                    .catch((cause: unknown) => setPromptErrorForScope(promptScope, cause instanceof Error ? cause.message : String(cause)));
                }}
              >
                {data.models.length ? (
                  data.models.map((model) => (
                    <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                      {model.name === model.id ? `${model.provider}/${model.id}` : `${model.name} (${model.provider})`}
                    </option>
                  ))
                ) : (
                  <option value="">{t("暂无可用模型")}</option>
                )}
              </select>
              {/* The title rides on the wrapper because a disabled button never shows one, and the empty runtime is exactly when the explanation is needed. */}
              <span className="tool-chip-hint" title={data.commands.length ? t("插入斜杠并列出命令") : t("当前运行时还没有注册任何命令")}>
                <button className="tool-chip" disabled={!data.commands.length} onClick={openCommandCompletion} type="button">
                  {t("／ 命令")}
                </button>
              </span>
              <span className="composer-hint">{t("⌘↵ 发送 · ⌘K 命令 · ⌃C 中断")}</span>
              <button
                aria-label={promptDelivery(promptBusy, data.status?.status) ? t("发送消息") : t("发送中")}
                className="send-button"
                disabled={!promptDelivery(promptBusy, data.status?.status) || !draft.trim()}
                title={promptDelivery(promptBusy, data.status?.status) ? t("发送消息（⌘↵）") : t("正在发送")}
                type="submit"
              >
                {promptDelivery(promptBusy, data.status?.status) ? "↑" : "…"}
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
          output: diff.diff || t("没有可显示的差异（工作区可能已更新）。"),
        });
      }}
      onRefresh={() => void refresh()}
    />
  );
  const groups = sessionGroups(filteredSessions);
  const showCurrentSession = Boolean(data.session && !search && !filteredSessions.some((session) => session.sessionId === data.session?.sessionId));
  const visibleCommands = filterCommands(data.commands, commandQuery);
  const betterSidebarPanel = data.pluginPanels.find((panel) => panel.id === "better-sidebar-panel");
  const betterSidebarData = betterSidebarPanelView(betterSidebarPanel?.data, data.session?.sessionId);
  const themeStudioPanel = data.pluginPanels.find((panel) => panel.id === "theme-studio-panel");
  const themeStudioData = useMemo(() => themeStudioView(themeStudioPanel?.data, data.session?.sessionId), [data.session?.sessionId, themeStudioPanel?.data]);
  const themeStyle = themeStudioData
    ? { ...themeStudioData.tokens, color: themeStudioData.tokens["--color-ink"], colorScheme: themeStudioData.theme === "midnight" ? "dark" : "light" }
    : undefined;
  const activeTheme = themeStudioData?.theme;
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
    [draft, setDraft],
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
            {t("＋ 新建会话")}
          </button>
          <div className="session-search" data-command-palette>
            <input
              aria-controls={commandOpen ? "command-menu" : undefined}
              aria-expanded={commandOpen}
              aria-label={commandOpen ? t("搜索命令") : t("搜索会话")}
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
              placeholder={commandOpen ? t("输入命令名称或描述") : t("搜索会话 · ⌘K 命令")}
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
            aria-label={t("导入会话文件")}
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              void sessionAction(async () => {
                const imported = await api.importSession(await file.text(), file.name);
                if (imported.sessionFile) setSelectedSessionPath(imported.sessionFile);
                // Import returns a receipt, not the imported message history.
                // Read that history without waiting for unrelated refresh APIs.
                const session = await api.getSession();
                if (session.sessionId !== imported.sessionId) throw new Error("Imported session is no longer active");
                refreshSequenceRef.current.applied = ++refreshSequenceRef.current.requested;
                setData((current) => ({ ...current, session }));
              });
            }}
            ref={importInputRef}
            type="file"
          />
        </div>
        <div className="session-list-toolbar">
          <div className="session-list-title">
            <strong>{t("会话")}</strong>
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
              {sessionSelectionMode ? t("完成") : t("选择")}
            </button>
            <div className="session-tools-wrap" data-session-popover>
              <button
                aria-expanded={sessionToolsOpen}
                aria-haspopup="menu"
                aria-label={t("会话工具")}
                className="session-tool-button icon"
                disabled={sessionActionBusy}
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
                  <div className="session-tools-popover" data-session-popover role="menu" style={{ ...themeStyle, ...sessionToolsPosition }}>
                    <button
                      autoFocus
                      onClick={() => {
                        setSessionToolsOpen(false);
                        setSessionToolsPosition(undefined);
                        void refresh();
                        restoreSessionPopoverFocus();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      {t("刷新列表")}
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
                      {t("导入会话")}
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
                      {t("导出当前会话")}
                    </button>
                    <button
                      onClick={() => {
                        setIncludeArchivedSessions((current) => !current);
                        setSessionPage(0);
                        setSelectedSessionPaths(new Set());
                        setSessionToolsOpen(false);
                        setSessionToolsPosition(undefined);
                        restoreSessionPopoverFocus();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      {includeArchivedSessions ? t("隐藏归档会话") : t("显示归档会话")}
                    </button>
                  </div>,
                  document.body,
                )}
            </div>
          </div>
        </div>
        {sessionSelectionMode && selectedSessionPaths.size > 0 && (
          <div className="session-batch-bar">
            <span>{t("{v0} 个已选择", { v0: selectedSessionPaths.size })}</span>
            <button
              disabled={sessionActionBusy}
              onClick={() => void sessionAction(() => api.batchSessions(selectedArchiveAction, [...selectedSessionPaths]).then(() => undefined))}
              type="button"
            >
              {selectedArchiveAction === "unarchive" ? t("恢复") : t("归档")}
            </button>
            <button
              disabled={sessionActionBusy}
              onClick={() => void sessionAction(() => api.batchSessions(selectedPinAction, [...selectedSessionPaths]).then(() => undefined))}
              type="button"
            >
              {selectedPinAction === "unpin" ? t("取消置顶") : t("置顶")}
            </button>
            <button
              className="danger"
              disabled={sessionActionBusy}
              onClick={() => {
                setSessionActionTarget(undefined);
                setSessionDialog("batch-delete");
              }}
              type="button"
            >
              {t("删除")}
            </button>
          </div>
        )}
        <div className="sidebar-scroll">
          {showCurrentSession && data.session && (
            <div className="session-group">
              <div className="group-label">{t("当前")}</div>
              <div className="session-row-wrap current-session-row">
                {sessionSelectionMode && (
                  <input
                    aria-label={t("选择当前会话")}
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
                    <strong>{data.session.name ?? (data.session.messages.length ? data.session.sessionId.slice(0, 12) : t("新会话"))}</strong>
                    <small>
                      {t("{v0} 条消息{v1} {v2}", {
                        v0: data.session.messages.length,
                        v1: data.session.pinned === true ? t(" · 已置顶") : "",
                        v2: data.session.archived === true ? t(" · 已归档") : "",
                      })}
                    </small>
                  </span>
                </button>
                {!sessionSelectionMode && activeSessionPath && (
                  <button
                    aria-expanded={sessionMenuOpen && sessionMenuPath === activeSessionPath}
                    aria-haspopup="menu"
                    aria-label={t("当前会话操作")}
                    className="session-row-more"
                    data-session-popover
                    onClick={(event) =>
                      openSessionMenu(
                        activeSessionPath,
                        data.session?.name ?? (data.session?.messages.length ? data.session?.sessionId.slice(0, 12) : t("新会话")),
                        event.currentTarget,
                      )
                    }
                    type="button"
                  >
                    ⋯
                  </button>
                )}
                {!sessionSelectionMode && activeSessionPath && sessionMenuPath === activeSessionPath && sessionMenuOpen && sessionMenuPosition && (
                  <SessionActionMenu
                    archived={data.session.archived === true}
                    busy={sessionActionBusy}
                    pinned={data.session.pinned === true}
                    position={sessionMenuPosition}
                    themeStyle={themeStyle}
                    onArchive={() => {
                      closeSessionMenu();
                      if (data.session?.archived === true) {
                        void sessionAction(() => api.setSessionMetadata(activeSessionPath, { archived: false }).then(() => undefined));
                      } else {
                        setSessionDialog("archive");
                      }
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
                          const session = await api.openSession(result.sessionFile);
                          refreshSequenceRef.current.applied = ++refreshSequenceRef.current.requested;
                          setData((current) => ({ ...current, session }));
                        }
                      })
                    }
                    onPin={() => {
                      closeSessionMenu();
                      void sessionAction(() => api.setSessionMetadata(activeSessionPath, { pinned: data.session?.pinned !== true }).then(() => undefined));
                    }}
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
            groups.map(([groupId, sessions]) => (
              <div className="session-group" key={groupId}>
                <div className="group-label">{sessionGroupLabel(groupId)}</div>
                {sessions.map((session, index) => (
                  <div className="session-row-wrap" key={index}>
                    {sessionSelectionMode && (
                      <input
                        aria-label={t("选择会话 {name}", { name: value(session.name ?? session.firstMessage, t("未命名会话")) })}
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
                        <strong>
                          {value(session.name ?? (typeof session.firstMessage === "string" ? truncateSessionTitle(session.firstMessage) : ""), "未命名会话")}
                        </strong>
                        <small>
                          {t("{v0} 条消息{v1} {v2}", {
                            v0: value(session.messageCount, "0"),
                            v1: session.pinned === true ? t(" · 已置顶") : "",
                            v2: session.archived === true ? t(" · 已归档") : "",
                          })}
                        </small>
                      </span>
                    </button>
                    {!sessionSelectionMode && typeof session.path === "string" && (
                      <button
                        aria-expanded={sessionMenuOpen && sessionMenuPath === session.path}
                        aria-haspopup="menu"
                        aria-label={t("会话操作 {name}", { name: value(session.name ?? session.firstMessage, t("未命名会话")) })}
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
                          archived={session.archived === true}
                          busy={sessionActionBusy}
                          pinned={session.pinned === true}
                          position={sessionMenuPosition}
                          themeStyle={themeStyle}
                          onArchive={() => {
                            closeSessionMenu();
                            if (session.archived === true) {
                              void sessionAction(() => api.setSessionMetadata(session.path as string, { archived: false }).then(() => undefined));
                            } else {
                              setSessionDialog("archive");
                            }
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
                                const session = await api.openSession(result.sessionFile);
                                refreshSequenceRef.current.applied = ++refreshSequenceRef.current.requested;
                                setData((current) => ({ ...current, session }));
                              }
                            })
                          }
                          onPin={() => {
                            closeSessionMenu();
                            void sessionAction(() => api.setSessionMetadata(session.path as string, { pinned: session.pinned !== true }).then(() => undefined));
                          }}
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
            <div className="empty-state">{t("暂无已保存会话")}</div>
          ) : null}
          {sessionTotal > 30 && (
            <div className="session-pagination">
              <button
                disabled={sessionPage === 0}
                onClick={() => {
                  setSelectedSessionPaths(new Set());
                  setSessionPage((page) => Math.max(0, page - 1));
                }}
                type="button"
              >
                {t("上一页")}
              </button>
              <span>
                {sessionPage + 1} / {Math.max(1, Math.ceil(sessionTotal / 30))}
              </span>
              <button
                disabled={!sessionHasNext}
                onClick={() => {
                  setSelectedSessionPaths(new Set());
                  setSessionPage((page) => page + 1);
                }}
                type="button"
              >
                {t("下一页")}
              </button>
            </div>
          )}
          {!betterSidebarData.malformed && (
            <section aria-label={t("工作区概览")} className="mx-3 mt-3 rounded-lg border border-[#dce5f5] bg-[var(--color-blue-soft)] px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-[11px] font-semibold text-[var(--color-ink)]">{t("工作区概览")}</strong>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${betterSidebarData.clean ? "bg-[var(--color-green-soft)] text-[var(--color-green)]" : betterSidebarData.gitAvailable ? "bg-[var(--color-red-soft)] text-[var(--color-red)]" : "bg-[var(--color-soft)] text-[var(--color-faint)]"}`}
                >
                  {!betterSidebarData.gitAvailable
                    ? t("不可用")
                    : betterSidebarData.clean
                      ? "clean"
                      : t("{count} 变更", { count: betterSidebarData.changedCount })}
                </span>
              </div>
              <code className="mt-2 block whitespace-pre-wrap text-[10px] text-[var(--color-blue)] [overflow-wrap:anywhere]">{betterSidebarData.cwd}</code>
              <p className="mt-1 whitespace-pre-wrap font-mono text-[10px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
                {betterSidebarData.gitAvailable
                  ? (betterSidebarData.branch ?? "detached HEAD")
                  : betterSidebarGitFailureText(betterSidebarData.gitFailureReason)}
              </p>
              {betterSidebarData.changedFiles.length > 0 ? (
                <div
                  aria-label={t("工作区 Git 变更")}
                  className="mt-2 grid max-h-80 gap-1 overflow-y-auto border-t border-[#dce5f5] pt-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-blue)]"
                  tabIndex={0}
                >
                  {betterSidebarData.changedFiles.slice(0, 3).map((file) => (
                    <code className="whitespace-pre-wrap text-[9px] text-[var(--color-muted)] [overflow-wrap:anywhere]" key={`${file.status}\0${file.path}`}>
                      {file.status} {file.originalPath === undefined ? "" : `${file.originalPath} → `}
                      {file.path}
                    </code>
                  ))}
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
            aria-label={t("搜索会话、文件和命令")}
            className="sidebar-link compact-session-search"
            onClick={() => {
              setCommandOpen(false);
              setSessionToolsOpen(false);
              closeSessionMenu();
              setGlobalSearchOpen(true);
            }}
            title={t("搜索会话、文件和命令")}
            type="button"
          >
            ⌕
          </button>
          <button aria-label={t("新建会话")} className="sidebar-link compact-new-session" onClick={beginNewSession} title={t("新建会话")} type="button">
            ＋
          </button>
          <button
            aria-label={t("插件，已安装 {count} 个", { count: installedPluginCount })}
            className={`sidebar-link ${page === "plugins" || page === "marketplace" ? "active" : ""}`}
            onClick={() => pushInstalledPluginRoute(undefined)}
            title={t("插件 · {count} 个", { count: installedPluginCount })}
            type="button"
          >
            ◈ <span>{t("插件")}</span>
            <b>{installedPluginCount}</b>
          </button>
          <button
            aria-label={t("设置")}
            className={`sidebar-link ${settings ? "active" : ""}`}
            onClick={() => {
              setCommandOpen(false);
              setGlobalSearchOpen(false);
              setSessionMenuOpen(false);
              setSessionMenuPath(undefined);
              setDetails(undefined);
              setSettings("general");
            }}
            title={t("设置")}
            type="button"
          >
            ⚙ <span>{t("设置")}</span>
          </button>
        </footer>
      </aside>
      <section className="main-pane">
        <header className={`main-header ${!settings && page === "session" ? "session-track" : ""}`}>
          <div className="active-heading">
            <strong>
              {settings
                ? t("设置")
                : page === "plugins" || page === "marketplace"
                  ? installedPluginId || marketplacePluginId
                    ? t("插件详情")
                    : t("插件")
                  : (data.session?.name ?? (data.session?.messages.length ? data.session.sessionId.slice(0, 12) : t("新会话")))}
            </strong>
            <small>
              {settings
                ? t("运行时状态与配置")
                : page === "plugins"
                  ? installedPluginId
                    ? (installedPluginMetadata?.name ?? displayPluginName(installedPluginId))
                    : t("安装、启用与卸载")
                  : page === "marketplace"
                    ? marketplacePluginId
                      ? (marketplaceDetail?.name ?? marketplacePluginId)
                      : t("官方与社区 · 已审核目录")
                    : sessionSource(data.status, data.session)}
            </small>
          </div>
          <div className="header-spacer"></div>
          {runTelemetry && (
            <div className={`run-indicator running ${runTelemetry.tone}`}>
              <span aria-hidden="true" className="run-dot"></span>
              <span className="run-phase">{runPhaseText(runTelemetry.phase)}</span>
              <span aria-label={t("已运行 {time}", { time: formatRunClock(runTelemetry.elapsedSeconds) })} className="run-clock">
                {formatRunClock(runTelemetry.elapsedSeconds)}
              </span>
              <span className="run-activity">{runToneText(runTelemetry)}</span>
              <button className="stop-button" onClick={stopRun} title={t("停止当前运行（⌃C）")} type="button">
                {t("停止")}
              </button>
            </div>
          )}
          {!settings && page === "session" && (
            <div aria-label={t("会话视图")} className="view-tabs">
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
                  {item === "chat" ? t("对话") : item === "trajectory" ? t("轨迹") : t("产出")}
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
                  disabled={sessionActionBusy}
                  onClick={(event) => {
                    setSessionToolsOpen(false);
                    setSessionToolsPosition(undefined);
                    const closeCurrentMenu = sessionMenuOpen && !sessionMenuPath;
                    setSessionMenuPath(undefined);
                    setSessionMenuPosition(undefined);
                    sessionPopoverTriggerRef.current = event.currentTarget;
                    setSessionActionTarget(
                      !closeCurrentMenu && activeSessionPath
                        ? { name: data.session?.sessionId?.slice(0, 12) || t("当前会话"), path: activeSessionPath }
                        : undefined,
                    );
                    setSessionMenuOpen(!closeCurrentMenu);
                  }}
                  type="button"
                  aria-label={t("会话操作")}
                >
                  ⋯
                </button>
                {sessionMenuOpen && !sessionMenuPath && (
                  <div className="session-menu-popover compact-session-menu" role="menu">
                    <button
                      className="session-action"
                      disabled={!activeSessionPath || sessionActionBusy}
                      onClick={() => {
                        setSessionNameDraft(data.session?.name ?? data.session?.sessionId?.slice(0, 12) ?? "");
                        setSessionDialog("rename");
                        setSessionMenuOpen(false);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <strong>{t("重命名")}</strong>
                      <small>{t("设置一个容易识别的名称")}</small>
                    </button>
                    <button
                      className="session-action"
                      disabled={!activeSessionPath || sessionActionBusy}
                      onClick={() =>
                        void sessionAction(async () => {
                          const result = await api.forkSession(activeSessionPath as string);
                          if (result.sessionFile) {
                            setSelectedSessionPath(result.sessionFile);
                            const session = await api.openSession(result.sessionFile);
                            refreshSequenceRef.current.applied = ++refreshSequenceRef.current.requested;
                            setData((current) => ({ ...current, session }));
                          }
                        })
                      }
                      role="menuitem"
                      type="button"
                    >
                      <strong>{t("复制会话")}</strong>
                      <small>{t("复制上下文并打开副本")}</small>
                    </button>
                    <button
                      className="session-action"
                      disabled={!activeSessionPath || sessionActionBusy}
                      onClick={() => {
                        setSessionMenuOpen(false);
                        if (activeSessionPath) {
                          void sessionAction(() => api.setSessionMetadata(activeSessionPath, { pinned: data.session?.pinned !== true }).then(() => undefined));
                        }
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <strong>{data.session?.pinned === true ? t("取消置顶") : t("置顶")}</strong>
                      <small>{data.session?.pinned === true ? t("从置顶区域移除") : t("固定在会话列表顶部")}</small>
                    </button>
                    <button
                      className="session-action"
                      disabled={!activeSessionPath || sessionActionBusy}
                      onClick={() => {
                        setSessionMenuOpen(false);
                        if (data.session?.archived === true && activeSessionPath) {
                          void sessionAction(() => api.setSessionMetadata(activeSessionPath, { archived: false }).then(() => undefined));
                        } else {
                          setSessionDialog("archive");
                        }
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <strong>{data.session?.archived === true ? t("恢复会话") : t("归档会话")}</strong>
                      <small>{data.session?.archived === true ? t("恢复到默认列表") : t("从默认列表隐藏")}</small>
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
                      <strong>{t("删除会话")}</strong>
                      <small>{t("永久删除本地记录")}</small>
                    </button>
                  </div>
                )}
              </div>
              <button
                aria-label={details !== undefined ? t("关闭详情") : t("打开详情")}
                aria-pressed={details !== undefined}
                className="details-toggle"
                onClick={() => setDetails(details ? undefined : {})}
                type="button"
              >
                <span aria-hidden="true">◨</span> <span className="details-toggle-label">{t("详情")}</span>
              </button>
            </>
          )}
        </header>
        {refreshIssues.length > 0 && (
          <div aria-live="polite" className="refresh-warning" role="status">
            <span>
              {/* The colon belongs to the heading key so each locale punctuates it its own way; `.refresh-warning strong` supplies the gap after it, and the failed sources are a placeholder rather than a third adjacent expression that would render with no separator at all. */}
              <strong>{t("部分数据刷新失败：")}</strong>
              {t("{v0} 可能为空或显示上次结果。", { v0: refreshIssues.join(" · ") })}
            </span>
            <button onClick={() => void refresh()} type="button">
              {t("重试")}
            </button>
          </div>
        )}
        <div className="view-host">
          {initialRefreshPending ? (
            <div aria-live="polite" className="initial-loading" role="status">
              <span aria-hidden="true"></span>
              {t("正在连接 Pi runtime…")}
            </div>
          ) : (
            content
          )}
        </div>
      </section>
      {!settings && page === "session" && details !== undefined && (
        <>
          <button aria-label={t("关闭详情")} className="details-backdrop" onClick={() => setDetails(undefined)} type="button" />
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
              : (sessionActionTarget?.name ?? value(data.session?.sessionId, t("当前会话")))
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
