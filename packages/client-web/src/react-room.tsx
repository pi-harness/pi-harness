import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createClientApi,
  failedRefreshLabels,
  type ClientApi,
  type ClientCommand,
  type ClientFile,
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
import { compactThinkingEvents } from "./runtime-events.js";
import { MarkdownMessage } from "./markdown.js";
import { messageText, projectChatTurns } from "./message-content.js";
import { formatAnnotationPrompt, parseAnnotationPrompt, type ClientAnnotation } from "./annotation-ui.js";
import { marketplaceCategoryTabs, marketplaceDetailPath, marketplaceStatisticItems, readMarketplaceDetailId } from "./marketplace-navigation.js";
import { loadMarketplaceCatalog } from "./marketplace-catalog.js";
import { pluginStarsRows } from "./plugin-stars-view.js";
import { browserSessionTabs } from "./browser-session-view.js";
import { matchesPluginQuery } from "./plugin-search.js";
import { readInstalledPluginDetailId } from "./plugin-navigation.js";
import { installedPluginCardContent } from "./plugin-card.js";

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
  marketplaceCapabilities: readonly string[];
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
const eventLabel = (event: Record<string, unknown>): string => {
  const type = value(event.type, "");
  if (type === "file_diff") return "文件差异";
  if (type === "file") return "文件详情";
  return value(event.summary ?? event.message ?? event.toolName ?? event.type ?? event.event, "未命名事件");
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
const displayPluginName = (name: string): string => {
  const officialName = new Map([
    ["@pi-harness/core/plugins/context", "Context insights"],
    ["@pi-harness/core/plugins/agent-teams", "Agent Teams"],
    ["@pi-harness/core/plugins/modlens", "ModLens vision bridge"],
    ["@pi-harness/core/plugins/token-guard", "Token Guard"],
    ["@pi-harness/core/plugins/git-time-capsule", "Git Time Capsule"],
    ["@pi-harness/core/plugins/dependency-checker", "Dependency Checker"],
    ["@pi-harness/core/plugins/at-file", "@file context"],
    ["@pi-harness/core/plugins/fail-logger", "Failure Logger"],
    ["@pi-harness/core/plugins/test-harness", "Test Harness"],
    ["@pi-harness/core/plugins/session-insights", "Session Insights"],
    ["@pi-harness/core/plugins/session-compare", "Session Compare"],
    ["@pi-harness/core/plugins/secure-audit", "Secure Audit"],
    ["@pi-harness/core/plugins/readme-gen", "README Generator"],
    ["@pi-harness/core/plugins/i18n-pair", "I18n Pair"],
    ["@pi-harness/core/plugins/cleaner", "Harness Cleaner"],
    ["@pi-harness/core/plugins/sql-lens", "SQL Lens"],
    ["@pi-harness/core/plugins/docker-sandbox", "Docker Sandbox"],
    ["@pi-harness/core/plugins/mcp-client", "MCP Client"],
    ["@pi-harness/core/plugins/mcp-panel", "MCP Console"],
    ["@pi-harness/core/plugins/browser-fetch", "Browser Fetch"],
    ["@pi-harness/core/plugins/web-research", "Web Research"],
    ["@pi-harness/core/plugins/browser-session", "Browser Session"],
    ["@pi-harness/core/plugins/yaml-validator", "YAML Validator"],
    ["@pi-harness/core/plugins/mock-server", "Mock Server"],
    ["@pi-harness/core/plugins/cli-notifier", "CLI Notifier"],
    ["@pi-harness/core/plugins/obsidian-sync", "Obsidian Sync"],
    ["@pi-harness/core/plugins/context-doctor", "Context Doctor"],
    ["@pi-harness/core/plugins/history-compressor", "History Compressor"],
    ["@pi-harness/core/plugins/reviewer-bot", "Reviewer Bot"],
    ["@pi-harness/core/plugins/auto-mode", "Auto Mode"],
    ["@pi-harness/core/plugins/plan-execute", "Plan Execute"],
    ["@pi-harness/core/plugins/plugin-finder", "Plugin Finder"],
    ["@pi-harness/core/plugins/taskboard", "Taskboard"],
    ["@pi-harness/core/plugins/synapse", "Synapse"],
    ["@pi-harness/core/plugins/hol-guard", "HOL Guard"],
    ["@pi-harness/core/plugins/plugin-radar", "Plugin Radar"],
    ["@pi-harness/core/plugins/plugin-check", "Plugin Check"],
    ["@pi-harness/core/plugins/annotation", "Annotations"],
    ["@pi-harness/core/plugins/cost-meter", "Cost Meter"],
    ["@pi-harness/core/plugins/undo-savepoint", "Undo Savepoints"],
    ["@pi-harness/core/plugins/skill-catalog", "Skills Catalog"],
    ["@pi-harness/core/plugins/memory", "Memory"],
    ["@pi-harness/core/plugins/graph-memory", "Graph Memory"],
    ["@pi-harness/core/plugins/canvas-draw", "Canvas Draw"],
    ["@pi-harness/core/plugins/image-compressor", "Image Compressor"],
    ["@pi-harness/core/plugins/workspace-search", "Workspace Search"],
    ["@pi-harness/core/plugins/prompt-guard", "Prompt Guard"],
    ["@pi-harness/core/plugins/code2skill", "Code2Skill"],
    ["@pi-harness/core/plugins/tab-manager", "Session Tabs"],
    ["@pi-harness/core/plugins/genui", "GenUI"],
    ["@pi-harness/core/plugins/anchored-standard", "Anchored Standard"],
    ["@pi-harness/core/plugins/telemetry-blocker", "Telemetry Blocker"],
    ["@pi-harness/core/plugins/change-verifier", "Change Verifier"],
    ["@pi-harness/core/plugins/plugin-dev", "Plugin Dev"],
    ["@pi-harness/core/plugins/openpets", "OpenPets"],
    ["@pi-harness/core/plugins/vision-toolkit", "Vision Toolkit"],
    ["@pi-harness/core/plugins/plugin-stars", "Plugin Stars"],
    ["@pi-harness/core/plugins/session-bridge", "Session Bridge"],
    ["@pi-harness/core/plugins/skill-guard", "Skill Guard"],
    ["@pi-harness/core/plugins/recall-unread", "Recall Unread"],
    ["@pi-harness/core/plugins/turn-rewind", "Turn Rewind"],
    ["@pi-harness/core/plugins/session-export", "Session Export"],
    ["@pi-harness/core/plugins/session-search", "Session Search"],
    ["@pi-harness/core/plugins/session-bookmarks", "Session Bookmarks"],
    ["@pi-harness/core/plugins/llm-verifier", "LLM Verifier"],
    ["@pi-harness/core/plugins/module-search", "Module Search"],
    ["@pi-harness/core/plugins/workspace-navigator", "Workspace Navigator"],
    ["@pi-harness/core/plugins/better-sidebar", "Better Sidebar"],
    ["@pi-harness/core/plugins/archify", "Architecture Map"],
    ["@pi-harness/core/plugins/mirage-bridge", "Mirage Bridge"],
    ["@pi-harness/core/plugins/theme-studio", "Theme Studio"],
    ["@pi-harness/core/plugins/reverse-skill", "Reverse Skill Firewall"],
    ["@pi-harness/core/plugins/colleague-skill", "Colleague Skill"],
    ["@pi-harness/core/plugins/prompt-library", "Prompt Library"],
    ["@pi-harness/core/plugins/runtime-doctor", "Runtime Doctor"],
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
  onRename,
  onFork,
  onArchive,
  onDelete,
}: {
  busy: boolean;
  onRename: () => void;
  onFork: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="session-row-menu-popover" onClick={(event) => event.stopPropagation()}>
      <button disabled={busy} onClick={onRename} type="button">
        重命名
      </button>
      <button disabled={busy} onClick={onFork} type="button">
        复制会话
      </button>
      <button disabled={busy} onClick={onArchive} type="button">
        归档会话
      </button>
      <button className="danger" disabled={busy} onClick={onDelete} type="button">
        删除会话
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
  const fileDetail = event.type === "file" || event.type === "file_diff";
  const stats: readonly [string, string][] = fileDetail
    ? [
        ["来源", "/api/files"],
        ["文件", value(event.path)],
      ]
    : [
        ["来源", value(event.type ?? event.source, "event")],
        ["产生者", value(event.by ?? event.source)],
        ["耗时", value(event.duration ?? event.dur)],
        ["时间", value(event.timestamp ?? event.ts ?? event.time)],
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
            <pre className="tool-output">{typeof output === "string" ? output : JSON.stringify(output, null, 2)}</pre>
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

function Trajectory({ events, onSelect }: { events: readonly Record<string, unknown>[]; onSelect: (event: Record<string, unknown>) => void }) {
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
            <span className="timeline-empty">等待真实事件…</span>
          )}
        </div>
      </div>
      <div className="source-filters">
        <button className={`filter ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")} type="button">
          全部 {events.length}
        </button>
        {[...counts].map(([type, count]) => (
          <button className={`filter ${filter === type ? "active" : ""}`} key={type} onClick={() => setFilter(type)} type="button">
            {type} {count}
          </button>
        ))}
      </div>
      <div className="event-table">
        <div className="event-head">
          <span>时间</span>
          <span>来源</span>
          <span>事件</span>
          <span>产生者</span>
          <span>耗时</span>
        </div>
        {visible.map((event, index) => (
          <button className="event-row" key={index} onClick={() => onSelect(event)} type="button">
            <span>{value(event.timestamp ?? event.ts ?? event.time)}</span>
            <span>
              <i className="event-dot"></i>
              {value(event.type, "event")}
            </span>
            <strong>{eventLabel(event)}</strong>
            <span>{value(event.by ?? event.source)}</span>
            <span>{value(event.duration ?? event.dur)}</span>
          </button>
        ))}
        {!visible.length && <div className="empty-state">暂无轨迹事件。</div>}
      </div>
    </section>
  );
}

function Files({
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
        <div className="file-summary">{`${files.length} 个文件 · ${additions} 个新增 · ${deletions} 个删除`}</div>
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

function PluginPanelCard({ panel, inline = false }: { panel: ClientPluginPanel; inline?: boolean }) {
  const data = panel.data !== null && typeof panel.data === "object" && !Array.isArray(panel.data) ? (panel.data as Record<string, unknown>) : undefined;
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
        <div className="mt-3 grid gap-3">
          <div className="grid gap-2 sm:grid-cols-3">
            {capabilities.length > 0
              ? capabilities.map((capability, index) => (
                  <span
                    className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 text-center text-[10px] text-[#3565c5]"
                    key={`${value(capability)}-${index}`}
                  >
                    {value(capability)}
                  </span>
                ))
              : null}
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              <span className="block text-[10px] text-[#687381]">成员</span>
              <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{value(Array.isArray(data?.members) ? data.members.length : 0)}</strong>
            </div>
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              <span className="block text-[10px] text-[#687381]">任务</span>
              <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{value(Array.isArray(data?.tasks) ? data.tasks.length : 0)}</strong>
            </div>
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              <span className="block text-[10px] text-[#687381]">未读消息</span>
              <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">
                {value(
                  Array.isArray(data?.messages)
                    ? data.messages.filter((message) => message !== null && typeof message === "object" && (message as Record<string, unknown>).read !== true)
                        .length
                    : 0,
                )}
              </strong>
            </div>
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              <span className="block text-[10px] text-[#687381]">可执行任务</span>
              <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">
                {value(Array.isArray(data?.readyTasks) ? data.readyTasks.length : 0)}
              </strong>
            </div>
          </div>
          {Array.isArray(data?.dependencyCycle) && data.dependencyCycle.length > 1 ? (
            <div className="rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-2 text-[11px] text-[#b42318]">
              依赖循环：{data.dependencyCycle.map((item) => value(item)).join(" → ")}
            </div>
          ) : null}
          <div className="grid gap-2">
            {Array.isArray(data?.members) && data.members.length > 0 ? (
              data.members.map((item, index) => {
                const member = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div className="flex items-center gap-3 rounded-lg border border-[#edf0f3] px-3 py-2" key={`${value(member.id ?? "member")}-${index}`}>
                    <span className="h-2 w-2 rounded-full bg-[#22c55e]"></span>
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[#30343b]">{value(member.name ?? "成员")}</span>
                    <span className="text-[10px] text-[#687381]">{value(member.role ?? "协作成员")}</span>
                    <span className="font-mono text-[10px] text-[#3565c5]">{value(member.status ?? "idle")}</span>
                  </div>
                );
              })
            ) : (
              <div className="rounded-lg bg-[#f6f8fa] px-3 py-3 text-[12px] text-[#687381]">暂无协作成员。</div>
            )}
          </div>
          <div className="grid gap-2">
            {Array.isArray(data?.tasks) && data.tasks.length > 0 ? (
              data.tasks.map((item, index) => {
                const task = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div className="flex items-center gap-3 rounded-lg border border-[#edf0f3] px-3 py-2" key={`${value(task.id ?? "task")}-${index}`}>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] text-[#30343b]">{value(task.title ?? "未命名任务")}</span>
                      {Array.isArray(task.dependsOn) && task.dependsOn.length > 0 ? (
                        <span className="mt-0.5 block truncate font-mono text-[9px] text-[#687381]">依赖：{task.dependsOn.join(", ")}</span>
                      ) : null}
                    </div>
                    <span className="text-[10px] text-[#687381]">{value(task.assignee ?? "unassigned")}</span>
                    <span
                      className={`rounded-full px-2 py-1 text-[10px] ${task.status === "blocked" ? "bg-[#fff4e5] text-[#8a5a00]" : task.status === "done" ? "bg-[#e8f8ee] text-[#14733f]" : "bg-[#edf3fe] text-[#3565c5]"}`}
                    >
                      {value(task.status ?? "todo")}
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="rounded-lg bg-[#f6f8fa] px-3 py-3 text-[12px] text-[#687381]">还没有任务。可让 Agent 使用 team_task 创建。</div>
            )}
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-[#30343b]">团队消息</span>
              <span className="font-mono text-[10px] text-[#687381]">durable mailbox</span>
            </div>
            {Array.isArray(data?.messages) && data.messages.length > 0 ? (
              Array.from(data.messages as readonly unknown[])
                .reverse()
                .slice(0, 5)
                .map((item, index) => {
                  const message = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                  return (
                    <div
                      className={`rounded-lg border px-3 py-2 ${message.read === true ? "border-[#edf0f3] bg-white" : "border-[#cfe0ff] bg-[#f4f8ff]"}`}
                      key={`${value(message.id ?? "message")}-${index}`}
                    >
                      <div className="flex items-center gap-2 text-[10px] text-[#687381]">
                        <span className="font-mono text-[#3565c5]">
                          {value(message.from ?? "unknown")} → {value(message.to ?? "unknown")}
                        </span>
                        <span className="ml-auto">{message.read === true ? "已读" : "未读"}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-[#30343b]">{value(message.body ?? "")}</p>
                    </div>
                  );
                })
            ) : (
              <div className="rounded-lg bg-[#f6f8fa] px-3 py-3 text-[12px] text-[#687381]">暂无团队消息。</div>
            )}
          </div>
        </div>
      ) : panel.id === "modlens-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className={`rounded-lg border px-3 py-3 ${data?.attached === true ? "border-[#b9e6c9] bg-[#f0fbf4]" : "border-[#e3e7ee] bg-[#f6f8fa]"}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[#30343b]">{data?.attached === true ? "图片已附加" : "等待图片"}</span>
              <span className="font-mono text-[10px] text-[#687381]">vision_inspect</span>
            </div>
            {data?.image !== null && data?.image !== undefined && typeof data.image === "object" ? (
              <p className="mt-2 truncate text-[11px] text-[#65707b]">
                {value((data.image as Record<string, unknown>).path ?? "图片")} · {value((data.image as Record<string, unknown>).bytes ?? 0)} bytes
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-[#687381]">调用 vision_inspect 并提供工作区内图片路径。</p>
            )}
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
      ) : panel.id === "at-file-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[#30343b]">最近附加</span>
              <span className="font-mono text-[10px] text-[#687381]">file_context</span>
            </div>
            {data?.lastFile !== null && data?.lastFile !== undefined && typeof data.lastFile === "object" ? (
              <p className="mt-2 truncate text-[11px] text-[#65707b]">
                {value((data.lastFile as Record<string, unknown>).path ?? "文件")} · {value((data.lastFile as Record<string, unknown>).bytes ?? 0)} bytes
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-[#687381]">还没有附加文件。可使用 @file 或让 Agent 调用 file_context。</p>
            )}
          </div>
          <div className="flex items-center justify-between text-[11px] text-[#687381]">
            <span>单文件上限</span>
            <strong className="font-mono text-[#3565c5]">{value(data?.maxBytes ?? 0)} bytes</strong>
          </div>
        </div>
      ) : panel.id === "git-time-capsule-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[#30343b]">最近快照</span>
              <span className="font-mono text-[10px] text-[#687381]">git_snapshot</span>
            </div>
            {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
              <p className="mt-2 truncate text-[11px] text-[#65707b]">
                {value((data.latest as Record<string, unknown>).name ?? "snapshot")} · {value((data.latest as Record<string, unknown>).files ?? 0)} 个文件
                {(data.latest as Record<string, unknown>).restored === true ? " · 已恢复" : ""}
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-[#687381]">还没有快照。修改代码前让 Agent 调用 git_snapshot。</p>
            )}
          </div>
          <div className="flex items-center justify-between text-[11px] text-[#687381]">
            <span>保留快照</span>
            <strong className="font-mono text-[#3565c5]">{value(Array.isArray(data?.capsules) ? data.capsules.length : 0)} / 20</strong>
          </div>
          <p className="text-[10px] leading-4 text-[#687381]">恢复会反向应用选中的 patch，必须显式传入 confirm=true。</p>
        </div>
      ) : panel.id === "dependency-checker-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const report = data?.report !== null && typeof data?.report === "object" ? (data.report as Record<string, unknown>) : {};
            const missing: unknown[] = Array.isArray(report.missing) ? report.missing : [];
            const invalid: unknown[] = Array.isArray(report.invalid) ? report.invalid : [];
            const conflicts: unknown[] = Array.isArray(report.conflicts) ? report.conflicts : [];
            return (
              <>
                <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-2 text-[10px]">
                  <span className="text-[#65707b]">清单类型</span>
                  <strong className="font-mono uppercase text-[#315fb8]">{value(report.ecosystem ?? "npm")}</strong>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["声明", report.declared ?? 0],
                    ["已安装", report.installed ?? 0],
                    ["缺失", missing.length + invalid.length],
                  ].map(([label, item]) => (
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                      <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                      <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{value(item)}</strong>
                    </div>
                  ))}
                </div>
                <div
                  className={`rounded-lg border px-3 py-3 text-[11px] ${missing.length || invalid.length || conflicts.length ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" : "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"}`}
                >
                  {missing.length || invalid.length
                    ? `缺失或无效：${[...missing, ...invalid].map((item) => value(item)).join(", ")}`
                    : "依赖声明与本地安装一致。"}
                </div>
                {conflicts.length > 0 ? (
                  <div className="rounded-lg border border-[#f3dfab] bg-[#fffaf0] px-3 py-3 text-[11px] text-[#8a6200]">
                    <strong>版本冲突</strong>
                    <ul className="mt-1 grid gap-1 pl-4">
                      {conflicts.slice(0, 6).map((item, index) => {
                        const conflict = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                        const constraints = Array.isArray(conflict.constraints) ? conflict.constraints.map((constraint) => value(constraint)).join(" · ") : "—";
                        return (
                          <li key={`${value(conflict.name ?? "dependency")}-${index}`}>
                            <code>{value(conflict.name ?? "dependency")}</code>：{constraints}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </>
            );
          })()}
        </div>
      ) : panel.id === "token-guard-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className={`rounded-lg border px-3 py-3 ${data?.exceeded === true ? "border-[#f4caca] bg-[#fff5f5]" : "border-[#e3eaf8] bg-[#f6f8ff]"}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-semibold text-[#30343b]">上下文预算</span>
                <strong className="font-mono text-[12px] text-[#315fb8]">
                  {value(data?.percent ?? "—")}% / {value(data?.maxPercent ?? "—")}%
                </strong>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#dfe8fb]">
                <div
                  className={`h-full rounded-full ${data?.exceeded === true ? "bg-[#d64545]" : "bg-[#5d8bea]"}`}
                  style={{ width: `${Math.max(0, Math.min(100, typeof data?.percent === "number" ? data.percent : 0))}%` }}
                />
              </div>
              <p className="mt-2 text-[11px] text-[#5d6d82]">
                {data?.exceeded === true ? "已达到阈值，运行会被自动停止。" : `自动停止次数：${value(data?.aborts ?? 0)}`}
              </p>
            </div>
            <div className={`rounded-lg border px-3 py-3 ${data?.runExceeded === true ? "border-[#f4caca] bg-[#fff5f5]" : "border-[#e3eaf8] bg-[#f6f8ff]"}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-semibold text-[#30343b]">单次任务</span>
                <strong className="font-mono text-[12px] text-[#315fb8]">
                  {value(data?.runTokens ?? "—")} / {value(data?.maxRunTokens || "—")}
                </strong>
              </div>
              <p className="mt-2 text-[11px] text-[#5d6d82]">{data?.maxRunTokens ? "按 agent_start 后累计 token 熔断。" : "未启用绝对 Token 上限。"}</p>
            </div>
          </div>
        </div>
      ) : panel.id === "test-harness-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const run = data.latest as Record<string, unknown>;
              return (
                <div className={`rounded-lg border px-3 py-3 ${run.exitCode === 0 ? "border-[#b9e6c9] bg-[#f0fbf4]" : "border-[#f4caca] bg-[#fff5f5]"}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[11px] font-semibold text-[#30343b]">{value(run.command ?? "npm run test")}</span>
                    <strong className={`text-[12px] ${run.exitCode === 0 ? "text-[#14733f]" : "text-[#b42318]"}`}>exit {value(run.exitCode ?? "—")}</strong>
                  </div>
                  <p className="mt-2 text-[11px] text-[#65707b]">耗时 {value(run.durationMs ?? 0)} ms</p>
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              还没有执行验证脚本。可让 Agent 调用 run_project_tests。
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {Array.isArray(data?.allowedScripts)
              ? data.allowedScripts.map((script, index) => (
                  <span
                    className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]"
                    key={`${value(script)}-${index}`}
                  >
                    {value(script)}
                  </span>
                ))
              : null}
          </div>
        </div>
      ) : panel.id === "session-insights-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const tokens = data?.tokens !== null && typeof data?.tokens === "object" ? (data.tokens as Record<string, unknown>) : {};
            const usage = data?.contextUsage !== null && typeof data?.contextUsage === "object" ? (data.contextUsage as Record<string, unknown>) : {};
            return (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["消息", data?.totalMessages ?? 0],
                    ["工具调用", data?.toolCalls ?? 0],
                    ["成本", `$${Number(data?.cost ?? 0).toFixed(4)}`],
                  ].map(([label, item]) => (
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                      <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                      <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{value(item)}</strong>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-[#30343b]">上下文</span>
                    <strong className="font-mono text-[12px] text-[#315fb8]">{value(usage.percent ?? "—")}%</strong>
                  </div>
                  <p className="mt-2 text-[11px] text-[#5d6d82]">
                    {value(tokens.total ?? 0)} tracked tokens · 输入 {value(tokens.input ?? 0)} · 输出 {value(tokens.output ?? 0)}
                  </p>
                </div>
              </>
            );
          })()}
        </div>
      ) : panel.id === "session-bridge-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const latestPreview =
              data?.latestPreview !== null && typeof data?.latestPreview === "object"
                ? ((data.latestPreview as Record<string, unknown>).preview as Record<string, unknown> | undefined)
                : undefined;
            const preview =
              latestPreview ??
              (data?.currentPreview !== null && typeof data?.currentPreview === "object" ? (data.currentPreview as Record<string, unknown>) : {});
            const sections: readonly [string, unknown][] = [
              ["目标", preview.goal],
              ["当前状态", preview.currentState],
              ["下一步", preview.nextStep],
            ];
            return (
              <>
                <div className="rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3 text-[11px] leading-5 text-[#315fb8]">
                  预览不会创建目标会话，也不会修改源会话。
                </div>
                {sections.map(([label, item]) => (
                  <div className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-3" key={label}>
                    <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[#687381]">{label}</span>
                    <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-[#30343b]">{value(item)}</p>
                  </div>
                ))}
                <div className="grid gap-2 sm:grid-cols-2">
                  {[
                    ["关键决策", preview.decisions],
                    ["关键文件", preview.keyFiles],
                  ].map(([label, items]) => (
                    <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3" key={value(label)}>
                      <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[#687381]">{value(label)}</span>
                      {Array.isArray(items) && items.length > 0 ? (
                        <ul className="mt-2 grid gap-1 text-[10px] leading-4 text-[#65707b]">
                          {items.slice(0, 8).map((item, index) => (
                            <li key={`${value(item)}-${index}`}>{value(item)}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-[10px] text-[#687381]">暂无</p>
                      )}
                    </div>
                  ))}
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
        <div className="mt-3 grid gap-3">
          <div
            className={`rounded-lg border px-3 py-3 text-[11px] ${data?.status === "warning" ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" : "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"}`}
          >
            {data?.status === "warning" ? "需要关注上下文风险。" : "上下文状态正常。"}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              ["占用", `${value(data?.usagePercent ?? "—")}%`],
              ["超大消息", data?.oversizedMessages ?? 0],
              ["工具错误", data?.toolErrors ?? 0],
            ].map(([label, item]) => (
              <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                <strong className="mt-1 block text-[17px] text-[#30343b]">{value(item)}</strong>
              </div>
            ))}
          </div>
          {Array.isArray(data?.recommendations) && data.recommendations.length > 0 ? (
            <ul className="grid gap-1 rounded-lg border border-[#e3e7ee] bg-white px-4 py-3 text-[10px] text-[#65707b]">
              {data.recommendations.slice(0, 4).map((item, index) => (
                <li key={`${value(item)}-${index}`}>{value(item)}</li>
              ))}
            </ul>
          ) : null}
        </div>
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
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px]">
            <span className="font-medium text-[#30343b]">社区排行榜</span>
            <span className="font-mono text-[#65707b]">上限 {value(data?.limit ?? "—")}</span>
          </div>
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const latest = data.latest as Record<string, unknown>;
              const entries = Array.isArray(latest.results)
                ? latest.results.flatMap((entry): Array<{ fullName: string; name: string; stars: number; htmlUrl: string; updatedAt: string }> => {
                    if (entry === null || typeof entry !== "object") return [];
                    const item = entry as Record<string, unknown>;
                    if (
                      typeof item.fullName !== "string" ||
                      typeof item.name !== "string" ||
                      typeof item.stars !== "number" ||
                      typeof item.htmlUrl !== "string" ||
                      typeof item.updatedAt !== "string"
                    )
                      return [];
                    return [{ fullName: item.fullName, name: item.name, stars: item.stars, htmlUrl: item.htmlUrl, updatedAt: item.updatedAt }];
                  })
                : [];
              const rows = pluginStarsRows(entries, 8);
              return (
                <>
                  <div className="flex items-center justify-between text-[11px] text-[#65707b]">
                    <span>查询：{value(latest.query, "全部")}</span>
                    <strong className="font-mono text-[#3565c5]">{value(latest.total ?? rows.length)} 个结果</strong>
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
                  <p className="text-[10px] leading-4 text-[#687381]">来源：{value(latest.source, "dsh-plugin-stars")} · 仅展示公开仓库信息，不会自动安装。</p>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              Agent 可调用 plugin_stars_search 拉取并筛选社区排行榜。
            </div>
          )}
        </div>
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
          const kinds = data?.kinds !== null && typeof data?.kinds === "object" ? (data.kinds as Record<string, unknown>) : {};
          const recent = Array.isArray(data?.recent) ? data.recent : [];
          const recentRelations = Array.isArray(data?.recentRelations) ? data.recentRelations : [];
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
                  {value(data?.nodes ?? 0)} 节点 · {value(data?.relations ?? 0)} 关系
                </span>
              </div>
              {recent.length > 0 ? (
                <ul className="grid gap-1.5">
                  <li className="text-[9px] uppercase tracking-[0.08em] text-[#687381]">
                    最近节点 {Math.min(recent.length, 5)} / {value(data?.nodes ?? recent.length)}
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
                    最近关系 {Math.min(recentRelations.length, 3)} / {value(data?.relations ?? recentRelations.length)}
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
          const entries = Array.isArray(data?.entries) ? data.entries : [];
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
                  ["今日", `$${Number(data?.todayCost ?? 0).toFixed(4)}`],
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
                  <span className="text-[#65707b]">每日预算</span>
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
              {entries.length > 0 ? (
                <ul className="grid gap-1.5">
                  {entries.slice(0, 5).map((entry, index) => {
                    const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
                    return (
                      <li
                        className="flex items-center justify-between rounded-lg border border-[#edf0f3] bg-white px-3 py-2 text-[10px]"
                        key={`${value(item.sessionId ?? "session")}-${index}`}
                      >
                        <span className="truncate font-mono text-[#65707b]">{value(item.sessionId ?? "未知会话")}</span>
                        <strong className="font-mono text-[#30343b]">${Number(item.cost ?? 0).toFixed(4)}</strong>
                      </li>
                    );
                  })}
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
                <span className="text-[#65707b]">GitHub DSH 生态</span>
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
                  尚未搜索插件。Agent 可调用 plugin_radar_search 从 GitHub 发现 DSH 插件。
                </div>
              )}
              <div className="text-[10px] text-[#687381]">只读 GitHub 搜索，按 Star 降序；不会安装、执行或修改第三方仓库。</div>
            </div>
          );
        })()
      ) : panel.id === "hol-guard-panel" ? (
        (() => {
          const receipts = Array.isArray(data?.receipts) ? data.receipts : [];
          const latest = data?.latest !== null && typeof data?.latest === "object" ? (data.latest as Record<string, unknown>) : undefined;
          const riskLabel = (risk: unknown): string => (risk === "blocked" ? "已阻断" : risk === "review" ? "需复核" : "安全");
          const riskClass = (risk: unknown): string =>
            risk === "blocked" ? "bg-[#fff0f0] text-[#b42318]" : risk === "review" ? "bg-[#fff7e8] text-[#a15c00]" : "bg-[#eaf8f0] text-[#14733f]";
          return (
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["已阻断", data?.blocked ?? 0],
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
              <div className="text-[10px] text-[#687381]">仅保存风险摘要和计数，不保存命令、路径或凭据原文；当前模式为审计。</div>
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
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-3 text-[11px]">
            <span className="font-medium text-[#30343b]">未回答会话</span>
            <strong className="font-mono text-[#3565c5]">{value(data?.total ?? 0)} 个</strong>
          </div>
          {Array.isArray(data?.items) && data.items.length > 0 ? (
            <div className="grid gap-2">
              {data.items.slice(0, 8).map((item, index) => {
                const session = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(session.id ?? "session")}-${index}`}>
                    <strong className="block truncate text-[11px] text-[#30343b]">{value(session.name ?? session.id ?? "未命名会话")}</strong>
                    <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-[#65707b]">{value(session.message ?? "")}</p>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">没有以未回答用户消息结束的会话。</div>
          )}
        </div>
      ) : panel.id === "turn-rewind-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const latest = data.latest as Record<string, unknown>;
              const target = latest.target !== null && typeof latest.target === "object" ? (latest.target as Record<string, unknown>) : {};
              const cancelled = latest.cancelled === true;
              return (
                <div className={`rounded-lg border px-3 py-3 ${cancelled ? "border-[#f4dfb0] bg-[#fffaf0]" : "border-[#dce5f5] bg-[#f6f8ff]"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#687381]">最近操作</span>
                    <span
                      className={`rounded-full px-2 py-1 text-[10px] font-semibold ${cancelled ? "bg-[#fff0c7] text-[#9a6700]" : "bg-[#e8f8ee] text-[#14733f]"}`}
                    >
                      {cancelled ? "已取消" : "已回退"}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-[#30343b]">{value(target.text ?? "未命名轮次")}</p>
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">还没有执行回退操作。</div>
          )}
          <div className="grid gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#687381]">可回退轮次</span>
            {(() => {
              const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
              return candidates.length > 0 ? (
                candidates.slice(-8).map((item, index) => {
                  const candidate = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                  return (
                    <div
                      className="flex items-start gap-2 rounded-lg border border-[#edf0f3] bg-white px-3 py-2"
                      key={`${value(candidate.entryId ?? "turn")}-${index}`}
                    >
                      <span className="mt-0.5 font-mono text-[10px] text-[#3565c5]">{candidates.length - index}</span>
                      <span className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-4 text-[#65707b]">{value(candidate.text ?? "未命名轮次")}</span>
                    </div>
                  );
                })
              ) : (
                <div className="rounded-lg border border-[#edf0f3] bg-white px-3 py-3 text-[11px] text-[#687381]">当前会话还没有可回退的用户轮次。</div>
              );
            })()}
          </div>
        </div>
      ) : panel.id === "skill-guard-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="grid grid-cols-3 gap-2">
            {[
              ["已扫描", data?.total ?? 0],
              ["高风险", data?.blocked ?? 0],
              ["待复核", data?.review ?? 0],
            ].map(([label, item]) => (
              <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{value(item)}</strong>
              </div>
            ))}
          </div>
          <div className="grid gap-2">
            {Array.isArray(data?.reports) && data.reports.length > 0 ? (
              data.reports.slice(0, 8).map((item, index) => {
                const report = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                const risk = report.risk;
                const findings = Array.isArray(report.findings) ? report.findings : [];
                return (
                  <div className="rounded-lg border border-[#edf0f3] bg-white px-3 py-2" key={`${value(report.name ?? "skill")}-${index}`}>
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full ${risk === "blocked" ? "bg-[#d64545]" : risk === "review" ? "bg-[#e0a11a]" : "bg-[#22a06b]"}`}
                      ></span>
                      <strong className="min-w-0 flex-1 truncate text-[11px] text-[#30343b]">{value(report.name ?? "unknown")}</strong>
                      <span className="text-[10px] text-[#687381]">{risk === "blocked" ? "阻断" : risk === "review" ? "复核" : "安全"}</span>
                    </div>
                    {findings.length > 0 ? (
                      <p className="mt-1 truncate text-[10px] text-[#65707b]">
                        {findings
                          .map((finding) =>
                            finding !== null && typeof finding === "object" ? value((finding as Record<string, unknown>).code ?? "finding") : value(finding),
                          )
                          .join(" · ")}
                      </p>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
                暂无 Skill 扫描结果，可让 Agent 调用 skill_guard_scan。
              </div>
            )}
          </div>
        </div>
      ) : panel.id === "prompt-guard-panel" ? (
        <div className="mt-3 grid gap-3">
          <div
            className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${data?.risk === "blocked" ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" : data?.risk === "review" ? "border-[#f3dfab] bg-[#fffaf0] text-[#9a6700]" : "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]"}`}
          >
            <span>{data?.risk === "blocked" ? "高风险，需阻断" : data?.risk === "review" ? "需要人工复核" : "未发现风险"}</span>
            <strong className="font-mono">{value(data?.scans ?? 0)} 次扫描</strong>
          </div>
          {data?.latest && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
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
                <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">最近一次扫描未发现风险。</div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              Agent 可调用 prompt_guard_scan 检查不可信文本。
            </div>
          )}
        </div>
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
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
              const blocks = Array.isArray(report.blocks) ? report.blocks : [];
              const toneClass: Record<string, string> = {
                neutral: "border-[#e3e7ee] bg-[#f6f8fa] text-[#65707b]",
                info: "border-[#d9e4f7] bg-[#f6f8ff] text-[#315fb8]",
                success: "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]",
                warning: "border-[#f3dfab] bg-[#fffaf0] text-[#9a6700]",
                danger: "border-[#f4caca] bg-[#fff5f5] text-[#b42318]",
              };
              return (
                <div className="grid gap-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <strong className="text-[#30343b]">{value(report.title ?? "结构化卡片")}</strong>
                    <span className="font-mono text-[#687381]">{value(data.rendered ?? 0)} 次</span>
                  </div>
                  {blocks.map((block, index) => {
                    const item = block && typeof block === "object" ? (block as Record<string, unknown>) : {};
                    const tone = value(item.tone ?? "neutral");
                    const blockValue = item.value;
                    return item.type === "progress" ? (
                      <div className={`rounded-lg border px-3 py-2 ${toneClass[tone] ?? toneClass.neutral}`} key={`${value(item.label)}-${index}`}>
                        <div className="flex items-center justify-between text-[10px]">
                          <span>{value(item.label ?? "进度")}</span>
                          <strong>{value(blockValue ?? 0)}%</strong>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/70">
                          <div className="h-full rounded-full bg-current" style={{ width: `${Math.max(0, Math.min(100, Number(blockValue) || 0))}%` }} />
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`flex items-center justify-between rounded-lg border px-3 py-2 text-[11px] ${toneClass[tone] ?? toneClass.neutral}`}
                        key={`${value(item.label)}-${index}`}
                      >
                        <span className="text-[#65707b]">{value(item.label, "")}</span>
                        <strong>{value(blockValue, "")}</strong>
                      </div>
                    );
                  })}
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              还没有结构化卡片。可让 Agent 调用 genui_render。
            </div>
          )}
          <p className="text-[10px] text-[#687381]">仅渲染结构化文本、徽标和进度块；HTML 与脚本按普通文本处理。</p>
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
          <div
            className={`flex items-center justify-between rounded-lg border px-3 py-3 text-[11px] ${data?.status === "reloaded" ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]" : data?.status === "failed" ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" : "border-[#e3e7ee] bg-[#f6f8fa] text-[#65707b]"}`}
          >
            <span>{data?.status === "reloaded" ? "插件已重载" : data?.status === "failed" ? "插件重载失败" : "等待重载"}</span>
            <strong className="font-mono">{value(data?.status ?? "idle")}</strong>
          </div>
          <p className="text-[10px] text-[#687381]">{value(data?.reason ?? "修改本地扩展后调用 plugin_dev_reload")}</p>
          {data?.error ? <p className="rounded-lg bg-[#fff5f5] px-3 py-2 text-[10px] text-[#b42318]">{value(data.error)}</p> : null}
        </div>
      ) : panel.id === "openpets-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center gap-3 rounded-lg border border-[#e3e7ee] bg-[#f8fafc] px-3 py-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#dceaff] text-[20px] text-[#3565c5]">◉</span>
            <div className="min-w-0 flex-1">
              <strong className="block truncate text-[13px] text-[#30343b]">{value(data?.name ?? "Pi")}</strong>
              <span className="text-[10px] text-[#687381]">{value(data?.lastEvent ?? "session_start")}</span>
            </div>
            <span className="rounded-full bg-[#edf3fe] px-2 py-1 text-[10px] text-[#3565c5]">{value(data?.mood ?? "idle")}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[10px] text-[#65707b]">
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              能量 <strong className="ml-1 text-[#30343b]">{value(data?.energy ?? 0)}%</strong>
            </div>
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              互动 <strong className="ml-1 text-[#30343b]">{value(data?.interactions ?? 0)}</strong>
            </div>
          </div>
          <p className="text-[10px] text-[#687381]">根据真实 Pi 会话事件自动反应，也可让 Agent 调用 pet_react 进行互动。</p>
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
        <div className="mt-3 grid gap-3">
          {data?.generated === true ? (
            <>
              <div className="rounded-lg border border-[#b9e6c9] bg-[#f0fbf4] px-3 py-3 text-[11px] text-[#14733f]">
                已生成 {value(data.name ?? "项目")} 的 README 概览：{value(data.scripts ?? 0)} 个脚本，{value(data.plugins ?? 0)} 个运行时插件。
              </div>
              {data.lastWrite && typeof data.lastWrite === "object" ? (
                <div className="rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-2 text-[11px] text-[#315fb8]">
                  已写入 {value((data.lastWrite as Record<string, unknown>).path ?? "README.generated.md")} ·{" "}
                  {value((data.lastWrite as Record<string, unknown>).bytes ?? 0)} bytes
                  {(data.lastWrite as Record<string, unknown>).overwritten === true ? " · 已覆盖" : " · 新文件"}
                </div>
              ) : null}
              <p className="text-[10px] leading-4 text-[#687381]">需要落盘时调用 readme_write，并显式传入 confirm=true；默认写入 README.generated.md。</p>
            </>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              还没有生成文档。让 Agent 调用 readme_report 获取 Markdown 草稿，或调用 readme_write 写入确认后的文件。
            </div>
          )}
        </div>
      ) : panel.id === "sql-lens-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
              const rows = Array.isArray(report.rows) ? report.rows : [];
              return (
                <>
                  <div className="flex items-center justify-between rounded-lg bg-[#f6f8fa] px-3 py-3">
                    <span className="truncate font-mono text-[11px] text-[#30343b]">{value(report.database ?? "database")}</span>
                    <strong className="font-mono text-[12px] text-[#3565c5]">{value(rows.length)} rows</strong>
                  </div>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3] bg-[#fbfcfd] p-3 text-[10px] leading-4 text-[#65707b]">
                    {JSON.stringify(rows, null, 2)}
                  </pre>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              还没有查询数据库。可让 Agent 调用 sql_readonly。
            </div>
          )}
        </div>
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
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const run = data.latest as Record<string, unknown>;
              return (
                <div className="rounded-lg border border-[#b9e6c9] bg-[#f0fbf4] px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-[11px] text-[#30343b]">{value(run.image ?? "image")}</span>
                    <strong className="font-mono text-[12px] text-[#14733f]">exit {value(run.exitCode ?? "—")}</strong>
                  </div>
                  <p className="mt-2 text-[11px] text-[#65707b]">
                    {Array.isArray(run.command) ? run.command.map((argument) => value(argument)).join(" ") : "argv"}
                  </p>
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">还没有沙箱运行。默认无网络、工作区只读。</div>
          )}
          <div className="flex flex-wrap gap-2">
            {data?.defaults !== null && typeof data?.defaults === "object"
              ? Object.entries(data.defaults as Record<string, unknown>).map(([key, entryValue]) => (
                  <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]" key={key}>
                    {key}:{value(entryValue)}
                  </span>
                ))
              : null}
          </div>
        </div>
      ) : panel.id === "yaml-validator-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const report = data.latest as Record<string, unknown>;
              const errors = Array.isArray(report.errors) ? report.errors : [];
              const warnings = Array.isArray(report.warnings) ? report.warnings : [];
              const valid = report.valid === true;
              return (
                <>
                  <div
                    className={`rounded-lg border px-3 py-3 text-[11px] ${valid ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]" : "border-[#f4caca] bg-[#fff5f5] text-[#b42318]"}`}
                  >
                    {valid ? "YAML 语法有效。" : `发现 ${errors.length} 个语法错误。`}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      ["文档", report.documents ?? 0],
                      ["错误", errors.length],
                      ["警告", warnings.length],
                    ].map(([label, entryValue]) => (
                      <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={value(label)}>
                        <span className="block text-[10px] text-[#687381]">{value(label)}</span>
                        <strong className="mt-1 block text-[17px] text-[#30343b]">{value(entryValue)}</strong>
                      </div>
                    ))}
                  </div>
                  {!valid && errors.length > 0 ? (
                    <pre className="max-h-32 overflow-auto rounded-lg border border-[#f4caca] bg-[#fffafa] p-3 text-[10px] leading-4 text-[#b42318]">
                      {errors
                        .map((error) =>
                          typeof error === "object" && error !== null
                            ? `${value((error as Record<string, unknown>).line ?? "?")}:${value((error as Record<string, unknown>).column ?? "?")} ${value((error as Record<string, unknown>).message, "")}`
                            : value(error),
                        )
                        .join("\n")}
                    </pre>
                  ) : null}
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              还没有校验 YAML。可让 Agent 调用 yaml_validate。
            </div>
          )}
          <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]">max:512KiB · read-only</span>
        </div>
      ) : panel.id === "browser-session-panel" ? (
        (() => {
          const tabs = Array.isArray(data?.tabs)
            ? browserSessionTabs(
                data.tabs.flatMap((tab): Array<{ targetId: string; title: string; url: string }> => {
                  if (tab === null || typeof tab !== "object") return [];
                  const item = tab as Record<string, unknown>;
                  return typeof item.targetId === "string" && typeof item.url === "string"
                    ? [{ targetId: item.targetId, title: typeof item.title === "string" ? item.title : "", url: item.url }]
                    : [];
                }),
                8,
              )
            : [];
          const latest =
            data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (data.latest as Record<string, unknown>) : undefined;
          const latestAction = latest?.screenshot
            ? "已截图"
            : latest?.clicked === true
              ? "已点击"
              : latest?.text
                ? "已读取"
                : latest?.status === "navigated"
                  ? "已导航"
                  : undefined;
          return (
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-[11px] text-[#30343b]">{value(data?.endpoint ?? "本地浏览器未连接")}</span>
                  <span
                    className={`rounded-full px-2 py-1 text-[10px] font-semibold ${data?.connected === true ? "bg-[#e8f8ee] text-[#14733f]" : "bg-[#fff4e5] text-[#8a5a00]"}`}
                  >
                    {data?.connected === true ? "已连接" : "未连接"}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-[#687381]">Chrome DevTools Protocol · {tabs.length} 个可调试页面</p>
                {data?.connected === false ? (
                  <p className="mt-2 text-[11px] text-[#b42318]">请使用 remote-debugging-port 启动 Chrome。{value(data.error, "")}</p>
                ) : null}
              </div>
              {latestAction ? (
                <div className="flex items-center justify-between rounded-lg border border-[#dce5f5] bg-[#f6f8ff] px-3 py-2 text-[11px]">
                  <span className="text-[#65707b]">最近动作</span>
                  <strong className="font-mono text-[#315fb8]">{latestAction}</strong>
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
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-[11px] text-[#30343b]">{value(data?.server ?? "尚未连接 MCP 服务器")}</span>
              <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-[#3565c5]">
                <span>{value(Array.isArray(data?.tools) ? data.tools.length : 0)} 工具</span>
                <span className="text-[#687381]">·</span>
                <span>{value(Array.isArray(data?.resources) ? data.resources.length : 0)} 资源</span>
                <span className="text-[#687381]">·</span>
                <span>{value(Array.isArray(data?.prompts) ? data.prompts.length : 0)} 提示</span>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-[#687381]">
              {data?.lastCall === null || data?.lastCall === undefined ? "使用 mcp_list_tools 发现 stdio 工具。" : `最近调用：${value(data.lastCall)}`}
            </p>
          </div>
          {Array.isArray(data?.tools) && data.tools.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {data.tools.slice(0, 12).map((tool, index) => {
                const item = typeof tool === "object" && tool !== null ? (tool as Record<string, unknown>) : {};
                return (
                  <span
                    className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]"
                    key={`${value(item.name ?? "tool")}-${index}`}
                  >
                    {value(item.name ?? "tool")}
                  </span>
                );
              })}
            </div>
          ) : null}
          {Array.isArray(data?.resources) && data.resources.length > 0 ? (
            <div className="grid gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#687381]">资源</span>
              <div className="flex flex-wrap gap-2">
                {data.resources.slice(0, 8).map((resource, index) => {
                  const item = typeof resource === "object" && resource !== null ? (resource as Record<string, unknown>) : {};
                  return (
                    <span
                      className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#65707b]"
                      key={`${value(item.uri ?? "resource")}-${index}`}
                    >
                      {value(item.name ?? item.uri ?? "resource")}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}
          {Array.isArray(data?.prompts) && data.prompts.length > 0 ? (
            <div className="grid gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#687381]">提示模板</span>
              <div className="flex flex-wrap gap-2">
                {data.prompts.slice(0, 8).map((prompt, index) => {
                  const item = typeof prompt === "object" && prompt !== null ? (prompt as Record<string, unknown>) : {};
                  return (
                    <span
                      className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#65707b]"
                      key={`${value(item.name ?? "prompt")}-${index}`}
                    >
                      {value(item.name ?? "prompt")}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}
          {Array.isArray(data?.servers) && data.servers.length > 0 ? (
            <div className="grid gap-2">
              {data.servers.map((server, index) => {
                const item = typeof server === "object" && server !== null ? (server as Record<string, unknown>) : {};
                return (
                  <div
                    className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-white px-3 py-2 text-[10px]"
                    key={`${value(item.id ?? "server")}-${index}`}
                  >
                    <span className="font-mono text-[#30343b]">{value(item.id ?? "server")}</span>
                    <span className="text-[#14733f]">{value(item.status ?? "unknown")}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
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
                          <span>{value(server.toolCount, "0")} 个桥接工具</span>
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
                只读读取官方 MCP bridge 状态；健康建议通过 mcp_panel 的 health 操作查看。
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
            <span className="font-mono text-[10px] text-[#687381]">{value(data?.platform ?? "unknown")}</span>
          </div>
          {Array.isArray(data?.notifications) && data.notifications.length > 0 ? (
            <div className="grid gap-2">
              {data.notifications.slice(0, 5).map((notification, index) => {
                const item = typeof notification === "object" && notification !== null ? (notification as Record<string, unknown>) : {};
                return (
                  <div className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-2 text-[10px]" key={`${value(item.time ?? "notification")}-${index}`}>
                    <strong className="block text-[#30343b]">{value(item.title ?? "Pi Harness")}</strong>
                    <span className="mt-1 block text-[#65707b]">{value(item.message, "")}</span>
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
        <div className="mt-3 grid gap-3">
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const result = data.latest as Record<string, unknown>;
              return (
                <>
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-[#f6f8fa] px-3 py-3">
                    <span className="truncate font-mono text-[11px] text-[#30343b]">{value(result.finalUrl ?? result.url ?? "page")}</span>
                    <strong className="font-mono text-[12px] text-[#14733f]">HTTP {value(result.status ?? "—")}</strong>
                  </div>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3] bg-[#fbfcfd] p-3 text-[10px] leading-4 text-[#65707b]">
                    {value(result.text, "")}
                  </pre>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              还没有抓取网页。默认阻止本地和私有网络目标。
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]">max:512KiB</span>
            <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]">scripts:disabled</span>
            <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#3565c5]">
              private:{value(data?.allowPrivate === true ? "allowed" : "blocked")}
            </span>
          </div>
        </div>
      ) : panel.id === "i18n-pair-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.report !== null && data?.report !== undefined && typeof data.report === "object" ? (
            (() => {
              const report = data.report as Record<string, unknown>;
              const missing = Array.isArray(report.missing) ? report.missing : [];
              const extra = Array.isArray(report.extra) ? report.extra : [];
              const healthy = missing.length === 0 && extra.length === 0;
              return (
                <>
                  <div
                    className={`rounded-lg border px-3 py-3 text-[11px] ${healthy ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#14733f]" : "border-[#f4caca] bg-[#fff5f5] text-[#b42318]"}`}
                  >
                    {healthy ? "语言包键完全一致。" : `缺失 ${missing.length} 个，额外 ${extra.length} 个。`}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                      <span className="block text-[10px] text-[#687381]">基准键</span>
                      <strong className="mt-1 block text-[17px] text-[#30343b]">{value(report.baseKeys ?? 0)}</strong>
                    </div>
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                      <span className="block text-[10px] text-[#687381]">目标键</span>
                      <strong className="mt-1 block text-[17px] text-[#30343b]">{value(report.targetKeys ?? 0)}</strong>
                    </div>
                  </div>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#687381]">
              还没有检查语言包。可让 Agent 调用 i18n_check。
            </div>
          )}
        </div>
      ) : panel.id === "cleaner-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[#30343b]">快照清理</span>
              <strong className="font-mono text-[12px] text-[#3565c5]">{value(Array.isArray(data?.capsules) ? data.capsules.length : 0)} 个</strong>
            </div>
            <p className="mt-2 text-[11px] text-[#687381]">仅清理 agent 数据目录中的 .patch 快照，必须显式 confirm=true。</p>
          </div>
          <div className="flex items-center justify-between text-[11px] text-[#687381]">
            <span>上次清理</span>
            <strong className="font-mono text-[#3565c5]">{value(data?.lastRemoved ?? 0)} 个</strong>
          </div>
        </div>
      ) : panel.id === "fail-logger-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg bg-[#fff5f5] px-3 py-3">
            <span className="text-[11px] font-semibold text-[#7f1d1d]">去重后的失败记录</span>
            <strong className="font-mono text-[17px] text-[#b42318]">{value(data?.total ?? 0)}</strong>
          </div>
          <div className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3]">
            {Array.isArray(data?.failures) && data.failures.length > 0 ? (
              data.failures.map((item, index) => {
                const failure = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div
                    className="grid grid-cols-[auto_1fr] gap-2 border-b border-[#edf0f3] px-3 py-2 last:border-b-0"
                    key={`${value(failure.time ?? "failure")}-${index}`}
                  >
                    <span className="font-mono text-[10px] text-[#b42318]">{value(failure.source ?? "runtime")}</span>
                    <span className="break-words text-[11px] leading-4 text-[#65707b]">{value(failure.message ?? "未知错误")}</span>
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-4 text-[12px] text-[#687381]">暂无失败记录。</div>
            )}
          </div>
        </div>
      ) : panel.id === "context-insight-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#5d6d82]">上下文占用</span>
              <strong className="text-[13px] font-semibold text-[#315fb8]">
                {data?.percent === null || data?.percent === undefined ? "—" : `${value(data.percent)}%`}
              </strong>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#dfe8fb]">
              <div
                className="h-full rounded-full bg-[#5d8bea] transition-[width] duration-300"
                style={{ width: `${Math.max(0, Math.min(100, typeof data?.percent === "number" ? data.percent : 0))}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-[#5d6d82]">
              {data?.tokens === null || data?.tokens === undefined ? "令牌数未知" : `${value(data.tokens)} tokens`}
              {data?.contextWindow === null || data?.contextWindow === undefined ? "" : ` / ${value(data.contextWindow)} 上限`}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              ["消息", data?.messages ?? 0],
              ["事件", data?.events ?? 0],
              ["压缩", data?.compactions ?? 0],
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
              <span className="text-[10px] text-[#687381]">按角色统计</span>
            </div>
            <div className="mt-2 grid grid-cols-5 gap-1.5">
              {[
                ["用户", (data?.composition as Record<string, unknown> | undefined)?.user ?? 0],
                ["助手", (data?.composition as Record<string, unknown> | undefined)?.assistant ?? 0],
                ["工具", (data?.composition as Record<string, unknown> | undefined)?.toolResult ?? 0],
                ["系统", (data?.composition as Record<string, unknown> | undefined)?.system ?? 0],
                ["其他", (data?.composition as Record<string, unknown> | undefined)?.other ?? 0],
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
              <span className="text-[10px] text-[#687381]">最多保留 50 条</span>
            </div>
            <div className="mt-2 max-h-28 overflow-auto">
              {Array.isArray(data?.recentEvents) && data.recentEvents.length > 0 ? (
                data.recentEvents
                  .slice(-6)
                  .reverse()
                  .map((item, index) => {
                    const event = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                    return (
                      <div
                        className="flex items-center justify-between border-b border-[#f0f2f5] py-1.5 last:border-b-0"
                        key={`${value(event.type)}-${value(event.at)}-${index}`}
                      >
                        <span className="font-mono text-[10px] text-[#5d6d82]">{value(event.type, "unknown")}</span>
                        <span className="text-[10px] text-[#687381]">{typeof event.at === "number" ? new Date(event.at).toLocaleTimeString() : "—"}</span>
                      </div>
                    );
                  })
              ) : (
                <div className="py-2 text-[11px] text-[#687381]">暂无上下文事件。</div>
              )}
            </div>
          </div>
        </div>
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
            {error}
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
  onMarketplace,
  onOpenDetail,
  onToml,
  onToggle,
  onUninstall,
}: {
  plugins: readonly ClientPlugin[];
  panels: readonly ClientPluginPanel[];
  catalog: readonly ClientMarketplacePlugin[];
  onMarketplace: () => void;
  onOpenDetail: (plugin: ClientPlugin) => void;
  onToml: () => void;
  onToggle: (plugin: ClientPlugin) => Promise<void>;
  onUninstall: (plugin: ClientPlugin) => Promise<void>;
}) {
  const catalogByPackage = useMemo(() => new Map(catalog.map((plugin) => [plugin.packageName, plugin])), [catalog]);
  const panelPluginIds = useMemo(() => new Set(panels.map((panel) => panel.pluginId)), [panels]);
  const installedPlugins = useMemo(() => plugins.filter((plugin) => plugin.removable || panelPluginIds.has(plugin.name)), [panelPluginIds, plugins]);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [busyPlugin, setBusyPlugin] = useState<string>();
  const [pluginError, setPluginError] = useState("");
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
        ...(metadata?.capabilities ?? []),
        plugin.category?.label,
        capability(plugin.name),
      ];
      return matchesPluginQuery(query, fields);
    });
  }, [catalogByPackage, categoryFilter, installedPlugins, query]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [categoryFilter, query]);
  useEffect(() => {
    if (categoryFilter && !installedCategories.some((category) => category.id === categoryFilter)) setCategoryFilter("");
  }, [categoryFilter, installedCategories]);
  const runPluginAction = async (plugin: ClientPlugin, action: (plugin: ClientPlugin) => Promise<void>): Promise<boolean> => {
    setPluginError("");
    setBusyPlugin(plugin.id);
    try {
      await action(plugin);
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
          <span>已安装插件</span>
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
              const capabilityLabel = capability(plugin.name);
              const pluginTitle = metadata?.name ?? displayPluginName(plugin.name);
              const cardContent = installedPluginCardContent(plugin, metadata);
              return (
                <article className="catalog-card plugin-card" key={plugin.id}>
                  <div className="plugin-card-head">
                    <span className="plugin-icon">◈</span>
                    <div className="plugin-copy">
                      <div className="plugin-heading">
                        <div className="plugin-title">
                          <strong>{pluginTitle}</strong>
                          <span className={`plugin-state ${plugin.enabled ? "active" : ""}`}>{plugin.enabled ? "运行中" : "已停用"}</span>
                          {categoryLabel && <span className="capability">{categoryLabel}</span>}
                          {categoryLabel !== capabilityLabel && <span className="capability">{capabilityLabel}</span>}
                        </div>
                        <div className="plugin-actions">
                          {plugin.removable ? (
                            <>
                              <button
                                aria-label={`${plugin.enabled ? "停用" : "启用"} ${pluginTitle}`}
                                aria-pressed={plugin.enabled}
                                className="plugin-switch-button"
                                disabled={busyPlugin !== undefined}
                                onClick={() => void runPluginAction(plugin, (item) => onToggle(item))}
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
          {pluginError && <p className="plugin-action-error">{pluginError}</p>}
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
  onBack,
  onToggle,
  onUninstall,
}: {
  plugin: ClientPlugin;
  panel?: ClientPluginPanel;
  metadata?: ClientMarketplacePlugin;
  onBack: () => void;
  onToggle: (plugin: ClientPlugin) => Promise<void>;
  onUninstall: (plugin: ClientPlugin) => Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<"toggle" | "uninstall">();
  const [error, setError] = useState("");
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const title = metadata?.name ?? displayPluginName(plugin.name);
  const run = async (action: "toggle" | "uninstall", callback: () => Promise<void>) => {
    setError("");
    setBusyAction(action);
    try {
      await callback();
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
                    disabled={busyAction !== undefined}
                    onClick={() => void run("toggle", () => onToggle(plugin))}
                    type="button"
                  >
                    {busyAction === "toggle" ? "处理中…" : plugin.enabled ? "停用插件" : "启用插件"}
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
                操作失败：{error}
              </p>
            )}
          </header>
          <div className="grid gap-4 py-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-4">
              <section className="rounded-[10px] border border-[#e3e7ee] bg-white p-5">
                <h2 className="text-[13px] font-semibold text-[#20252b]">插件能力</h2>
                <div className="mt-4 flex flex-wrap gap-2">
                  {(metadata?.capabilities.length ? metadata.capabilities : [capability(plugin.name)]).map((item) => (
                    <span className="rounded-md bg-[#f1f4f9] px-2 py-1 font-mono text-[11px] text-[#61666b]" key={item}>
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
                  <dd className="font-mono text-[#3b424b]">{plugin.state}</dd>
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

function Marketplace({
  plugins,
  capabilities,
  categories,
  total,
  page,
  hasNext,
  query,
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
  onInstall,
}: {
  plugins: readonly ClientMarketplacePlugin[];
  capabilities: readonly string[];
  categories: readonly ClientMarketplaceCategory[];
  total: number;
  page: number;
  hasNext: boolean;
  query: string;
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
  onInstall: (plugin: ClientMarketplacePlugin) => Promise<{ restartRequired?: boolean }>;
}) {
  const [installing, setInstalling] = useState<string>();
  const [installError, setInstallError] = useState("");
  const [installNotice, setInstallNotice] = useState("");
  const categoryTabs = useMemo(() => marketplaceCategoryTabs(categories), [categories]);
  const install = async (plugin: ClientMarketplacePlugin) => {
    setInstallError("");
    setInstallNotice("");
    setInstalling(plugin.id);
    try {
      const result = await onInstall(plugin);
      if (result.restartRequired === true) setInstallNotice("已写入 profile，重启 Pi Harness 后生效。");
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
          <span>已审核插件目录</span>
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
            placeholder="搜索名称、包名、能力…"
            value={query}
          />
          <select className="marketplace-filter" aria-label="按能力筛选" onChange={(event) => onCapabilityChange(event.target.value)} value={capabilityFilter}>
            <option value="">全部能力</option>
            {capabilities.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <span className="marketplace-count">{total} 个已审核条目 · 推荐排序</span>
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
                      <span className="rounded bg-[#f1f4f9] px-1.5 py-px font-mono text-[10px] text-[#61666b]" key={item}>
                        {item}
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
                  <button disabled={installedPackages.has(plugin.packageName) || installing !== undefined} onClick={() => void install(plugin)} type="button">
                    {installedPackages.has(plugin.packageName) ? "已安装" : installing === plugin.id ? "安装中…" : "安装"}
                  </button>
                </footer>
              </article>
            ))}
            {!plugins.length && <div className="empty-state">没有匹配的插件。</div>}
          </div>
          {installNotice && <p className="mt-2 text-[11px] text-[#3565c5]">{installNotice}</p>}
          {installError && <p className="mt-2 text-[11px] text-[#b42318]">安装失败：{installError}</p>}
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
  onInstall,
  onBack,
}: {
  plugin: ClientMarketplacePlugin;
  installed: boolean;
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
      if (result.restartRequired === true) setNotice("已写入 profile，重启 Pi Harness 后生效。");
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
                <button className="plugin-detail-action primary" disabled={installed || busy} onClick={() => void install()} type="button">
                  {installed ? "已安装" : busy ? "安装中…" : "安装插件"}
                </button>
              </div>
            </div>
            <p className="mt-5 max-w-3xl text-[14px] leading-7 text-[#59636e]">{plugin.description}</p>
            {notice && <p className="mt-3 text-[12px] text-[#3565c5]">{notice}</p>}
            {error && <p className="mt-3 text-[12px] text-[#b42318]">安装失败：{error}</p>}
          </header>
          <div className="grid gap-4 py-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-4">
              <section className="rounded-[10px] border border-[#e3e7ee] bg-white p-5">
                <h2 className="text-[13px] font-semibold text-[#20252b]">插件能力</h2>
                <div className="mt-4 flex flex-wrap gap-2">
                  {plugin.capabilities.map((item) => (
                    <span className="rounded-md bg-[#f1f4f9] px-2 py-1 font-mono text-[11px] text-[#61666b]" key={item}>
                      {item}
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
                      setConfigBusy(true);
                      setConfigState("重载中…");
                      void api
                        .reloadConfig()
                        .then(setConfig)
                        .then(() => setConfigState("已从磁盘重载"))
                        .catch((cause: unknown) => setConfigState(cause instanceof Error ? cause.message : String(cause)))
                        .finally(() => setConfigBusy(false));
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

function CommandPalette({
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
          <div className="empty-state">{commands.length ? "没有匹配的命令。" : "当前运行时没有可用的命令注册清单。"}</div>
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
    <div aria-label={kind === "command" ? "命令补全" : "文件补全"} className="prompt-completion" id="prompt-completion-list" role="listbox">
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
  const [sessionToolsOpen, setSessionToolsOpen] = useState(false);
  const [sessionSelectionMode, setSessionSelectionMode] = useState(false);
  const [sessionDialog, setSessionDialog] = useState<"rename" | "delete" | "archive" | "batch-delete">();
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
  const [permission, setPermission] = useState(true);
  const [contextExpanded, setContextExpanded] = useState(false);
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
  const [streamingAssistant, setStreamingAssistant] = useState<{ thinking: string; text: string }>();
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const refreshQueuedRef = useRef(false);
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
  const installedPackages = useMemo(() => new Set(data.plugins.filter((plugin) => plugin.removable).map((plugin) => plugin.name)), [data.plugins]);
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
    if (marketplacePluginId === undefined) {
      setMarketplaceDetail(undefined);
      setMarketplaceDetailPending(false);
      setMarketplaceDetailError("");
      return;
    }
    const visible = data.marketplace.find((plugin) => plugin.id === marketplacePluginId);
    if (visible !== undefined) {
      setMarketplaceDetail(visible);
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
  }, [api, data.marketplace, marketplacePluginId]);
  useEffect(() => {
    if (installedPluginId === undefined) {
      setInstalledPluginMetadata(undefined);
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
  }, [api, installedPluginId]);
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
      scheduleRefresh();
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
    void refresh();
    const unsubscribe = api.subscribeEvents(handleRuntimeEvent);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      if (refreshTimerRef.current !== undefined) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = undefined;
      }
    };
  }, [api, handleRuntimeEvent, refresh]);
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
  }, [commandOpen, details, globalSearchOpen, sessionDialog]);
  const events = data.session?.events ?? [];
  const displayEvents = useMemo(() => compactThinkingEvents(events), [events]);
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const element = chatScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data.session?.messages.length, data.status?.events, pendingPrompt, promptBusy]);
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
  const captureAnnotationSelection = () => {
    window.requestAnimationFrame(() => {
      const selected = window.getSelection()?.toString().trim() ?? "";
      if (selected.length > 0) setAnnotationSelection(selected.slice(0, 4_000));
    });
  };
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
      setSessionToolsOpen(false);
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
  const openSessionMenu = (path: string, name?: string) => {
    setSessionToolsOpen(false);
    setSelectedSessionPath(path);
    setSessionNameDraft(name ?? "");
    setSessionMenuPath(path);
    setSessionMenuOpen(true);
  };
  const closeSessionMenu = () => {
    setSessionMenuOpen(false);
    setSessionMenuPath(undefined);
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
      onBack={() => pushInstalledPluginRoute(undefined)}
      onToggle={async (plugin) => {
        await api.togglePlugin(plugin.id, !plugin.enabled);
        await refresh();
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
        await api.togglePlugin(plugin.id, !plugin.enabled);
        await refresh();
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
        installed={installedPackages.has(marketplaceDetail.packageName)}
        onBack={() => pushMarketplacePluginRoute(undefined)}
        onInstall={async (plugin) => {
          const result = await api.installMarketplace(plugin.id);
          await refresh();
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
        onInstall={async (plugin) => {
          const result = await api.installMarketplace(plugin.id);
          await refresh();
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
          projectChatTurns(data.session.messages).map((turn, index) => {
            return (
              <article className={`turn ${turn.role === "user" ? "user" : "text"}`} key={index}>
                {turn.role === "user" ? (
                  <UserMessageBubble text={turn.text} />
                ) : (
                  <>
                    {turn.thinking && (
                      <details className="reasoning message-reasoning">
                        <summary className="reasoning-head">思考</summary>
                        <div className="reasoning-body">
                          <MarkdownMessage text={turn.thinking} />
                        </div>
                      </details>
                    )}
                    {turn.text && <MarkdownMessage onMouseUp={captureAnnotationSelection} text={turn.text} />}
                  </>
                )}
              </article>
            );
          })
        ) : (
          <Workspace
            status={data.status}
            workspaces={data.workspaces}
            onCreate={(workspace) => void createNewSession(workspace)}
            onStarter={setDraft}
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
            <button aria-expanded={contextExpanded} onClick={() => setContextExpanded((current) => !current)} type="button">
              {contextExpanded ? "收起" : "展开"}
            </button>
          </div>
          {contextExpanded && (
            <div className="context-breakdown" role="status">
              <span>
                消息 <b>{data.status?.messages ?? 0}</b>
              </span>
              <span>
                运行时事件 <b>{data.status?.events ?? events.length}</b>
              </span>
              <span>
                模型 <b>{value(data.status?.model)}</b>
              </span>
            </div>
          )}
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
              placeholder={workspaceReady ? "描述要做的改动，⌘↵ 发送；@ 引用文件，/ 调用命令" : "先选择工作区，再描述要做的改动"}
              readOnly={!workspaceReady}
              ref={promptInputRef}
              rows={2}
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
              <button className="tool-chip" onClick={() => setPermission((current) => !current)} type="button">
                ● {permission ? "改动前询问" : "自动允许"}
              </button>
              <button className="tool-chip" onClick={openCommandCompletion} type="button">
                ／ 命令
              </button>
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
    <Trajectory events={displayEvents} onSelect={setDetails} />
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
  const useCommand = (value: string) => {
    setDraft(value);
    setCommandOpen(false);
    setCommandQuery("");
  };
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
          <div className="session-search">
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
                  useCommand(`/${visibleCommands[commandIndex]?.invocationName ?? ""}`);
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
                onUse={useCommand}
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
            <div className="session-tools-wrap">
              <button
                aria-expanded={sessionToolsOpen}
                aria-label="会话工具"
                className="session-tool-button icon"
                onClick={() => {
                  closeSessionMenu();
                  setSessionToolsOpen((current) => !current);
                }}
                type="button"
              >
                ⋯
              </button>
              {sessionToolsOpen && (
                <div className="session-tools-popover">
                  <button onClick={() => window.location.reload()} type="button">
                    刷新列表
                  </button>
                  <button onClick={() => importInputRef.current?.click()} type="button">
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
                    type="button"
                  >
                    导出当前会话
                  </button>
                  <button
                    onClick={() => {
                      setIncludeArchivedSessions((current) => !current);
                      setSessionToolsOpen(false);
                      void refresh();
                    }}
                    type="button"
                  >
                    {includeArchivedSessions ? "隐藏归档会话" : "显示归档会话"}
                  </button>
                </div>
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
                    aria-label="当前会话操作"
                    className="session-row-more"
                    onClick={() => openSessionMenu(activeSessionPath, data.session?.messages.length ? data.session?.sessionId.slice(0, 12) : "新会话")}
                    type="button"
                  >
                    ⋯
                  </button>
                )}
                {!sessionSelectionMode && activeSessionPath && sessionMenuPath === activeSessionPath && sessionMenuOpen && (
                  <SessionActionMenu
                    busy={sessionActionBusy}
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
                        aria-label={`会话操作 ${value(session.name ?? session.firstMessage, "未命名会话")}`}
                        className="session-row-more"
                        onClick={(event) => {
                          event.stopPropagation();
                          openSessionMenu(session.path as string, value(session.name ?? session.firstMessage, ""));
                        }}
                        type="button"
                      >
                        ⋯
                      </button>
                    )}
                    {!sessionSelectionMode && typeof session.path === "string" && sessionMenuPath === session.path && sessionMenuOpen && (
                      <SessionActionMenu
                        busy={sessionActionBusy}
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
        <header className="main-header">
          <div className="active-heading">
            <strong>
              {settings
                ? "设置"
                : page === "plugins"
                  ? installedPluginId
                    ? "插件详情"
                    : "运行时插件"
                  : page === "marketplace"
                    ? marketplacePluginId
                      ? "插件详情"
                      : "插件市场"
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
                    : "已安装插件"
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
              <button
                className="stop-button"
                onClick={() => {
                  setPromptError("");
                  void api
                    .abort()
                    .then(refresh)
                    .catch((cause: unknown) => setPromptError(cause instanceof Error ? cause.message : String(cause)));
                }}
                type="button"
              >
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
              <button
                className="session-menu"
                onClick={() => {
                  setSessionMenuPath(undefined);
                  setSessionMenuOpen((current) => !current);
                }}
                type="button"
                aria-label="会话操作"
              >
                ⋯
              </button>
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
          {!settings && page === "session" && sessionMenuOpen && !sessionMenuPath && (
            <div className="session-menu-popover compact-session-menu">
              <button
                className="session-action"
                disabled={!activeSessionPath || sessionActionBusy}
                onClick={() => {
                  setSessionNameDraft(data.session?.sessionId?.slice(0, 12) ?? "");
                  setSessionDialog("rename");
                  setSessionMenuOpen(false);
                }}
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
                type="button"
              >
                <strong>删除会话</strong>
                <small>永久删除本地记录</small>
              </button>
            </div>
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
          onUse={setDraft}
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
          name={sessionDialog === "rename" ? undefined : value(data.session?.sessionId, "当前会话")}
          onChange={setSessionNameDraft}
          onClose={() => setSessionDialog(undefined)}
          onConfirm={() => {
            if (sessionDialog === "rename" && activeSessionPath) {
              void sessionAction(() => api.renameSession(activeSessionPath, sessionNameDraft.trim()).then(() => undefined));
            } else if (sessionDialog === "archive" && activeSessionPath) {
              void sessionAction(async () => {
                await api.setSessionMetadata(activeSessionPath, { archived: true });
              });
            } else if (sessionDialog === "delete" && activeSessionPath) {
              void sessionAction(async () => {
                await api.deleteSession(activeSessionPath);
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
