import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createClientApi,
  type ClientApi,
  type ClientCommand,
  type ClientFile,
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
const sessionSource = (status: ClientStatus | undefined, session: ClientSession | undefined): string =>
  status?.cwd ?? (typeof session?.sessionFile === "string" ? session.sessionFile : "未选择工作区");
const eventLabel = (event: Record<string, unknown>): string =>
  value(event.summary ?? event.message ?? event.toolName ?? event.type ?? event.event, "未命名事件");
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
    ["readme-gen", "文档生成"],
    ["i18n-pair", "国际化"],
    ["cleaner", "清理"],
    ["sql-lens", "数据库"],
    ["docker-sandbox", "沙箱"],
    ["mcp-client", "工具协议"],
    ["browser-fetch", "网页抓取"],
    ["browser-session", "浏览器会话"],
    ["yaml-validator", "配置校验"],
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
    ["@pi-harness/core/plugins/readme-gen", "README Generator"],
    ["@pi-harness/core/plugins/i18n-pair", "I18n Pair"],
    ["@pi-harness/core/plugins/cleaner", "Harness Cleaner"],
    ["@pi-harness/core/plugins/sql-lens", "SQL Lens"],
    ["@pi-harness/core/plugins/docker-sandbox", "Docker Sandbox"],
    ["@pi-harness/core/plugins/mcp-client", "MCP Client"],
    ["@pi-harness/core/plugins/browser-fetch", "Browser Fetch"],
    ["@pi-harness/core/plugins/browser-session", "Browser Session"],
    ["@pi-harness/core/plugins/yaml-validator", "YAML Validator"],
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
  marketplacePage: number;
} => {
  if (typeof window === "undefined") return { page: "session", view: "chat", marketplaceQuery: "", marketplaceCapability: "", marketplacePage: 0 };
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
  return (
    <div className="workspace-chooser" onClick={onClose}>
      <div aria-label="选择工作区" className="workspace-chooser-dialog" onClick={(event) => event.stopPropagation()} role="dialog">
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
        <button className="workspace-pick-directory" onClick={() => void onPickDirectory()} type="button">
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
  return (
    <div className="session-dialog-backdrop" onClick={onClose}>
      <div aria-label={title} aria-modal="true" className="session-dialog" onClick={(event) => event.stopPropagation()} role="dialog">
        <header className="session-dialog-header">
          <div>
            <strong>{title}</strong>
            <small>{description}</small>
          </div>
          <button aria-label="关闭" onClick={onClose} type="button">
            ×
          </button>
        </header>
        {kind === "rename" && (
          <label className="session-dialog-field">
            <span>名称</span>
            <input autoFocus onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onConfirm()} value={draft} />
          </label>
        )}
        {name && kind !== "rename" && <div className="session-dialog-target">{name}</div>}
        <footer className="session-dialog-actions">
          <button onClick={onClose} type="button">
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
  const stats: readonly [string, string][] = [
    ["来源", value(event.type ?? event.source, "event")],
    ["产生者", value(event.by ?? event.source)],
    ["耗时", value(event.duration ?? event.dur)],
    ["时间", value(event.timestamp ?? event.ts ?? event.time)],
  ];
  return (
    <aside className="details-panel">
      <header>
        <strong>{eventLabel(event)}</strong>
        <button aria-label="关闭事件详情" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <div className="details-body">
        <div className="detail-stats">
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
          <small>经过的插件</small>
          <div className="detail-plugin">Runtime loader · event</div>
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

function Files({ files, api, onDiff, onRefresh }: { files: readonly ClientFile[]; api: ClientApi; onDiff: (path: string) => void; onRefresh: () => void }) {
  const additions = files.filter((file) => file.status.includes("A") || file.status === "??").length;
  const deletions = files.filter((file) => file.status.includes("D")).length;
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
    if (!files.length || busy || !window.confirm("撤销这些未提交改动？此操作不可恢复。")) return;
    setBusy(true);
    setError("");
    void api
      .revertFiles(files.map((file) => file.path))
      .then(onRefresh)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="view-panel files-view">
      <div className="files-content">
        <div className="files-title">
          <strong>本次会话改动</strong>
          <span>由 /api/files 提供</span>
        </div>
        <div className="file-summary">
          {files.length} 个文件 · {additions} 个新增 · {deletions} 个删除
        </div>
        <div className="file-list">
          {files.length ? (
            files.map((file) => (
              <div className="file-row" key={file.path}>
                <b className={`file-kind ${file.label === "untracked" ? "new" : ""}`}>{file.label}</b>
                <code>{file.path}</code>
                <span className={file.status.includes("D") ? "del" : "add"}>{file.status}</span>
                <button className="diff-button" onClick={() => onDiff(file.path)} type="button">
                  查看差异
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
            <button disabled={busy} onClick={revert} type="button">
              全部撤销
            </button>
          </div>
        )}
        {error && <p className="action-error">{error}</p>}
      </div>
    </section>
  );
}

function pluginPanelValue(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function PluginPanelCard({ panel, inline = false }: { panel: ClientPluginPanel; inline?: boolean }) {
  const data = panel.data !== null && typeof panel.data === "object" && !Array.isArray(panel.data) ? (panel.data as Record<string, unknown>) : undefined;
  const entries = data ? Object.entries(data) : [["内容", panel.data] as const];
  const items = data && Array.isArray(data.items) ? data.items : [];
  const pluginEntries = data && Array.isArray(data.entries) ? data.entries : [];
  const capabilities = data && Array.isArray(data.capabilities) ? data.capabilities : [];
  return (
    <div className={inline ? "pt-1" : "rounded-[14px] border border-[#e3e7ee] bg-white p-4 shadow-[0_8px_24px_rgba(27,39,64,0.04)]"}>
      <header className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#edf3fe] font-mono text-[15px] text-[#4176e6]">
          {panel.icon ?? "◈"}
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-[13px] font-semibold text-[#20252b]">{panel.title}</strong>
          <p className="mt-1 text-[11px] leading-4 text-[#8a949f]">{panel.description ?? panel.pluginId.replace(/cordis/gi, "runtime")}</p>
        </div>
      </header>
      {panel.error ? (
        <div className="mt-3 rounded-lg border border-[#f4caca] bg-[#fff5f5] px-3 py-2 text-[12px] text-[#b42318]">{panel.error}</div>
      ) : panel.id === "console-logger-panel" ? (
        <div className="mt-3 grid gap-2">
          <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
            <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-[#8a949f]">最近日志</span>
            <strong className="mt-1 block text-[20px] font-semibold text-[#20252b]">{String(data?.total ?? 0)}</strong>
          </div>
          <div className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3]">
            {items.length ? (
              items.map((item, index) => {
                const message = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div
                    className="grid grid-cols-[auto_1fr] gap-2 border-b border-[#edf0f3] px-3 py-2 last:border-b-0"
                    key={`${String(message.time ?? "log")}-${index}`}
                  >
                    <span className="font-mono text-[10px] text-[#8a949f]">{String(message.level ?? "log")}</span>
                    <div className="min-w-0">
                      <strong className="block truncate text-[11px] text-[#30343b]">{String(message.source ?? "runtime")}</strong>
                      <span className="block whitespace-pre-wrap break-words text-[11px] leading-4 text-[#65707b]">{pluginPanelValue(message.args ?? "")}</span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-4 text-[12px] text-[#8a949f]">暂无日志输出。</div>
            )}
          </div>
        </div>
      ) : panel.id === "plugin-group-panel" ? (
        <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-[#edf0f3]">
          {pluginEntries.length ? (
            pluginEntries.map((item, index) => {
              const entry = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
              return (
                <div className="flex items-center gap-3 border-b border-[#edf0f3] px-3 py-2 last:border-b-0" key={`${String(entry.id ?? "plugin")}-${index}`}>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${entry.enabled === false ? "bg-[#a0a8b2]" : "bg-[#22c55e]"}`}></span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#30343b]">{String(entry.name ?? "plugin")}</span>
                  <span className="text-[10px] text-[#8a949f]">{String(entry.state ?? "unknown")}</span>
                </div>
              );
            })
          ) : (
            <div className="px-3 py-4 text-[12px] text-[#8a949f]">暂无插件条目。</div>
          )}
        </div>
      ) : panel.id === "timer-service-panel" ? (
        <div className="mt-3 grid gap-3 rounded-lg bg-[#f6f8fa] px-3 py-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#8a949f]">服务状态</span>
            <span
              className={`rounded-full px-2 py-1 text-[10px] font-semibold ${data?.registered === true ? "bg-[#e8f8ee] text-[#198754]" : "bg-[#fff4e5] text-[#b26a00]"}`}
            >
              {data?.registered === true ? "已注册" : "未注册"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {capabilities.map((capability, index) => (
              <span
                className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#4176e6]"
                key={`${String(capability)}-${index}`}
              >
                {String(capability)}
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
                    className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 text-center text-[10px] text-[#4176e6]"
                    key={`${String(capability)}-${index}`}
                  >
                    {String(capability)}
                  </span>
                ))
              : null}
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              <span className="block text-[10px] text-[#8a949f]">成员</span>
              <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{String(Array.isArray(data?.members) ? data.members.length : 0)}</strong>
            </div>
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
              <span className="block text-[10px] text-[#8a949f]">任务</span>
              <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{String(Array.isArray(data?.tasks) ? data.tasks.length : 0)}</strong>
            </div>
          </div>
          <div className="grid gap-2">
            {Array.isArray(data?.members) && data.members.length > 0 ? (
              data.members.map((item, index) => {
                const member = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div className="flex items-center gap-3 rounded-lg border border-[#edf0f3] px-3 py-2" key={`${String(member.id ?? "member")}-${index}`}>
                    <span className="h-2 w-2 rounded-full bg-[#22c55e]"></span>
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[#30343b]">{String(member.name ?? "成员")}</span>
                    <span className="text-[10px] text-[#8a949f]">{String(member.role ?? "协作成员")}</span>
                    <span className="font-mono text-[10px] text-[#4176e6]">{String(member.status ?? "idle")}</span>
                  </div>
                );
              })
            ) : (
              <div className="rounded-lg bg-[#f6f8fa] px-3 py-3 text-[12px] text-[#8a949f]">暂无协作成员。</div>
            )}
          </div>
          <div className="grid gap-2">
            {Array.isArray(data?.tasks) && data.tasks.length > 0 ? (
              data.tasks.map((item, index) => {
                const task = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div className="flex items-center gap-3 rounded-lg border border-[#edf0f3] px-3 py-2" key={`${String(task.id ?? "task")}-${index}`}>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[#30343b]">{String(task.title ?? "未命名任务")}</span>
                    <span className="text-[10px] text-[#8a949f]">{String(task.assignee ?? "unassigned")}</span>
                    <span className="rounded-full bg-[#edf3fe] px-2 py-1 text-[10px] text-[#4176e6]">{String(task.status ?? "todo")}</span>
                  </div>
                );
              })
            ) : (
              <div className="rounded-lg bg-[#f6f8fa] px-3 py-3 text-[12px] text-[#8a949f]">还没有任务。可让 Agent 使用 team_task 创建。</div>
            )}
          </div>
        </div>
      ) : panel.id === "modlens-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className={`rounded-lg border px-3 py-3 ${data?.attached === true ? "border-[#b9e6c9] bg-[#f0fbf4]" : "border-[#e3e7ee] bg-[#f6f8fa]"}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[#30343b]">{data?.attached === true ? "图片已附加" : "等待图片"}</span>
              <span className="font-mono text-[10px] text-[#8a949f]">vision_inspect</span>
            </div>
            {data?.image !== null && data?.image !== undefined && typeof data.image === "object" ? (
              <p className="mt-2 truncate text-[11px] text-[#65707b]">
                {String((data.image as Record<string, unknown>).path ?? "图片")} · {String((data.image as Record<string, unknown>).bytes ?? 0)} bytes
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-[#8a949f]">调用 vision_inspect 并提供工作区内图片路径。</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {capabilities.map((capability, index) => (
              <span
                className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#4176e6]"
                key={`${String(capability)}-${index}`}
              >
                {String(capability)}
              </span>
            ))}
          </div>
        </div>
      ) : panel.id === "at-file-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[#30343b]">最近附加</span>
              <span className="font-mono text-[10px] text-[#8a949f]">file_context</span>
            </div>
            {data?.lastFile !== null && data?.lastFile !== undefined && typeof data.lastFile === "object" ? (
              <p className="mt-2 truncate text-[11px] text-[#65707b]">
                {String((data.lastFile as Record<string, unknown>).path ?? "文件")} · {String((data.lastFile as Record<string, unknown>).bytes ?? 0)} bytes
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-[#8a949f]">还没有附加文件。可使用 @file 或让 Agent 调用 file_context。</p>
            )}
          </div>
          <div className="flex items-center justify-between text-[11px] text-[#8a949f]">
            <span>单文件上限</span>
            <strong className="font-mono text-[#4176e6]">{String(data?.maxBytes ?? 0)} bytes</strong>
          </div>
        </div>
      ) : panel.id === "git-time-capsule-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[#30343b]">最近快照</span>
              <span className="font-mono text-[10px] text-[#8a949f]">git_snapshot</span>
            </div>
            {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
              <p className="mt-2 truncate text-[11px] text-[#65707b]">
                {String((data.latest as Record<string, unknown>).name ?? "snapshot")} · {String((data.latest as Record<string, unknown>).files ?? 0)} 个文件
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-[#8a949f]">还没有快照。修改代码前让 Agent 调用 git_snapshot。</p>
            )}
          </div>
          <div className="flex items-center justify-between text-[11px] text-[#8a949f]">
            <span>保留快照</span>
            <strong className="font-mono text-[#4176e6]">{String(Array.isArray(data?.capsules) ? data.capsules.length : 0)} / 20</strong>
          </div>
        </div>
      ) : panel.id === "dependency-checker-panel" ? (
        <div className="mt-3 grid gap-3">
          {(() => {
            const report = data?.report !== null && typeof data?.report === "object" ? (data.report as Record<string, unknown>) : {};
            const missing = Array.isArray(report.missing) ? report.missing : [];
            const invalid = Array.isArray(report.invalid) ? report.invalid : [];
            return (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["声明", report.declared ?? 0],
                    ["已安装", report.installed ?? 0],
                    ["缺失", missing.length + invalid.length],
                  ].map(([label, item]) => (
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={String(label)}>
                      <span className="block text-[10px] text-[#8a949f]">{String(label)}</span>
                      <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{String(item)}</strong>
                    </div>
                  ))}
                </div>
                <div
                  className={`rounded-lg border px-3 py-3 text-[11px] ${missing.length || invalid.length ? "border-[#f4caca] bg-[#fff5f5] text-[#b42318]" : "border-[#b9e6c9] bg-[#f0fbf4] text-[#198754]"}`}
                >
                  {missing.length || invalid.length ? `缺失或无效：${[...missing, ...invalid].map(String).join(", ")}` : "依赖声明与本地安装一致。"}
                </div>
              </>
            );
          })()}
        </div>
      ) : panel.id === "token-guard-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className={`rounded-lg border px-3 py-3 ${data?.exceeded === true ? "border-[#f4caca] bg-[#fff5f5]" : "border-[#e3eaf8] bg-[#f6f8ff]"}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[#30343b]">上下文预算</span>
              <strong className="font-mono text-[12px] text-[#315fb8]">
                {String(data?.percent ?? "—")}% / {String(data?.maxPercent ?? "—")}%
              </strong>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#dfe8fb]">
              <div
                className={`h-full rounded-full ${data?.exceeded === true ? "bg-[#d64545]" : "bg-[#5d8bea]"}`}
                style={{ width: `${Math.max(0, Math.min(100, typeof data?.percent === "number" ? data.percent : 0))}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-[#71809a]">
              {data?.exceeded === true ? "已达到阈值，运行会被自动停止。" : `自动停止次数：${String(data?.aborts ?? 0)}`}
            </p>
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
                    <span className="font-mono text-[11px] font-semibold text-[#30343b]">{String(run.command ?? "npm run test")}</span>
                    <strong className={`text-[12px] ${run.exitCode === 0 ? "text-[#198754]" : "text-[#b42318]"}`}>exit {String(run.exitCode ?? "—")}</strong>
                  </div>
                  <p className="mt-2 text-[11px] text-[#65707b]">耗时 {String(run.durationMs ?? 0)} ms</p>
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#8a949f]">
              还没有执行验证脚本。可让 Agent 调用 run_project_tests。
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {Array.isArray(data?.allowedScripts)
              ? data.allowedScripts.map((script, index) => (
                  <span
                    className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#4176e6]"
                    key={`${String(script)}-${index}`}
                  >
                    {String(script)}
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
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={String(label)}>
                      <span className="block text-[10px] text-[#8a949f]">{String(label)}</span>
                      <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{String(item)}</strong>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-[#30343b]">上下文</span>
                    <strong className="font-mono text-[12px] text-[#315fb8]">{String(usage.percent ?? "—")}%</strong>
                  </div>
                  <p className="mt-2 text-[11px] text-[#71809a]">
                    {String(tokens.total ?? 0)} tracked tokens · 输入 {String(tokens.input ?? 0)} · 输出 {String(tokens.output ?? 0)}
                  </p>
                </div>
              </>
            );
          })()}
        </div>
      ) : panel.id === "readme-gen-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.generated === true ? (
            <div className="rounded-lg border border-[#b9e6c9] bg-[#f0fbf4] px-3 py-3 text-[11px] text-[#198754]">
              已生成 {String(data.name ?? "项目")} 的 README 概览：{String(data.scripts ?? 0)} 个脚本，{String(data.plugins ?? 0)} 个运行时插件。
            </div>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#8a949f]">
              还没有生成文档。让 Agent 调用 readme_report 获取 Markdown 草稿。
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
                    <span className="truncate font-mono text-[11px] text-[#30343b]">{String(report.database ?? "database")}</span>
                    <strong className="font-mono text-[12px] text-[#4176e6]">{String(rows.length)} rows</strong>
                  </div>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3] bg-[#fbfcfd] p-3 text-[10px] leading-4 text-[#65707b]">
                    {JSON.stringify(rows, null, 2)}
                  </pre>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#8a949f]">
              还没有查询数据库。可让 Agent 调用 sql_readonly。
            </div>
          )}
        </div>
      ) : panel.id === "docker-sandbox-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const run = data.latest as Record<string, unknown>;
              return (
                <div className="rounded-lg border border-[#b9e6c9] bg-[#f0fbf4] px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-[11px] text-[#30343b]">{String(run.image ?? "image")}</span>
                    <strong className="font-mono text-[12px] text-[#198754]">exit {String(run.exitCode ?? "—")}</strong>
                  </div>
                  <p className="mt-2 text-[11px] text-[#65707b]">{Array.isArray(run.command) ? run.command.map(String).join(" ") : "argv"}</p>
                </div>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#8a949f]">还没有沙箱运行。默认无网络、工作区只读。</div>
          )}
          <div className="flex flex-wrap gap-2">
            {data?.defaults !== null && typeof data?.defaults === "object"
              ? Object.entries(data.defaults as Record<string, unknown>).map(([key, value]) => (
                  <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#4176e6]" key={key}>
                    {key}:{String(value)}
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
                    className={`rounded-lg border px-3 py-3 text-[11px] ${valid ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#198754]" : "border-[#f4caca] bg-[#fff5f5] text-[#b42318]"}`}
                  >
                    {valid ? "YAML 语法有效。" : `发现 ${errors.length} 个语法错误。`}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      ["文档", report.documents ?? 0],
                      ["错误", errors.length],
                      ["警告", warnings.length],
                    ].map(([label, value]) => (
                      <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={String(label)}>
                        <span className="block text-[10px] text-[#8a949f]">{String(label)}</span>
                        <strong className="mt-1 block text-[17px] text-[#30343b]">{String(value)}</strong>
                      </div>
                    ))}
                  </div>
                  {!valid && errors.length > 0 ? (
                    <pre className="max-h-32 overflow-auto rounded-lg border border-[#f4caca] bg-[#fffafa] p-3 text-[10px] leading-4 text-[#b42318]">
                      {errors
                        .map((error) =>
                          typeof error === "object" && error !== null
                            ? `${String((error as Record<string, unknown>).line ?? "?")}:${String((error as Record<string, unknown>).column ?? "?")} ${String((error as Record<string, unknown>).message ?? "")}`
                            : String(error),
                        )
                        .join("\n")}
                    </pre>
                  ) : null}
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#8a949f]">
              还没有校验 YAML。可让 Agent 调用 yaml_validate。
            </div>
          )}
          <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#4176e6]">max:512KiB · read-only</span>
        </div>
      ) : panel.id === "browser-session-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-[11px] text-[#30343b]">{String(data?.endpoint ?? "本地浏览器未连接")}</span>
              <strong className="font-mono text-[12px] text-[#4176e6]">{String(Array.isArray(data?.tabs) ? data.tabs.length : 0)} tabs</strong>
            </div>
            <p className="mt-2 text-[11px] text-[#8a949f]">通过 Chrome DevTools Protocol 操作已启动浏览器，不执行页面外部脚本。</p>
            {data?.connected === false ? (
              <p className="mt-2 text-[11px] text-[#b42318]">未连接：请使用 remote-debugging-port 启动 Chrome。{String(data.error ?? "")}</p>
            ) : null}
          </div>
          {Array.isArray(data?.tabs) && data.tabs.length > 0 ? (
            <div className="grid gap-2">
              {data.tabs.slice(0, 8).map((tab, index) => {
                const item = typeof tab === "object" && tab !== null ? (tab as Record<string, unknown>) : {};
                return (
                  <div className="rounded-lg border border-[#e3e7ee] bg-white px-3 py-2" key={`${String(item.targetId ?? "tab")}-${index}`}>
                    <strong className="block truncate text-[11px] text-[#30343b]">{String(item.title ?? "未命名页面")}</strong>
                    <span className="mt-1 block truncate font-mono text-[10px] text-[#8a949f]">{String(item.url ?? "")}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#8a949f]">
              没有可调试的浏览器页面。请使用 remote-debugging-port 启动 Chrome。
            </div>
          )}
        </div>
      ) : panel.id === "mcp-client-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-[11px] text-[#30343b]">{String(data?.server ?? "尚未连接 MCP 服务器")}</span>
              <strong className="font-mono text-[12px] text-[#4176e6]">{String(Array.isArray(data?.tools) ? data.tools.length : 0)} tools</strong>
            </div>
            <p className="mt-2 text-[11px] text-[#8a949f]">
              {data?.lastCall === null || data?.lastCall === undefined ? "使用 mcp_list_tools 发现 stdio 工具。" : `最近调用：${String(data.lastCall)}`}
            </p>
          </div>
          {Array.isArray(data?.tools) && data.tools.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {data.tools.slice(0, 12).map((tool, index) => {
                const item = typeof tool === "object" && tool !== null ? (tool as Record<string, unknown>) : {};
                return (
                  <span
                    className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#4176e6]"
                    key={`${String(item.name ?? "tool")}-${index}`}
                  >
                    {String(item.name ?? "tool")}
                  </span>
                );
              })}
            </div>
          ) : null}
          {Array.isArray(data?.servers) && data.servers.length > 0 ? (
            <div className="grid gap-2">
              {data.servers.map((server, index) => {
                const item = typeof server === "object" && server !== null ? (server as Record<string, unknown>) : {};
                return (
                  <div
                    className="flex items-center justify-between rounded-lg border border-[#e3e7ee] bg-white px-3 py-2 text-[10px]"
                    key={`${String(item.id ?? "server")}-${index}`}
                  >
                    <span className="font-mono text-[#30343b]">{String(item.id ?? "server")}</span>
                    <span className="text-[#198754]">{String(item.status ?? "unknown")}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : panel.id === "browser-fetch-panel" ? (
        <div className="mt-3 grid gap-3">
          {data?.latest !== null && data?.latest !== undefined && typeof data.latest === "object" ? (
            (() => {
              const result = data.latest as Record<string, unknown>;
              return (
                <>
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-[#f6f8fa] px-3 py-3">
                    <span className="truncate font-mono text-[11px] text-[#30343b]">{String(result.finalUrl ?? result.url ?? "page")}</span>
                    <strong className="font-mono text-[12px] text-[#198754]">HTTP {String(result.status ?? "—")}</strong>
                  </div>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3] bg-[#fbfcfd] p-3 text-[10px] leading-4 text-[#65707b]">
                    {String(result.text ?? "")}
                  </pre>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#8a949f]">
              还没有抓取网页。默认阻止本地和私有网络目标。
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#4176e6]">max:512KiB</span>
            <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#4176e6]">scripts:disabled</span>
            <span className="rounded-md border border-[#dce5f5] bg-white px-2 py-1 font-mono text-[10px] text-[#4176e6]">
              private:{String(data?.allowPrivate === true ? "allowed" : "blocked")}
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
                    className={`rounded-lg border px-3 py-3 text-[11px] ${healthy ? "border-[#b9e6c9] bg-[#f0fbf4] text-[#198754]" : "border-[#f4caca] bg-[#fff5f5] text-[#b42318]"}`}
                  >
                    {healthy ? "语言包键完全一致。" : `缺失 ${missing.length} 个，额外 ${extra.length} 个。`}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                      <span className="block text-[10px] text-[#8a949f]">基准键</span>
                      <strong className="mt-1 block text-[17px] text-[#30343b]">{String(report.baseKeys ?? 0)}</strong>
                    </div>
                    <div className="rounded-lg bg-[#f6f8fa] px-3 py-2">
                      <span className="block text-[10px] text-[#8a949f]">目标键</span>
                      <strong className="mt-1 block text-[17px] text-[#30343b]">{String(report.targetKeys ?? 0)}</strong>
                    </div>
                  </div>
                </>
              );
            })()
          ) : (
            <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3 text-[11px] text-[#8a949f]">
              还没有检查语言包。可让 Agent 调用 i18n_check。
            </div>
          )}
        </div>
      ) : panel.id === "cleaner-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3e7ee] bg-[#f6f8fa] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-[#30343b]">快照清理</span>
              <strong className="font-mono text-[12px] text-[#4176e6]">{String(Array.isArray(data?.capsules) ? data.capsules.length : 0)} 个</strong>
            </div>
            <p className="mt-2 text-[11px] text-[#8a949f]">仅清理 agent 数据目录中的 .patch 快照，必须显式 confirm=true。</p>
          </div>
          <div className="flex items-center justify-between text-[11px] text-[#8a949f]">
            <span>上次清理</span>
            <strong className="font-mono text-[#4176e6]">{String(data?.lastRemoved ?? 0)} 个</strong>
          </div>
        </div>
      ) : panel.id === "fail-logger-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between rounded-lg bg-[#fff5f5] px-3 py-3">
            <span className="text-[11px] font-semibold text-[#7f1d1d]">去重后的失败记录</span>
            <strong className="font-mono text-[17px] text-[#b42318]">{String(data?.total ?? 0)}</strong>
          </div>
          <div className="max-h-48 overflow-auto rounded-lg border border-[#edf0f3]">
            {Array.isArray(data?.failures) && data.failures.length > 0 ? (
              data.failures.map((item, index) => {
                const failure = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return (
                  <div
                    className="grid grid-cols-[auto_1fr] gap-2 border-b border-[#edf0f3] px-3 py-2 last:border-b-0"
                    key={`${String(failure.time ?? "failure")}-${index}`}
                  >
                    <span className="font-mono text-[10px] text-[#b42318]">{String(failure.source ?? "runtime")}</span>
                    <span className="break-words text-[11px] leading-4 text-[#65707b]">{String(failure.message ?? "未知错误")}</span>
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-4 text-[12px] text-[#8a949f]">暂无失败记录。</div>
            )}
          </div>
        </div>
      ) : panel.id === "context-insight-panel" ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-lg border border-[#e3eaf8] bg-[#f6f8ff] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#71809a]">上下文占用</span>
              <strong className="text-[13px] font-semibold text-[#315fb8]">
                {data?.percent === null || data?.percent === undefined ? "—" : `${String(data.percent)}%`}
              </strong>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#dfe8fb]">
              <div
                className="h-full rounded-full bg-[#5d8bea] transition-[width] duration-300"
                style={{ width: `${Math.max(0, Math.min(100, typeof data?.percent === "number" ? data.percent : 0))}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-[#71809a]">
              {data?.tokens === null || data?.tokens === undefined ? "令牌数未知" : `${String(data.tokens)} tokens`}
              {data?.contextWindow === null || data?.contextWindow === undefined ? "" : ` / ${String(data.contextWindow)} 上限`}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              ["消息", data?.messages ?? 0],
              ["事件", data?.events ?? 0],
              ["压缩", data?.compactions ?? 0],
            ].map(([label, item]) => (
              <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={String(label)}>
                <span className="block text-[10px] text-[#8a949f]">{String(label)}</span>
                <strong className="mt-1 block text-[17px] font-semibold text-[#30343b]">{String(item)}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 grid gap-2">
          {entries.map(([key, item]) => (
            <div className="rounded-lg bg-[#f6f8fa] px-3 py-2" key={key}>
              <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-[#8a949f]">{key}</span>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-[#30343b]">{pluginPanelValue(item)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Plugins({
  plugins,
  panels,
  marketplace,
  onMarketplace,
  onToml,
  onToggle,
  onUninstall,
}: {
  plugins: readonly ClientPlugin[];
  panels: readonly ClientPluginPanel[];
  marketplace: readonly ClientMarketplacePlugin[];
  onMarketplace: () => void;
  onToml: () => void;
  onToggle: (plugin: ClientPlugin) => Promise<void>;
  onUninstall: (plugin: ClientPlugin) => Promise<void>;
}) {
  const marketplaceNames = useMemo(() => new Map(marketplace.map((plugin) => [plugin.packageName, plugin.name])), [marketplace]);
  const panelPluginIds = useMemo(() => new Set(panels.map((panel) => panel.pluginId)), [panels]);
  const installedPlugins = useMemo(() => plugins.filter((plugin) => plugin.removable || panelPluginIds.has(plugin.name)), [panelPluginIds, plugins]);
  const panelByPlugin = useMemo(() => new Map(panels.map((panel) => [panel.pluginId, panel])), [panels]);
  const [busyPlugin, setBusyPlugin] = useState<string>();
  const [pluginError, setPluginError] = useState("");
  const runPluginAction = async (plugin: ClientPlugin, action: (plugin: ClientPlugin) => Promise<void>) => {
    setPluginError("");
    setBusyPlugin(plugin.id);
    try {
      await action(plugin);
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyPlugin(undefined);
    }
  };
  return (
    <section className="view-panel plugins-view">
      <div className="plugins-page">
        <div className="subnav">
          <div className="segmented">
            <button className="active" type="button">
              已安装
            </button>
            <button onClick={onMarketplace} type="button">
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
            在 pi.toml 里看这份清单
          </a>
        </div>
        <div className="plugins-scroll">
          <div className="plugins-list">
            {installedPlugins.map((plugin) => {
              const panel = panelByPlugin.get(plugin.name);
              return (
                <div className="flex min-w-0 flex-col gap-3" key={plugin.id}>
                  <article className="plugin-card">
                    <div className="plugin-card-head">
                      <span className="plugin-icon">◈</span>
                      <div className="plugin-copy">
                        <div className="plugin-title">
                          <code>{marketplaceNames.get(plugin.name) ?? displayPluginName(plugin.name)}</code>
                          <small>{plugin.state}</small>
                          <span className="capability">{capability(plugin.name)}</span>
                        </div>
                        <p className="plugin-description">{plugin.enabled ? "由当前运行时加载并启用，能力与 hook 已注册。" : "由当前运行时加载但已停用。"}</p>
                        <div className="hook-list">
                          <span>loader</span>
                          <span>{plugin.state === "active" ? "active" : `state:${plugin.state}`}</span>
                        </div>
                      </div>
                      <div className="plugin-actions">
                        {plugin.removable ? (
                          <>
                            <button
                              aria-label={`${plugin.enabled ? "停用" : "启用"} ${marketplaceNames.get(plugin.name) ?? plugin.name}`}
                              className={`switch ${plugin.enabled ? "on" : ""}`}
                              disabled={busyPlugin !== undefined}
                              onClick={() => void runPluginAction(plugin, (item) => onToggle(item))}
                              type="button"
                            >
                              <i></i>
                            </button>
                            <button
                              className="plugin-uninstall"
                              disabled={busyPlugin !== undefined}
                              onClick={() => void runPluginAction(plugin, onUninstall)}
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
                    {panel && (
                      <details className="mt-4 border-t border-[#e3e7ee] pt-3">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[11px] text-[#4176e6]">
                          <span className="font-semibold">查看详情</span>
                          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#a0a8b2]">实时面板</span>
                        </summary>
                        <PluginPanelCard inline panel={panel} />
                      </details>
                    )}
                  </article>
                </div>
              );
            })}
            {!installedPlugins.length && <div className="empty-state">还没有安装可管理的插件。去插件市场安装一个吧。</div>}
          </div>
          {pluginError && <p className="plugin-action-error">{pluginError}</p>}
          {panels.length > installedPlugins.length && (
            <section className="mt-4 border-t border-[#e3e7ee] pt-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <div>
                  <strong className="text-[13px] font-semibold text-[#20252b]">其他插件面板</strong>
                  <p className="mt-1 text-[12px] text-[#8a949f]">由已启用插件提供的实时状态。</p>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#a0a8b2]">LIVE</span>
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
      </div>
    </section>
  );
}

function Marketplace({
  plugins,
  capabilities,
  total,
  page,
  hasNext,
  query,
  capabilityFilter,
  onQueryChange,
  onCapabilityChange,
  onPageChange,
  onBack,
  onToml,
  installedPackages,
  onInstall,
}: {
  plugins: readonly ClientMarketplacePlugin[];
  capabilities: readonly string[];
  total: number;
  page: number;
  hasNext: boolean;
  query: string;
  capabilityFilter: string;
  onQueryChange: (value: string) => void;
  onCapabilityChange: (value: string) => void;
  onPageChange: (value: number) => void;
  onBack: () => void;
  onToml: () => void;
  installedPackages: ReadonlySet<string>;
  onInstall: (plugin: ClientMarketplacePlugin) => Promise<void>;
}) {
  const [installing, setInstalling] = useState<string>();
  const [installError, setInstallError] = useState("");
  const install = async (plugin: ClientMarketplacePlugin) => {
    setInstallError("");
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
          <div className="segmented">
            <button onClick={onBack} type="button">
              已安装
            </button>
            <button className="active" type="button">
              插件市场
            </button>
          </div>
          <span>社区插件目录</span>
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              onToml();
            }}
          >
            在 pi.toml 里看运行配置
          </a>
        </div>
        <div className="marketplace-hero">
          <div>
            <small>COMMUNITY MARKETPLACE</small>
            <h2>发现社区插件</h2>
            <p>可审查的社区目录。每个条目都包含 npm 包、版本、许可证和配置入口。</p>
          </div>
          <div className="marketplace-hero-actions">
            <button onClick={onBack} type="button">
              运行时插件
            </button>
            <a href="https://github.com/pi-harness/pi-harness/blob/main/docs/plugin-marketplace.md" target="_blank" rel="noreferrer">
              贡献插件 ↗
            </a>
          </div>
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
          <span className="marketplace-count">{total} 个已审核条目</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          <div className="marketplace-grid">
            {plugins.map((plugin) => (
              <article className="marketplace-card" key={plugin.id}>
                <div className="flex items-start gap-2.5">
                  <div className="marketplace-card-mark">◈</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <strong className="marketplace-title">{plugin.name}</strong>
                      <span
                        className={
                          plugin.status === "verified"
                            ? "rounded bg-[#e6faed] px-1.5 py-px font-mono text-[10px] text-[#16a34a]"
                            : "rounded bg-[#fff5e7] px-1.5 py-px font-mono text-[10px] text-[#dd8629]"
                        }
                      >
                        {plugin.status === "verified" ? "已验证" : "实验性"}
                      </span>
                      <span
                        className={
                          plugin.source === "official"
                            ? "rounded bg-[#e4edfd] px-1.5 py-px font-mono text-[10px] text-[#4176e6]"
                            : "rounded bg-[#fef5e7] px-1.5 py-px font-mono text-[10px] text-[#dd8629]"
                        }
                      >
                        {plugin.source === "official" ? "官方" : "社区"}
                      </span>
                    </div>
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
                        <span className="rounded bg-[#f1f4f9] px-1.5 py-px font-mono text-[10px] text-[#61666b]" key={item}>
                          hook:{item}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <footer className="marketplace-card-footer">
                  <span>
                    {plugin.author} · {plugin.license}
                  </span>
                  <a href={plugin.repository} target="_blank" rel="noreferrer">
                    查看源码 ↗
                  </a>
                  <button disabled={installedPackages.has(plugin.packageName) || installing !== undefined} onClick={() => void install(plugin)} type="button">
                    {installedPackages.has(plugin.packageName) ? "已安装" : installing === plugin.id ? "安装中…" : "安装"}
                  </button>
                </footer>
              </article>
            ))}
            {!plugins.length && <div className="p-7 text-center text-[12px] text-[#81858c]">没有匹配的插件。</div>}
          </div>
          {installError && <p className="mt-2 text-[11px] text-[#ec1313]">安装失败：{installError}</p>}
          <div className="mt-3 flex items-center justify-center gap-3 font-mono text-[11px] text-[#81858c]">
            <button
              className="rounded-md border border-black/10 bg-white px-2.5 py-1 text-[11px] text-[#0f1115] disabled:cursor-default disabled:opacity-40"
              disabled={page === 0}
              onClick={() => onPageChange(page - 1)}
              type="button"
            >
              上一页
            </button>
            <span>第 {page + 1} 页</span>
            <button
              className="rounded-md border border-black/10 bg-white px-2.5 py-1 text-[11px] text-[#0f1115] disabled:cursor-default disabled:opacity-40"
              disabled={!hasNext}
              onClick={() => onPageChange(page + 1)}
              type="button"
            >
              下一页
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2.5 rounded-[10px] border border-dashed border-[#b8ccf5] bg-[#f8f9ff] p-2.5 text-[11.5px] text-[#81858c]">
            <strong className="text-[12px] text-[#0f1115]">你有一个 Pi Harness 插件？</strong>
            <span>在 entries 目录新增一个元数据文件，附测试和 README 后提交 PR；审核通过后会出现在这里。</span>
            <a
              className="ml-auto flex-none text-[#4176e6]"
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
  useEffect(() => {
    if (tab !== "toml") return;
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
            <button className={`settings-tab ${tab === item ? "active" : ""}`} key={item} onClick={() => onTab(item)} type="button">
              {item === "general" ? "通用" : item === "providers" ? `提供商 ${data.providers.length}` : "pi.toml"}
            </button>
          ))}
        </nav>
        <section>
          <header>
            <div className="settings-header-copy">
              <strong>{tab === "general" ? "通用" : tab === "providers" ? "提供商" : "pi.toml"}</strong>
              <small>{tab === "toml" ? "配置即代码，改完重载" : "运行时状态与快捷键"}</small>
            </div>
            <button className="settings-back" onClick={onClose} type="button">
              返回会话
            </button>
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
                    <strong>任务结束提醒</strong>
                    <small>由 runtime 插件提供</small>
                  </div>
                  <span className="switch">
                    <i></i>
                  </span>
                </div>
                <div className="general-row">
                  <div>
                    <strong>自动压缩上下文</strong>
                    <small>事件通过 SSE 实时刷新</small>
                  </div>
                  <span className="switch on">
                    <i></i>
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
                  <div className="provider-add-overlay" onClick={() => setProviderAddOpen(false)}>
                    <div aria-label="添加提供商" className="provider-add-modal" onClick={(event) => event.stopPropagation()} role="dialog">
                      <header>
                        <div>
                          <strong>添加自定义提供商</strong>
                          <small>注册 OpenAI 兼容接口，凭据只提交到本机 Pi runtime。</small>
                        </div>
                        <button aria-label="关闭添加提供商" onClick={() => setProviderAddOpen(false)} type="button">
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
                            placeholder="例如 openrouter"
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
                        <input disabled value={provider.provider} readOnly />
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
                        <input disabled value="不会在浏览器显示" readOnly />
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
    <div aria-label={kind === "command" ? "命令补全" : "文件补全"} className="prompt-completion" role="listbox">
      <small>{kind === "command" ? "命令" : "文件"}</small>
      {items.length ? (
        items.slice(0, 12).map((item, index) => {
          const label = kind === "command" ? `/${(item as ClientCommand).invocationName}` : `@${(item as ClientFile).path}`;
          const detail =
            kind === "command" ? ((item as ClientCommand).description ?? (item as ClientCommand).source ?? "由当前运行时注册") : (item as ClientFile).status;
          return (
            <button
              aria-selected={index === activeIndex}
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
      <div aria-label="全局搜索" aria-modal="true" className="global-search-dialog" role="dialog">
        <div className="global-search-heading">
          <strong>全局搜索</strong>
          <small>命令 · 会话 · 文件</small>
        </div>
        <input
          aria-label="全局搜索"
          autoFocus
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
              execute(items[activeIndex]);
            }
          }}
          placeholder="搜索命令、会话或文件"
          value={query}
        />
        <div className="global-search-results" role="listbox">
          {items.length ? (
            (["command", "session", "file"] as const).map((kind) => {
              const group = items.filter((item) => item.kind === kind);
              if (!group.length) return null;
              const label = kind === "command" ? "命令" : kind === "session" ? "会话" : "文件";
              return (
                <section className="global-search-group" key={kind}>
                  <small>{label}</small>
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
                        aria-selected={index === activeIndex}
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

export function ControlRoomView({ api = createClientApi() }: { api?: ClientApi }) {
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
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [marketplaceQuery, setMarketplaceQuery] = useState(initialQueryState.marketplaceQuery);
  const [marketplaceCapability, setMarketplaceCapability] = useState(initialQueryState.marketplaceCapability);
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
  useEffect(() => {
    if (data.session?.messages.length && data.status?.cwd) setSelectedWorkspacePath(data.status.cwd);
  }, [data.session?.messages.length, data.status?.cwd]);
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
  const installedPackages = useMemo(() => new Set(data.plugins.filter((plugin) => plugin.removable).map((plugin) => plugin.name)), [data.plugins]);
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
    if (marketplacePage > 0) params.set("marketplacePage", String(marketplacePage));
    else params.delete("marketplacePage");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [marketplaceCapability, marketplacePage, marketplaceQuery, page, selectedSessionPath, settings, view]);
  const refresh = useCallback(async () => {
    const [status, session, sessions, files, models, providers, plugins, pluginPanels, marketplace, commands, workspaces] = await Promise.allSettled([
      api.getStatus(),
      api.getSession(),
      api.listSessions(sessionPage, 30, includeArchivedSessions),
      api.getFiles(),
      api.listModels(),
      api.listProviders(),
      api.listPlugins(),
      api.listPluginPanels(),
      api.listMarketplace(marketplaceQuery, marketplaceCapability, marketplacePage),
      api.listCommands(),
      api.listWorkspaces(),
    ]);
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
  }, [api, includeArchivedSessions, marketplaceCapability, marketplacePage, marketplaceQuery, sessionPage]);
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
        setSettings("general");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandOpen, globalSearchOpen, sessionDialog]);
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
    const prompt = draft.trim();
    if (!prompt || promptBusy) return;
    setDraft("");
    setPromptError("");
    setPendingPrompt(prompt);
    setStreamingAssistant(undefined);
    stickToBottomRef.current = true;
    setPromptBusy(true);
    void api
      .prompt(prompt)
      .then(() => refresh())
      .catch((cause: unknown) => setPromptError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPendingPrompt(""))
      .finally(() => setPromptBusy(false));
  };
  const openSession = (session: Record<string, unknown>) => {
    const path = typeof session.path === "string" ? session.path : "";
    if (!path) return;
    setSettings(undefined);
    setCommandOpen(false);
    setGlobalSearchOpen(false);
    setPage("session");
    setView("chat");
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
    setSelectedSessionPath(path);
    setSessionNameDraft(name ?? "");
    setSessionMenuPath(path);
    setSessionMenuOpen(true);
  };
  const closeSessionMenu = () => {
    setSessionMenuOpen(false);
    setSessionMenuPath(undefined);
  };
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
      }}
    />
  ) : page === "plugins" ? (
    <Plugins
      plugins={data.plugins}
      panels={data.pluginPanels}
      marketplace={data.marketplace}
      onMarketplace={() => setPage("marketplace")}
      onToml={() => setSettings("toml")}
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
    <Marketplace
      plugins={data.marketplace}
      capabilities={data.marketplaceCapabilities}
      total={data.marketplaceTotal}
      page={data.marketplacePage}
      hasNext={data.marketplaceHasNext}
      query={marketplaceQuery}
      capabilityFilter={marketplaceCapability}
      onQueryChange={(value) => {
        setMarketplaceQuery(value);
        setMarketplacePage(0);
      }}
      onCapabilityChange={(value) => {
        setMarketplaceCapability(value);
        setMarketplacePage(0);
      }}
      onPageChange={setMarketplacePage}
      onBack={() => setPage("plugins")}
      onToml={() => setSettings("toml")}
      installedPackages={installedPackages}
      onInstall={async (plugin) => {
        await api.installMarketplace(plugin.id);
        await refresh();
      }}
    />
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
                  <div className="user-bubble">{turn.text}</div>
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
                    {turn.text && <MarkdownMessage text={turn.text} />}
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
            onToml={() => setSettings("toml")}
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
            {streamingAssistant.text && <MarkdownMessage text={streamingAssistant.text} />}
          </article>
        )}
        {pendingPrompt && !data.session?.messages.some((message) => message.role === "user" && messageText(message) === pendingPrompt) && (
          <article className="turn user pending-turn">
            <div className="user-bubble">{pendingPrompt}</div>
          </article>
        )}
      </div>
      <div className="composer-wrap">
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
        <div className="composer-stack">
          {promptError && <PromptError message={promptError} />}
          <form className="composer" onSubmit={submit}>
            <textarea
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
                  const item = items[promptCompletionIndex];
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
                if (!selectedWorkspacePath) setWorkspaceChooserOpen(true);
              }}
              onFocus={(event) => {
                if (!selectedWorkspacePath) {
                  event.currentTarget.blur();
                  setWorkspaceChooserOpen(true);
                }
              }}
              placeholder={selectedWorkspacePath ? "描述要做的改动，⌘↵ 发送；@ 引用文件，/ 调用命令" : "先选择工作区，再描述要做的改动"}
              readOnly={!selectedWorkspacePath}
              ref={promptInputRef}
              rows={2}
              value={draft}
            ></textarea>
            {promptCompletionOpen && promptCompletion && (
              <PromptCompletionPopover
                activeIndex={promptCompletionIndex}
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
                  const [provider, model] = event.target.value.split("/");
                  if (provider && model) void api.selectModel(provider, model);
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
              <button className="tool-chip" onClick={() => setCommandOpen(true)} type="button">
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
      onDiff={(file) => void api.getFileDiff(file).then((diff) => setDetails({ type: "file_diff", path: diff.path, output: diff.diff }))}
      onRefresh={() => void refresh()}
    />
  );
  const groups = sessionGroups(filteredSessions);
  const showCurrentSession = Boolean(data.session && !search && !filteredSessions.some((session) => session.sessionId === data.session?.sessionId));
  const visibleCommands = filterCommands(data.commands, commandQuery);
  const useCommand = (value: string) => {
    setDraft(value);
    setCommandOpen(false);
    setCommandQuery("");
  };
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <header className="brand-row">
          <span className="pi-mark" aria-hidden="true">
            <img src="/icons/svg/mark-white.svg" alt="" />
          </span>
          <strong>pi harness</strong>
          <span className="version">0.9.4</span>
        </header>
        <div className="sidebar-actions">
          <button className="new-session" onClick={beginNewSession} type="button" aria-expanded={workspaceChooserOpen}>
            ＋ 新建会话
          </button>
          {workspaceChooserOpen && (
            <WorkspaceChooser
              error={workspaceError}
              onClose={() => setWorkspaceChooserOpen(false)}
              onPickDirectory={openDirectory}
              onSelect={(workspace) => void createNewSession(workspace)}
              workspaces={data.workspaces}
            />
          )}
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
            className="visually-hidden"
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
                setSessionSelectionMode((current) => !current);
                setSelectedSessionPaths(new Set());
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
                onClick={() => setSessionToolsOpen((current) => !current)}
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
                <button className="session-row active" onClick={() => void refresh()} type="button">
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
            className={`sidebar-link ${page === "plugins" || page === "marketplace" ? "active" : ""}`}
            onClick={() => {
              setPage("plugins");
              setSettings(undefined);
            }}
            type="button"
          >
            ◈ <span>插件</span>
            <b>{installedPluginCount}</b>
          </button>
          <button className={`sidebar-link ${settings ? "active" : ""}`} onClick={() => setSettings("general")} type="button">
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
                  ? "运行时插件"
                  : page === "marketplace"
                    ? "插件市场"
                    : data.session?.messages.length
                      ? data.session.sessionId.slice(0, 12)
                      : "新会话"}
            </strong>
            <small>
              {settings
                ? "运行时状态与配置"
                : page === "plugins"
                  ? "已安装插件"
                  : page === "marketplace"
                    ? "社区目录 · 可审查插件"
                    : sessionSource(data.status, data.session)}
            </small>
          </div>
          <div className="header-spacer"></div>
          {data.status?.status === "running" && (
            <div className="run-indicator running">
              <span className="run-dot"></span>
              <span>运行中 · Pi agent</span>
              <button className="stop-button" onClick={() => void api.abort().then(refresh)} type="button">
                停止
              </button>
            </div>
          )}
          {!settings && page === "session" && (
            <div className="view-tabs">
              {(["chat", "trajectory", "files"] as const).map((item) => (
                <button className={`view-tab ${view === item ? "active" : ""}`} key={item} onClick={() => setView(item)} type="button">
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
              <button aria-pressed={details !== undefined} className="details-toggle" onClick={() => setDetails(details ? undefined : {})} type="button">
                ◨ 详情
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
        <div className="view-host">{content}</div>
      </section>
      {details !== undefined && (
        <Details
          event={Object.keys(details).length ? details : undefined}
          onClose={() => setDetails(undefined)}
          onCopy={() => void navigator.clipboard?.writeText(JSON.stringify(details, null, 2))}
        />
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
