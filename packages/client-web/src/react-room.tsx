import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createClientApi,
  type ClientApi,
  type ClientCommand,
  type ClientFile,
  type ClientMarketplacePlugin,
  type ClientModel,
  type ClientPlugin,
  type ClientProvider,
  type ClientSession,
  type ClientStatus,
  type ClientWorkspace,
} from "./control-room.js";
import { getPromptCompletion, replacePromptCompletion, type PromptCompletionKind } from "./prompt-completion.js";
import { compactThinkingEvents } from "./runtime-events.js";

export type { ClientApi } from "./control-room.js";

type View = "chat" | "trajectory" | "files";
type SettingsTab = "general" | "plugins" | "providers" | "toml";
type Page = "session" | "plugins" | "marketplace";
interface RoomData {
  status?: ClientStatus;
  session?: ClientSession;
  sessions: readonly Record<string, unknown>[];
  files: readonly ClientFile[];
  models: readonly ClientModel[];
  providers: readonly ClientProvider[];
  plugins: readonly ClientPlugin[];
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
const messageText = (message: Record<string, unknown>): string => {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("");
  return "";
};
const eventLabel = (event: Record<string, unknown>): string =>
  value(event.summary ?? event.message ?? event.toolName ?? event.type ?? event.event, "未命名事件");
const capability = (name: string): string =>
  name.includes("model")
    ? "模型"
    : name.includes("tool")
      ? "工具"
      : name.includes("session")
        ? "会话"
        : name.includes("resource")
          ? "资源"
          : name.includes("web") || name.includes("gateway")
            ? "界面"
            : "运行时";
const readQueryState = (): {
  page: Page;
  view: View;
  pluginTab: "installed" | "extensions";
  settings?: SettingsTab;
  marketplaceQuery: string;
  marketplaceCapability: string;
  marketplacePage: number;
} => {
  if (typeof window === "undefined")
    return { page: "session", view: "chat", pluginTab: "installed", marketplaceQuery: "", marketplaceCapability: "", marketplacePage: 0 };
  const params = new URLSearchParams(window.location.search);
  const page = params.get("page");
  const view = params.get("view");
  const pluginTab = params.get("pluginTab");
  const settings = params.get("settings");
  const parsedPage = page === "plugins" || page === "marketplace" ? page : "session";
  const parsedView = view === "trajectory" || view === "files" ? view : "chat";
  const parsedPluginTab = pluginTab === "extensions" ? pluginTab : "installed";
  const parsedSettings = settings === "plugins" || settings === "providers" || settings === "toml" ? settings : settings === "general" ? settings : undefined;
  const pageNumber = Number.parseInt(params.get("marketplacePage") ?? "0", 10);
  return {
    page: parsedPage,
    view: parsedView,
    pluginTab: parsedPluginTab,
    settings: parsedSettings,
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

function RuntimeCard({ event }: { event: Record<string, unknown> }) {
  const type = value(event.type, "event");
  const output = event.output ?? event.result ?? event.message;
  if (type === "tool_execution_start" || type === "tool_execution_end")
    return (
      <article className="turn runtime-event">
        <details className="tool-card" open={type === "tool_execution_end"}>
          <summary className="tool-head">
            <b>
              {type === "tool_execution_end" ? "✓" : "▤"} {value(event.toolName ?? event.name, "tool")}
            </b>
            <span className="tool-target">{value(event.args ?? event.toolCallId ?? event.duration, "运行时工具")}</span>
          </summary>
          {output !== undefined && <pre className="tool-output">{typeof output === "string" ? output : JSON.stringify(output, null, 2)}</pre>}
        </details>
      </article>
    );
  if (
    type === "message_update" &&
    typeof event.assistantMessageEvent === "object" &&
    event.assistantMessageEvent !== null &&
    (event.assistantMessageEvent as { type?: unknown }).type === "thinking_delta"
  )
    return (
      <article className="turn runtime-event">
        <details className="reasoning">
          <summary className="reasoning-head">思考</summary>
          <p className="reasoning-body">{value((event.assistantMessageEvent as { delta?: unknown }).delta, "")}</p>
        </details>
      </article>
    );
  if (["agent_start", "turn_start"].includes(type))
    return (
      <article className="turn runtime-event">
        <div className="plugin-event">▷ {type === "agent_start" ? "agent 开始" : "新一轮开始"}</div>
      </article>
    );
  if (["agent_end", "agent_settled", "turn_end"].includes(type))
    return (
      <article className="turn runtime-event">
        <div className="stats-row">✓ {type === "agent_settled" ? "agent 已停止" : type === "agent_end" ? "agent 完成" : "本轮完成"}</div>
      </article>
    );
  if (type === "queue_update")
    return (
      <article className="turn runtime-event">
        <div className="plugin-event">队列更新</div>
        <p className="turn-meta">
          steering {Array.isArray(event.steering) ? event.steering.length : value(event.steering, "0")} · follow-up{" "}
          {Array.isArray(event.followUp) ? event.followUp.length : value(event.followUp, "0")}
        </p>
      </article>
    );
  if (type.startsWith("compaction") || type.startsWith("auto_retry") || type.startsWith("summarization") || type === "bash_execution_update")
    return (
      <article className="turn runtime-event">
        <div className="plugin-event">◈ {type}</div>
        <p className="turn-meta">{typeof output === "string" ? output : JSON.stringify(event)}</p>
      </article>
    );
  return null;
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
        <span className="pi-mark large">π</span>
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
          <div className="detail-plugin">Cordis loader · runtime event</div>
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

function Plugins({
  plugins,
  tab,
  onTab,
  onMarketplace,
  onToml,
}: {
  plugins: readonly ClientPlugin[];
  tab: "installed" | "extensions";
  onTab: (tab: "installed" | "extensions") => void;
  onMarketplace: () => void;
  onToml: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    plugins.forEach((plugin) => map.set(capability(plugin.name), [...(map.get(capability(plugin.name)) ?? []), plugin.name]));
    return map;
  }, [plugins]);
  return (
    <section className="view-panel plugins-view">
      <div className="plugins-page">
        <div className="subnav">
          <div className="segmented">
            <button className={tab === "installed" ? "active" : ""} onClick={() => onTab("installed")} type="button">
              已安装
            </button>
            <button className={tab === "extensions" ? "active" : ""} onClick={() => onTab("extensions")} type="button">
              扩展点
            </button>
            <button onClick={onMarketplace} type="button">
              插件市场
            </button>
          </div>
          <span>运行时插件清单</span>
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
          {tab === "installed" ? (
            <>
              <div className="plugins-list">
                {plugins.map((plugin) => (
                  <article className="plugin-card" key={plugin.id}>
                    <div className="plugin-card-head">
                      <span className="plugin-icon">◈</span>
                      <div className="plugin-copy">
                        <div className="plugin-title">
                          <code>{plugin.name}</code>
                          <small>{plugin.state}</small>
                          <span className="capability">{capability(plugin.name)}</span>
                        </div>
                        <p className="plugin-description">
                          {plugin.enabled ? "由当前 Cordis loader 加载并启用，能力与 hook 由运行时注册。" : "由当前 Cordis loader 加载但已停用。"}
                        </p>
                        <div className="hook-list">
                          <span>loader</span>
                          <span>{plugin.state === "active" ? "active" : `state:${plugin.state}`}</span>
                        </div>
                      </div>
                      <span className={`switch ${plugin.enabled ? "on" : ""}`}>
                        <i></i>
                      </span>
                    </div>
                  </article>
                ))}
              </div>
              <div className="plugin-add">
                <code>dsh plugin add</code>
                <input disabled placeholder="github:owner/repo" />
                <button className="primary" disabled type="button">
                  安装
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="extension-note">每个扩展点由哪些包占用，按 Cordis loader 的执行顺序排列。</p>
              <div className="extension-table">
                <div className="extension-row extension-head">
                  <span>扩展点</span>
                  <span>占用者（按序）</span>
                  <span>数量</span>
                </div>
                {[...groups].map(([point, owners]) => (
                  <div className="extension-row" key={point}>
                    <code>{point}</code>
                    <div className="extension-owners">
                      {owners.map((owner) => (
                        <span key={owner}>{owner}</span>
                      ))}
                    </div>
                    <code>{owners.length}</code>
                  </div>
                ))}
              </div>
            </>
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
}) {
  const [copied, setCopied] = useState<string>();
  const [copyError, setCopyError] = useState("");
  const copyInstall = (plugin: ClientMarketplacePlugin) => {
    const profile = JSON.stringify({ id: plugin.id, name: plugin.profile.name, config: plugin.profile.config }, null, 2);
    const command = "npm install --save-exact " + plugin.packageName + "@" + plugin.version + "\\n\\nAdd this entry to your Cordis profile:\\n" + profile;
    setCopyError("");
    if (!navigator.clipboard) {
      setCopyError("当前浏览器不允许复制，请手动复制安装指引。");
      return;
    }
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(plugin.id);
        window.setTimeout(() => setCopied((current) => (current === plugin.id ? undefined : current)), 1800);
      })
      .catch(() => setCopyError("复制失败，请检查浏览器权限后重试。"));
  };
  return (
    <section className="marketplace-page flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="marketplace-hero">
          <div>
            <small>COMMUNITY MARKETPLACE</small>
            <h2>发现 Cordis 插件</h2>
            <p>可审查的社区目录。每个条目都包含 npm 包、版本、许可证和 Cordis 配置入口。</p>
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
                      {plugin.packageName}@{plugin.version}
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
                  <button onClick={() => copyInstall(plugin)} type="button">
                    {copied === plugin.id ? "已复制" : "复制安装指引"}
                  </button>
                </footer>
              </article>
            ))}
            {!plugins.length && <div className="p-7 text-center text-[12px] text-[#81858c]">没有匹配的插件。</div>}
          </div>
          {copyError && <p className="mt-2 text-[11px] text-[#ec1313]">{copyError}</p>}
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
            <strong className="text-[12px] text-[#0f1115]">你有一个 Cordis 插件？</strong>
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
          {(["general", "plugins", "providers", "toml"] as const).map((item) => (
            <button className={`settings-tab ${tab === item ? "active" : ""}`} key={item} onClick={() => onTab(item)} type="button">
              {item === "general"
                ? "通用"
                : item === "plugins"
                  ? `插件 ${data.plugins.length}`
                  : item === "providers"
                    ? `提供商 ${data.providers.length}`
                    : "pi.toml"}
            </button>
          ))}
        </nav>
        <section>
          <header>
            <div className="settings-header-copy">
              <strong>{tab === "general" ? "通用" : tab === "plugins" ? "插件" : tab === "providers" ? "提供商" : "pi.toml"}</strong>
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
            {tab === "plugins" &&
              data.plugins.map((plugin) => (
                <div className="settings-plugin-row" key={plugin.id}>
                  ◈{" "}
                  <code>
                    {plugin.name} · {plugin.id} · {plugin.state}
                  </code>
                </div>
              ))}
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
              <>
                <div className="toml-toolbar">
                  <span>~/.config/pi/pi.toml</span>
                  <button className="active" type="button">
                    表单
                  </button>
                  <button disabled type="button">
                    源码
                  </button>
                  <button className="primary" disabled type="button">
                    重载
                  </button>
                </div>
                <div className="toml">
                  <div className="empty-state">pi.toml 读取与写入 API 尚未提供。</div>
                </div>
              </>
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
  const [pluginTab, setPluginTab] = useState<"installed" | "extensions">(initialQueryState.pluginTab);
  const [settings, setSettings] = useState<SettingsTab | undefined>(initialQueryState.settings);
  const [details, setDetails] = useState<Record<string, unknown>>();
  const [commandOpen, setCommandOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [workspaceChooserOpen, setWorkspaceChooserOpen] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string>();
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
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const [promptCaret, setPromptCaret] = useState(0);
  const [promptCompletionSuppressed, setPromptCompletionSuppressed] = useState(false);
  const [promptCompletionIndex, setPromptCompletionIndex] = useState(0);
  useEffect(() => {
    if (data.session?.messages.length && data.status?.cwd) setSelectedWorkspacePath(data.status.cwd);
  }, [data.session?.messages.length, data.status?.cwd]);
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
  useEffect(() => {
    setPromptCompletionIndex(0);
  }, [promptCompletion?.kind, promptCompletion?.query]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    params.set("page", page);
    if (view === "chat") params.delete("view");
    else params.set("view", view);
    if (pluginTab === "installed") params.delete("pluginTab");
    else params.set("pluginTab", pluginTab);
    if (settings) params.set("settings", settings);
    else params.delete("settings");
    if (marketplaceQuery) params.set("marketplaceQuery", marketplaceQuery);
    else params.delete("marketplaceQuery");
    if (marketplaceCapability) params.set("capability", marketplaceCapability);
    else params.delete("capability");
    if (marketplacePage > 0) params.set("marketplacePage", String(marketplacePage));
    else params.delete("marketplacePage");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [marketplaceCapability, marketplacePage, marketplaceQuery, page, pluginTab, settings, view]);
  const refresh = useCallback(async () => {
    const [status, session, sessions, files, models, providers, plugins, marketplace, commands, workspaces] = await Promise.allSettled([
      api.getStatus(),
      api.getSession(),
      api.listSessions(),
      api.getFiles(),
      api.listModels(),
      api.listProviders(),
      api.listPlugins(),
      api.listMarketplace(marketplaceQuery, marketplaceCapability, marketplacePage),
      api.listCommands(),
      api.listWorkspaces(),
    ]);
    setData((current) => ({
      status: status.status === "fulfilled" ? status.value : current.status,
      session: session.status === "fulfilled" ? session.value : current.session,
      sessions: sessions.status === "fulfilled" ? sessions.value : current.sessions,
      files: files.status === "fulfilled" ? files.value : current.files,
      models: models.status === "fulfilled" ? models.value : current.models,
      providers: providers.status === "fulfilled" ? providers.value : current.providers,
      plugins: plugins.status === "fulfilled" ? plugins.value : current.plugins,
      marketplace: marketplace.status === "fulfilled" ? marketplace.value.items : current.marketplace,
      marketplaceCapabilities: marketplace.status === "fulfilled" ? marketplace.value.capabilities : current.marketplaceCapabilities,
      marketplaceTotal: marketplace.status === "fulfilled" ? marketplace.value.total : current.marketplaceTotal,
      marketplacePage: marketplace.status === "fulfilled" ? marketplace.value.page : current.marketplacePage,
      marketplaceHasNext: marketplace.status === "fulfilled" ? marketplace.value.hasNext : current.marketplaceHasNext,
      commands: commands.status === "fulfilled" ? commands.value : current.commands,
      workspaces: workspaces.status === "fulfilled" ? workspaces.value : current.workspaces,
    }));
  }, [api, marketplaceCapability, marketplacePage, marketplaceQuery]);
  const createNewSession = useCallback(
    async (workspace?: ClientWorkspace) => {
      setPromptError("");
      setWorkspaceError("");
      try {
        await api.createSession(workspace?.path);
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
    const unsubscribe = api.subscribeEvents(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [api, refresh]);
  useEffect(() => {
    setCommandIndex(0);
    if (!commandOpen) return;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [commandOpen, commandQuery]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
  }, [commandOpen, globalSearchOpen]);
  const events = data.session?.events ?? [];
  const displayEvents = useMemo(() => compactThinkingEvents(events), [events]);
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
    setPromptBusy(true);
    void api
      .prompt(prompt)
      .then(() => refresh())
      .catch((cause: unknown) => setPromptError(cause instanceof Error ? cause.message : String(cause)))
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
    void api.openSession(path).then(refresh);
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
    <Plugins plugins={data.plugins} tab={pluginTab} onTab={setPluginTab} onMarketplace={() => setPage("marketplace")} onToml={() => setSettings("toml")} />
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
    />
  ) : view === "chat" ? (
    <section className="view-panel chat-view">
      <div className={`chat-scroll ${data.session?.messages.length ? "" : "is-empty"}`}>
        {data.session?.messages.length ? (
          data.session.messages.map((message, index) => (
            <article className={`turn ${message.role === "user" ? "user" : "text"}`} key={index}>
              {message.role === "user" ? <div className="user-bubble">{messageText(message)}</div> : <p className="turn-text">{messageText(message)}</p>}
            </article>
          ))
        ) : (
          <Workspace
            status={data.status}
            workspaces={data.workspaces}
            onCreate={(workspace) => void createNewSession(workspace)}
            onStarter={setDraft}
            onToml={() => setSettings("toml")}
          />
        )}
        {displayEvents.map((event, index) => (
          <RuntimeCard event={event} key={`${value(event.type, "event")}-${index}`} />
        ))}
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
          <span className="pi-mark">π</span>
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
        </div>
        <div className="sidebar-scroll">
          {showCurrentSession && data.session && (
            <div className="session-group">
              <div className="group-label">当前</div>
              <button className="session-row active" onClick={() => void refresh()} type="button">
                <span className="session-dot ok"></span>
                <span className="session-copy">
                  <strong>{data.session.messages.length ? data.session.sessionId.slice(0, 12) : "新会话"}</strong>
                  <small>{data.session.messages.length} 条消息</small>
                </span>
              </button>
            </div>
          )}
          {groups.length ? (
            groups.map(([label, sessions]) => (
              <div className="session-group" key={label}>
                <div className="group-label">{label}</div>
                {sessions.map((session, index) => (
                  <button
                    className={`session-row ${session.sessionId === data.session?.sessionId ? "active" : ""}`}
                    key={index}
                    onClick={() => openSession(session)}
                    type="button"
                  >
                    <span className="session-dot ok"></span>
                    <span className="session-copy">
                      <strong>{value(session.name ?? session.firstMessage, "未命名会话")}</strong>
                      <small>{value(session.messageCount, "0")} 条消息</small>
                    </span>
                  </button>
                ))}
              </div>
            ))
          ) : !showCurrentSession ? (
            <div className="empty-state">暂无已保存会话</div>
          ) : null}
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
            <b>{data.plugins.length}</b>
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
                  ? "Cordis loader 运行时清单"
                  : page === "marketplace"
                    ? "社区目录 · 可审查安装指引"
                    : sessionSource(data.status, data.session)}
            </small>
          </div>
          <div className="header-spacer"></div>
          {data.status?.status === "running" && (
            <div className="run-indicator running">
              <span></span>
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
              <button className="session-menu" onClick={() => setSessionMenuOpen((current) => !current)} type="button" aria-label="会话操作">
                ⋯
              </button>
              <button aria-pressed={details !== undefined} className="details-toggle" onClick={() => setDetails(details ? undefined : {})} type="button">
                ◨ 详情
              </button>
            </>
          )}
          {!settings && page === "session" && sessionMenuOpen && (
            <div className="session-menu-popover">
              <button
                className="session-action"
                onClick={() => {
                  setSessionMenuOpen(false);
                  beginNewSession();
                }}
                type="button"
              >
                <strong>新建会话</strong>
                <small>清空并开始新的运行时会话</small>
              </button>
              <button className="session-action" onClick={() => window.location.reload()} type="button">
                <strong>刷新会话</strong>
                <small>重新读取运行时状态</small>
              </button>
              <button className="session-action" disabled type="button">
                <strong>导出事件</strong>
                <small>API 暂未提供导出接口</small>
              </button>
              <button className="session-action" disabled type="button">
                <strong>删除会话</strong>
                <small>API 暂未提供删除接口</small>
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
    </div>
  );
}
