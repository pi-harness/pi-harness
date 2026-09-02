import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime, AgentSessionServices, ExtensionError, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface PiHarnessLaunch {
  readonly cwd: string;
  readonly cwdUrl?: string;
  readonly agentDir: string;
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

const PI_BUILTIN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

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

declare module "@deepseek-ai/cordis" {
  interface Context {
    piHarnessLaunch: PiHarnessLaunch;
    piModelRuntime: PiModelRuntimeService;
    piModels: PiModelsService;
    piResources: PiResourcesService;
    piSession: PiSessionService;
    piTools: PiToolRegistry;
    piRuntime: PiRuntimeService;
  }

  interface Events {
    "pi/session-event"(event: AgentSessionEvent): void;
    "pi/extension-error"(error: ExtensionError): void;
  }
}

export function provideLaunchContext(context: Context, launch: PiHarnessLaunch): () => void {
  if (!isAbsolute(launch.cwd)) throw new Error(`Pi Harness launch cwd must be an absolute path: ${launch.cwd}`);
  if (!isAbsolute(launch.agentDir)) throw new Error(`Pi Harness agent directory must be an absolute path: ${launch.agentDir}`);
  const value: PiHarnessLaunch = Object.freeze({ ...launch, cwdUrl: pathToFileURL(launch.cwd).href, args: Object.freeze([...launch.args]) });
  return context.provide("piHarnessLaunch", value);
}
