import type { Context } from "@deepseek-ai/cordis";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  AgentSessionServices,
  ExtensionError,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface PiHarnessLaunch {
  readonly cwd: string;
  readonly agentDir: string;
  readonly configPath?: string;
  readonly args: readonly string[];
  requestExit(code: number): void;
}

export interface PiModelsService {
  readonly runtime: ModelRuntime;
  readonly model: Model<Api>;
}

export interface PiModelRuntimeService {
  readonly runtime: ModelRuntime;
  readonly provider: string;
  readonly model: string;
}

export type PiResourcesService = AgentSessionServices & {
  createForCwd(cwd: string): Promise<AgentSessionServices>;
};

export interface PiSessionService {
  readonly manager: SessionManager;
}

export interface PiRuntimeService {
  readonly session: AgentSession;
  readonly sessionRuntime: AgentSessionRuntime;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PiToolsSnapshot {
  readonly names: string[];
  readonly customTools: ToolDefinition[];
}

export interface PiToolsLease extends PiToolsSnapshot {
  release(): void;
}

export class PiToolRegistry {
  readonly #names: string[];
  readonly #customTools = new Map<string, ToolDefinition>();
  #leases = 0;

  constructor(names: readonly string[] = []) {
    this.#names = [...names];
  }

  register(tool: ToolDefinition): () => void {
    if (this.#leases > 0) throw new Error(`Pi tool registry is leased by pi-runtime; declare a Cordis injection that activates ${tool.name} before pi-runtime`);
    if (this.#names.includes(tool.name) || this.#customTools.has(tool.name)) throw new Error(`Pi tool is already registered: ${tool.name}`);
    this.#customTools.set(tool.name, tool);
    return () => {
      this.#customTools.delete(tool.name);
    };
  }

  snapshot(): PiToolsSnapshot {
    return { names: [...this.#names], customTools: [...this.#customTools.values()] };
  }

  acquire(): PiToolsLease {
    this.#leases += 1;
    let released = false;
    return {
      ...this.snapshot(),
      release: () => {
        if (released) return;
        released = true;
        this.#leases -= 1;
      },
    };
  }
}

export interface PiPluginPanel {
  readonly id: string;
  readonly pluginId: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: string;
  readonly visible?: () => boolean | Promise<boolean>;
  readonly read: () => unknown | Promise<unknown>;
}

export interface PiPluginPanelSnapshot {
  readonly id: string;
  readonly pluginId: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: string;
  readonly data?: unknown;
  readonly error?: string;
}

export class PiPluginUiRegistry {
  readonly #panels = new Map<string, PiPluginPanel>();

  register(panel: PiPluginPanel): () => void {
    if (panel.id.trim() === "" || panel.pluginId.trim() === "" || panel.title.trim() === "")
      throw new Error("Plugin UI panel id, pluginId, and title are required");
    if (this.#panels.has(panel.id)) throw new Error(`Plugin UI panel is already registered: ${panel.id}`);
    this.#panels.set(panel.id, panel);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#panels.get(panel.id) === panel) this.#panels.delete(panel.id);
    };
  }

  async snapshot(): Promise<readonly PiPluginPanelSnapshot[]> {
    const snapshots: PiPluginPanelSnapshot[] = [];
    for (const panel of this.#panels.values()) {
      if (panel.visible !== undefined && !(await panel.visible())) continue;
      try {
        snapshots.push({
          id: panel.id,
          pluginId: panel.pluginId,
          title: panel.title,
          ...(panel.description === undefined ? {} : { description: panel.description }),
          ...(panel.icon === undefined ? {} : { icon: panel.icon }),
          data: await panel.read(),
        });
      } catch (error) {
        snapshots.push({
          id: panel.id,
          pluginId: panel.pluginId,
          title: panel.title,
          ...(panel.description === undefined ? {} : { description: panel.description }),
          ...(panel.icon === undefined ? {} : { icon: panel.icon }),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return snapshots;
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    piHarnessLaunch: PiHarnessLaunch;
    piModelRuntime: PiModelRuntimeService;
    piModels: PiModelsService;
    piResources: PiResourcesService;
    piSession: PiSessionService;
    piTools: PiToolRegistry;
    piPluginUi: PiPluginUiRegistry;
    piRuntime: PiRuntimeService;
  }

  interface Events {
    "pi/session-event"(event: AgentSessionEvent): void;
    "pi/extension-error"(error: ExtensionError): void;
  }
}

export function provideLaunchContext(context: Context, launch: PiHarnessLaunch): () => void {
  const value: PiHarnessLaunch = Object.freeze({ ...launch, args: Object.freeze([...launch.args]) });
  return context.provide("piHarnessLaunch", value);
}
