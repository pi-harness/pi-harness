import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
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
  readonly cwdUrl?: string;
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

export interface PiMcpServerSnapshot {
  readonly id: string;
  readonly command: readonly string[];
  readonly status: string;
  readonly startedAt: number;
}

export interface PiMcpService {
  snapshot(): { readonly servers: readonly PiMcpServerSnapshot[] };
}

export interface PiRuntimeService {
  readonly session: AgentSession;
  readonly sessionRuntime: AgentSessionRuntime;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PiTelemetryEvent {
  readonly name: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface PiTelemetryService {
  readonly enabled: false;
  send(event: PiTelemetryEvent): { discarded: true; name: string };
  snapshot(): {
    enabled: false;
    discarded: number;
    observed: number;
    names: readonly string[];
    namesTruncated: boolean;
    scope: "piTelemetry-service-and-event-observation";
  };
}

export interface PiToolsSnapshot {
  readonly names: string[];
  readonly customTools: ToolDefinition[];
}

export interface PiToolsLease extends PiToolsSnapshot {
  release(): void;
}

const PI_BUILTIN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const MAX_PI_TOOL_NAMES = 256;
const MAX_PI_TOOL_NAME_LENGTH = 128;
const PI_TOOL_NAME_PATTERN = /^[^\s\p{Cc}]+$/u;

function assertPiToolName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_PI_TOOL_NAME_LENGTH || !PI_TOOL_NAME_PATTERN.test(name))
    throw new Error(`Pi tool name must contain 1-${MAX_PI_TOOL_NAME_LENGTH} non-whitespace, non-control characters`);
}

// A tool the runtime never saw is not a failure the console can retry away: the runtime snapshots its tool set when it acquires the registry, so a plugin installed into a running harness contributes its tools on the next start. The console distinguishes that from a plugin that is genuinely broken, which is why this carries a marker rather than being a bare Error.
export class PiToolRegistryLeasedError extends Error {
  readonly piToolRegistryLeased = true;

  constructor(toolName: string) {
    super(`Pi tool registry is leased by pi-runtime; declare a Cordis injection that activates ${toolName} before pi-runtime`);
    this.name = "PiToolRegistryLeasedError";
  }
}

// The loader wraps a plugin's activation error in its own Error chain, so the marker is looked for along the whole chain rather than on the value the caller happens to hold.
export function isPiToolRegistryLeasedError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 16; current = current.cause, depth += 1) {
    if ((current as { piToolRegistryLeased?: unknown }).piToolRegistryLeased === true) return true;
    if (current instanceof AggregateError && current.errors.some((nested) => isPiToolRegistryLeasedError(nested))) return true;
  }
  return false;
}

export class PiToolRegistry {
  readonly #names: string[];
  readonly #customTools = new Map<string, ToolDefinition>();
  #leases = 0;

  constructor(names: readonly string[] = []) {
    const uncheckedNames: unknown = names;
    if (!Array.isArray(uncheckedNames) || uncheckedNames.length > MAX_PI_TOOL_NAMES)
      throw new Error(`Pi tool names must contain at most ${MAX_PI_TOOL_NAMES} entries`);
    const validatedNames: string[] = [];
    for (const name of uncheckedNames) {
      const uncheckedName: unknown = name;
      assertPiToolName(uncheckedName);
      validatedNames.push(uncheckedName);
    }
    if (new Set(validatedNames).size !== validatedNames.length) throw new Error("Pi tool names must be unique");
    this.#names = validatedNames;
  }

  register(tool: ToolDefinition): () => void {
    assertPiToolName(tool.name);
    if (this.#leases > 0) throw new PiToolRegistryLeasedError(tool.name);
    if (this.#names.includes(tool.name) || this.#customTools.has(tool.name)) throw new Error(`Pi tool is already registered: ${tool.name}`);
    if (PI_BUILTIN_TOOL_NAMES.includes(tool.name)) throw new Error(`Pi tool name is reserved by a built-in tool: ${tool.name}`);
    this.#customTools.set(tool.name, tool);
    return () => {
      if (this.#customTools.get(tool.name) === tool) this.#customTools.delete(tool.name);
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
  readonly read: () => unknown;
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
      try {
        if (panel.visible !== undefined && !(await panel.visible())) continue;
        const data = await panel.read();
        snapshots.push({
          id: panel.id,
          pluginId: panel.pluginId,
          title: panel.title,
          ...(panel.description === undefined ? {} : { description: panel.description }),
          ...(panel.icon === undefined ? {} : { icon: panel.icon }),
          data: structuredClone(data),
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
    piMcp: PiMcpService;
    piTools: PiToolRegistry;
    piPluginUi: PiPluginUiRegistry;
    piRuntime: PiRuntimeService;
    piTelemetry: PiTelemetryService;
  }

  interface Events {
    "pi/session-event"(event: AgentSessionEvent): void;
    "pi/extension-error"(error: ExtensionError): void;
    "pi/telemetry"(event: PiTelemetryEvent): void;
  }
}

export function provideLaunchContext(context: Context, launch: PiHarnessLaunch): () => void {
  if (!isAbsolute(launch.cwd)) throw new Error(`Pi Harness launch cwd must be an absolute path: ${launch.cwd}`);
  if (!isAbsolute(launch.agentDir)) throw new Error(`Pi Harness agent directory must be an absolute path: ${launch.agentDir}`);
  const value: PiHarnessLaunch = Object.freeze({ ...launch, cwdUrl: pathToFileURL(launch.cwd).href, args: Object.freeze([...launch.args]) });
  return context.provide("piHarnessLaunch", value);
}
