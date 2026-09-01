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
export interface ClientApi {
  getStatus(): Promise<ClientStatus>;
  getSession(): Promise<ClientSession>;
  getFiles(): Promise<readonly ClientFile[]>;
  listWorkspaces(): Promise<readonly ClientWorkspace[]>;
  getFileDiff(path: string): Promise<{ path: string; diff: string }>;
  commitFiles(paths: readonly string[], message: string): Promise<{ committed: boolean; commit?: string; message: string }>;
  revertFiles(paths: readonly string[]): Promise<{ reverted: boolean; paths: readonly string[] }>;
  prompt(value: string): Promise<{ reply: string; messages: number }>;
  abort(): Promise<{ aborted: boolean }>;
  createSession(cwd?: string): Promise<ClientSession>;
  openSession(path: string): Promise<ClientSession>;
  listSessions(): Promise<readonly Record<string, unknown>[]>;
  listModels(): Promise<readonly ClientModel[]>;
  listProviders(): Promise<readonly ClientProvider[]>;
  testProvider(provider: string): Promise<{ provider: string; reachable: boolean; auth?: unknown }>;
  refreshProvider(provider: string): Promise<{ provider: string; models: readonly ClientModel[] }>;
  listPlugins(): Promise<readonly ClientPlugin[]>;
  listMarketplace(query?: string, capability?: string, page?: number, pageSize?: number): Promise<ClientMarketplacePage>;
  listCommands(): Promise<readonly ClientCommand[]>;
  selectModel(provider: string, model: string): Promise<{ model: ClientModel }>;
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
    listSessions: async () => (await requestJson<{ items: readonly Record<string, unknown>[] }>("/api/sessions")).items,
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
