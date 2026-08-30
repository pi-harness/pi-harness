import type { Context } from "@deepseek-ai/cordis";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiHarnessLaunch, PiRuntimeService } from "./services.js";

export interface PiHarnessStdio {
  readPrompt(): Promise<string>;
  writeOutput(text: string): void;
  writeError(text: string): void;
}

export interface PiHarnessApplication {
  run(): Promise<number>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    piHarnessStdio: PiHarnessStdio;
    piApplication: PiHarnessApplication;
  }
}

export function provideStdioContext(context: Context, stdio: PiHarnessStdio): () => void {
  return context.provide("piHarnessStdio", stdio);
}

function promptFromArgs(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args[0] === "--prompt") {
    const prompt = args[1];
    if (prompt === undefined) throw new Error("--prompt requires a value");
    if (args.length > 2) throw new Error("--prompt accepts exactly one value");
    return prompt;
  }
  if (args[0]?.startsWith("--prompt=")) return args[0].slice("--prompt=".length);
  if (args.some((arg) => arg.startsWith("-"))) throw new Error(`Unknown stdio option: ${args.find((arg) => arg.startsWith("-")) ?? ""}`);
  return args.join(" ");
}

export class StdioApplication implements PiHarnessApplication {
  readonly #runtime: PiRuntimeService;
  readonly #launch: PiHarnessLaunch;
  readonly #stdio: PiHarnessStdio;
  #running = false;

  constructor(runtime: PiRuntimeService, launch: PiHarnessLaunch, stdio: PiHarnessStdio) {
    this.#runtime = runtime;
    this.#launch = launch;
    this.#stdio = stdio;
  }

  writeSessionEvent(event: AgentSessionEvent): void {
    if (!this.#running) return;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") this.#stdio.writeOutput(event.assistantMessageEvent.delta);
  }

  async run(): Promise<number> {
    if (this.#running) throw new Error("stdio application is already running");
    this.#running = true;
    try {
      let prompt: string;
      try {
        prompt = promptFromArgs(this.#launch.args) ?? await this.#stdio.readPrompt();
      } catch (error) {
        this.#stdio.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
      }
      if (prompt.trim().length === 0) {
        this.#stdio.writeError("Prompt is empty\n");
        return 2;
      }
      try {
        await this.#runtime.prompt(prompt);
      } catch (error) {
        this.#stdio.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
      const lastMessage = this.#runtime.session.messages.at(-1);
      if (lastMessage?.role === "assistant" && (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted")) {
        this.#stdio.writeError(`${lastMessage.errorMessage ?? `Request ${lastMessage.stopReason}`}\n`);
        return 1;
      }
      this.#stdio.writeOutput("\n");
      return 0;
    } finally {
      this.#running = false;
    }
  }
}
