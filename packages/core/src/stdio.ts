import type { Context } from "@deepseek-ai/cordis";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiHarnessLaunch, PiRuntimeService } from "./services.js";

export class PiHarnessStdioCancelledError extends Error {
  override readonly name = "PiHarnessStdioCancelledError";

  constructor() {
    super("Prompt input was cancelled");
  }
}

export interface PiHarnessStdio {
  readPrompt(): Promise<string>;
  writeOutput(text: string): void;
  writeError(text: string): void;
  /** Resolve once everything written so far has reached the underlying stream. */
  flush?(): Promise<void>;
}

export interface PiHarnessApplication {
  /**
   * Run the application surface to completion.
   *
   * @param signal - aborted when the host is shutting down; a surface that can block must unwind on it.
   */
  run(signal?: AbortSignal): Promise<number>;
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
  if (args[0] === "--") return args.length === 1 ? undefined : args.slice(1).join(" ");
  if (args[0] === "--prompt") {
    const prompt = args[1];
    if (prompt === undefined) throw new Error("--prompt requires a value");
    if (args.length > 2) throw new Error("--prompt accepts exactly one value");
    return prompt;
  }
  if (args[0]?.startsWith("--prompt=")) {
    if (args.length > 1) throw new Error("--prompt accepts exactly one value");
    return args[0].slice("--prompt=".length);
  }
  const option = args[0];
  if (option !== undefined && option.startsWith("-")) throw new Error(`Unknown stdio option: ${option}; pass -- before a prompt that starts with a dash`);
  return args.join(" ");
}

const PROMPT_CANCELLED_EXIT_CODE = 130;
const TOOL_ARGUMENT_SUMMARY_LIMIT = 120;

function summarizeToolArguments(args: unknown): string {
  let text: string;
  try {
    text = typeof args === "string" ? args : (JSON.stringify(args) ?? "");
  } catch {
    return "";
  }
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TOOL_ARGUMENT_SUMMARY_LIMIT ? `${line.slice(0, TOOL_ARGUMENT_SUMMARY_LIMIT)}...` : line;
}

export class StdioApplication implements PiHarnessApplication {
  readonly #runtime: PiRuntimeService;
  readonly #launch: PiHarnessLaunch;
  readonly #stdio: PiHarnessStdio;
  #running = false;
  #pendingSeparator = false;
  #wroteOutput = false;

  constructor(runtime: PiRuntimeService, launch: PiHarnessLaunch, stdio: PiHarnessStdio) {
    this.#runtime = runtime;
    this.#launch = launch;
    this.#stdio = stdio;
  }

  writeSessionEvent(event: AgentSessionEvent): void {
    if (!this.#running) return;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (this.#pendingSeparator) {
        this.#pendingSeparator = false;
        this.#stdio.writeOutput("\n");
      }
      this.#wroteOutput = true;
      this.#stdio.writeOutput(event.assistantMessageEvent.delta);
      return;
    }
    if (event.type === "tool_execution_start") {
      if (this.#wroteOutput) this.#pendingSeparator = true;
      this.#stdio.writeError(`> ${event.toolName} ${summarizeToolArguments(event.args)}\n`);
      return;
    }
    if (event.type === "tool_execution_end") {
      const result = event.result as { isError?: boolean } | undefined;
      if (result?.isError === true) this.#stdio.writeError(`! ${event.toolName} failed\n`);
      return;
    }
    if (event.type === "auto_retry_start") this.#stdio.writeError(`Retrying after ${event.errorMessage} (attempt ${event.attempt}/${event.maxAttempts})\n`);
  }

  async run(signal?: AbortSignal): Promise<number> {
    if (this.#running) throw new Error("stdio application is already running");
    this.#running = true;
    const onAbort = () => {
      void this.#runtime.abort().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted === true) return PROMPT_CANCELLED_EXIT_CODE;
      let prompt: string;
      try {
        prompt = promptFromArgs(this.#launch.args) ?? (await this.#stdio.readPrompt());
      } catch (error) {
        if (error instanceof PiHarnessStdioCancelledError) return PROMPT_CANCELLED_EXIT_CODE;
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
      const lastAssistantMessage = this.#runtime.session.messages.findLast((message) => message.role === "assistant");
      const stopReason = lastAssistantMessage?.stopReason;
      if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
        if (this.#wroteOutput) this.#stdio.writeOutput("\n");
        this.#stdio.writeError(
          `${lastAssistantMessage?.errorMessage ?? (stopReason === "length" ? "Response was truncated by the model's output limit" : `Request ${stopReason}`)}\n`,
        );
        return 1;
      }
      if (!this.#wroteOutput) {
        this.#stdio.writeError("The agent produced no output\n");
        return 1;
      }
      this.#stdio.writeOutput("\n");
      return 0;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#running = false;
      this.#pendingSeparator = false;
      await this.#stdio.flush?.();
    }
  }
}
