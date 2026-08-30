import type { Context } from "@deepseek-ai/cordis";
import type { AgentSessionServices, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface PiHarnessLaunch {
  readonly cwd: string;
  readonly agentDir: string;
  readonly args: readonly string[];
  requestExit(code: number): void;
}

export interface PiModelsService {
  readonly runtime: ModelRuntime;
  readonly model: Model<Api>;
}

export type PiResourcesService = AgentSessionServices;

export interface PiSessionService {
  readonly manager: SessionManager;
}

export interface PiToolsSnapshot {
  readonly names: string[];
  readonly customTools: ToolDefinition[];
}

export class PiToolRegistry {
  readonly #names: string[];
  readonly #customTools = new Map<string, ToolDefinition>();

  constructor(names: readonly string[] = []) {
    this.#names = [...names];
  }

  register(tool: ToolDefinition): () => void {
    if (this.#names.includes(tool.name) || this.#customTools.has(tool.name)) throw new Error(`Pi tool is already registered: ${tool.name}`);
    this.#customTools.set(tool.name, tool);
    return () => {
      this.#customTools.delete(tool.name);
    };
  }

  snapshot(): PiToolsSnapshot {
    return { names: [...this.#names], customTools: [...this.#customTools.values()] };
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    piHarnessLaunch: PiHarnessLaunch;
    piModels: PiModelsService;
    piResources: PiResourcesService;
    piSession: PiSessionService;
    piTools: PiToolRegistry;
  }
}

export function provideLaunchContext(context: Context, launch: PiHarnessLaunch): () => void {
  const value: PiHarnessLaunch = Object.freeze({ ...launch, args: Object.freeze([...launch.args]) });
  return context.provide("piHarnessLaunch", value);
}
