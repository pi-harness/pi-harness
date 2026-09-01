export interface ClientStatus {
  readonly status: string;
  readonly model: string;
  readonly messages: number;
  readonly events: number;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly plugins: readonly string[];
}
export interface ClientSession {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly messages: readonly Record<string, unknown>[];
  readonly entries: readonly unknown[];
  readonly events: readonly Record<string, unknown>[];
}
export interface ClientModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number | null;
  readonly active: boolean;
}
export interface ClientPlugin {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly state: string;
}
export interface ClientProvider {
  readonly provider: string;
  readonly name: string;
  readonly active: boolean;
  readonly auth?: { readonly configured?: boolean; readonly source?: string; readonly label?: string };
  readonly activeModel?: ClientModel;
  readonly models: readonly ClientModel[];
}
export interface ClientCommand {
  readonly name: string;
  readonly invocationName: string;
  readonly description?: string;
  readonly source?: string;
}
export interface ClientMarketplacePlugin {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly author: string;
  readonly repository: string;
  readonly license: string;
  readonly source: "official" | "community";
  readonly status: "verified" | "experimental";
  readonly capabilities: readonly string[];
  readonly hooks: readonly string[];
  readonly profile: { readonly name: string; readonly config: Record<string, unknown> };
}
export interface ClientMarketplacePage {
  readonly items: readonly ClientMarketplacePlugin[];
  readonly capabilities: readonly string[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
}
export interface ClientFile {
  readonly path: string;
  readonly status: string;
  readonly label: string;
}
export interface ClientWorkspace {
  readonly path: string;
  readonly branch: string;
  readonly current: boolean;
  readonly name: string;
}
export interface ClientPiConfig {
  readonly path: string;
  readonly scope: "global" | "project";
  readonly source: string;
  readonly settings: {
    readonly defaultProvider?: string;
    readonly defaultModel?: string;
    readonly defaultThinkingLevel?: string;
    readonly transport: string;
    readonly steeringMode: string;
    readonly followUpMode: string;
    readonly hideThinkingBlock: boolean;
    readonly compaction: { readonly enabled: boolean; readonly reserveTokens: number; readonly keepRecentTokens: number };
    readonly retry: { readonly enabled: boolean; readonly maxRetries: number; readonly baseDelayMs: number };
    readonly terminal: { readonly showImages: boolean; readonly imageAutoResize: boolean; readonly autocompleteMaxVisible: number };
    readonly advanced: {
      readonly quietStartup: boolean;
      readonly projectTrust: string;
      readonly showCacheMissNotices: boolean;
      readonly enableAnalytics: boolean;
      readonly enableInstallTelemetry: boolean;
      readonly shellPath?: string;
      readonly doubleEscapeAction: string;
      readonly treeFilterMode: string;
      readonly mermaid: string;
    };
  };
}
export interface ClientSessionList {
  readonly items: readonly Record<string, unknown>[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
}
export interface ClientApi {
  getStatus(): Promise<ClientStatus>;
  getSession(): Promise<ClientSession>;
  getFiles(): Promise<readonly ClientFile[]>;
  listWorkspaces(): Promise<readonly ClientWorkspace[]>;
  pickDirectory(): Promise<string>;
  getFileDiff(path: string): Promise<{ path: string; diff: string }>;
  commitFiles(paths: readonly string[], message: string): Promise<{ committed: boolean; commit?: string; message: string }>;
  revertFiles(paths: readonly string[]): Promise<{ reverted: boolean; paths: readonly string[] }>;
  prompt(value: string): Promise<{ reply: string; messages: number }>;
  abort(): Promise<{ aborted: boolean }>;
  createSession(cwd?: string): Promise<ClientSession>;
  openSession(path: string): Promise<ClientSession>;
  listSessions(page?: number, pageSize?: number, includeArchived?: boolean): Promise<ClientSessionList>;
  renameSession(path: string, name: string): Promise<{ path: string; name?: string }>;
  deleteSession(path: string): Promise<{ deleted: boolean; path: string; sessionFile?: string }>;
  setSessionMetadata(path: string, metadata: { archived?: boolean; pinned?: boolean }): Promise<{ path: string; metadata: Record<string, unknown> }>;
  batchSessions(action: "delete" | "archive" | "unarchive" | "pin" | "unpin", paths: readonly string[]): Promise<{ action: string; count: number }>;
  forkSession(path: string, cwd?: string): Promise<{ sessionId: string; sessionFile?: string; cwd: string }>;
  importSession(content: string, filename: string, cwd?: string): Promise<ClientSession>;
  exportSession(path: string): Promise<Blob>;
  listModels(): Promise<readonly ClientModel[]>;
  listProviders(): Promise<readonly ClientProvider[]>;
  testProvider(provider: string): Promise<{ provider: string; reachable: boolean; auth?: unknown }>;
  refreshProvider(provider: string): Promise<{ provider: string; models: readonly ClientModel[] }>;
  addProvider(input: {
    provider: string;
    name: string;
    baseUrl: string;
    api: "openai-completions" | "openai-responses";
    apiKey: string;
    model: string;
  }): Promise<{ provider: ClientProvider }>;
  listPlugins(): Promise<readonly ClientPlugin[]>;
  listMarketplace(query?: string, capability?: string, page?: number, pageSize?: number): Promise<ClientMarketplacePage>;
  listCommands(): Promise<readonly ClientCommand[]>;
  selectModel(provider: string, model: string): Promise<{ model: ClientModel }>;
  getConfig(): Promise<ClientPiConfig>;
  updateConfig(input: Partial<ClientPiConfig["settings"]>): Promise<ClientPiConfig>;
  updateConfigSource(source: string): Promise<ClientPiConfig>;
  reloadConfig(): Promise<ClientPiConfig>;
  subscribeEvents(onEvent: (payload: Record<string, unknown>) => void): () => void;
}
function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, init).then(async (response) => {
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      const error =
        payload !== null && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `Request failed with status ${response.status}`;
      throw new Error(error);
    }
    return payload as T;
  });
}
export function createClientApi(): ClientApi {
  return {
    getStatus: () => requestJson<ClientStatus>("/api/status"),
    getSession: () => requestJson<ClientSession>("/api/session"),
    getFiles: async () => (await requestJson<{ items: readonly ClientFile[] }>("/api/files")).items,
    listWorkspaces: async () => (await requestJson<{ items: readonly ClientWorkspace[] }>("/api/workspaces")).items,
    pickDirectory: async () => (await requestJson<{ path: string }>("/api/workspaces/pick", { method: "POST" })).path,
    getFileDiff: (path) => requestJson<{ path: string; diff: string }>(`/api/files/diff?path=${encodeURIComponent(path)}`),
    commitFiles: (paths, message) =>
      requestJson<{ committed: boolean; commit?: string; message: string }>("/api/files/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths, message }),
      }),
    revertFiles: (paths) =>
      requestJson<{ reverted: boolean; paths: readonly string[] }>("/api/files/revert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths, confirm: true }),
      }),
    prompt: (value) =>
      requestJson<{ reply: string; messages: number }>("/api/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: value }),
      }),
    abort: () => requestJson<{ aborted: boolean }>("/api/abort", { method: "POST" }),
    createSession: (cwd) =>
      requestJson<ClientSession>("/api/session/new", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cwd ? { cwd } : {}),
      }),
    openSession: (path) =>
      requestJson<ClientSession>("/api/session/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }),
    listSessions: (page = 0, pageSize = 50, includeArchived = false) =>
      requestJson<ClientSessionList>(`/api/sessions?page=${page}&pageSize=${pageSize}&includeArchived=${includeArchived}`),
    renameSession: (path, name) =>
      requestJson<{ path: string; name?: string }>("/api/session/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, name }),
      }),
    deleteSession: (path) =>
      requestJson<{ deleted: boolean; path: string; sessionFile?: string }>("/api/session/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, confirm: true }),
      }),
    setSessionMetadata: (path, metadata) =>
      requestJson<{ path: string; metadata: Record<string, unknown> }>("/api/session/metadata", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, ...metadata }),
      }),
    batchSessions: (action, paths) =>
      requestJson<{ action: string; count: number }>("/api/sessions/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, paths, confirm: action === "delete" }),
      }),
    forkSession: (path, cwd) =>
      requestJson<{ sessionId: string; sessionFile?: string; cwd: string }>("/api/session/fork", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, cwd }),
      }),
    importSession: async (content, filename, cwd) => {
      const result = await requestJson<{ sessionId: string; sessionFile?: string; messages: number }>("/api/session/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, filename, cwd }),
      });
      return { sessionId: result.sessionId, sessionFile: result.sessionFile, messages: [], entries: [], events: [] };
    },
    exportSession: async (path) => {
      const response = await fetch(`/api/session/export?path=${encodeURIComponent(path)}`);
      if (!response.ok) throw new Error(`Export failed with status ${response.status}`);
      return response.blob();
    },
    listModels: async () => (await requestJson<{ items: readonly ClientModel[] }>("/api/models")).items,
    listProviders: async () => (await requestJson<{ items: readonly ClientProvider[] }>("/api/providers")).items,
    testProvider: (provider) =>
      requestJson<{ provider: string; reachable: boolean; auth?: unknown }>("/api/providers/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      }),
    refreshProvider: (provider) =>
      requestJson<{ provider: string; models: readonly ClientModel[] }>("/api/providers/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      }),
    addProvider: (input) =>
      requestJson<{ provider: ClientProvider }>("/api/providers/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    listPlugins: async () => (await requestJson<{ items: readonly ClientPlugin[] }>("/api/plugins")).items,
    listMarketplace: (query = "", capability = "", page = 0, pageSize = 24) =>
      requestJson<ClientMarketplacePage>(
        `/api/marketplace?q=${encodeURIComponent(query)}&capability=${encodeURIComponent(capability)}&page=${page}&pageSize=${pageSize}`,
      ),
    listCommands: async () => (await requestJson<{ items: readonly ClientCommand[] }>("/api/commands")).items,
    selectModel: (provider, model) =>
      requestJson<{ model: ClientModel }>("/api/model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, model }),
      }),
    getConfig: () => requestJson<ClientPiConfig>("/api/config"),
    updateConfig: (input) =>
      requestJson<ClientPiConfig>("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    updateConfigSource: (source) =>
      requestJson<ClientPiConfig>("/api/config/source", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      }),
    reloadConfig: () => requestJson<ClientPiConfig>("/api/config/reload", { method: "POST" }),
    subscribeEvents: (onEvent) => {
      if (typeof EventSource === "undefined") return () => {};
      const source = new EventSource("/api/events");
      source.onmessage = (event) => {
        try {
          const raw: unknown = event.data;
          if (typeof raw === "string") onEvent(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          /* Ignore malformed frames at the network boundary. */
        }
      };
      return () => source.close();
    },
  };
}
