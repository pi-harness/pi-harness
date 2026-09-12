import type { Context } from "@deepseek-ai/cordis";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiHarnessLaunch, PiRuntimeService } from "@pi-harness/plugin-api";

export class PiHarnessStdioCancelledError extends Error {
  override readonly name = "PiHarnessStdioCancelledError";

  constructor() {
    super("Prompt input was cancelled");
  }
}

export const MAX_STDIO_PROMPT_BYTES = 1_048_576;

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
const TOOL_ARGUMENT_STRING_LIMIT = 512;
const TOOL_ARGUMENT_PROPERTY_LIMIT = 16;
const TOOL_ARGUMENT_DEPTH_LIMIT = 4;
const TOOL_ARGUMENT_NODE_LIMIT = 64;
const TOOL_NAME_LIMIT = 128;
const DIAGNOSTIC_MESSAGE_LIMIT = 2_048;
const SESSION_MESSAGE_SCAN_LIMIT = 10_000;

type PreviewState = { remaining: number; readonly seen: WeakSet<object> };

function dataProperty(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

// Whitespace collapses first so a line break still becomes a separator. What remains to neutralize is provider- or extension-controlled text that changes the terminal's state rather than its content: C0/C1 controls and DEL (\p{Cc}, which is what carries ESC, CSI and BEL) plus the bidi controls that reorder an already-printed line. Other format characters are left alone because they are ordinary text - ZWJ holds emoji sequences together, and stripping them would corrupt the message this is trying to show.
function singleLine(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, "�")
    .trim();
}

/** Collapse an untrusted diagnostic to one terminal-safe line of at most `limit` characters. */
export function boundedLine(value: string, limit: number): string {
  return singleLine(value.length <= limit ? value : value.slice(0, limit - 1) + "…");
}

function failureMessage(value: unknown, fallback: string): string {
  const rawMessage = typeof value === "string" ? value : dataProperty(value, "message");
  return typeof rawMessage === "string" ? boundedLine(rawMessage, DIAGNOSTIC_MESSAGE_LIMIT) || fallback : fallback;
}

// Pi reports a missing credential with its own remedy, "Use /login", but this launcher reads one prompt and exits and has no slash commands at all, so the harness follows that line with instructions it can actually honour.
const MISSING_CREDENTIAL_PATTERN = /No API key found|Authentication failed for/u;

// The same line also carries Pi's own remedy and its own doc pointer, "Use /login … See: <absolute path inside node_modules>". Neither survives here: the remedy names a command this launcher does not have, and the path points inside a dependency the user never installed by hand. Only the factual half of the line is kept, and the guidance below replaces the rest.
const UPSTREAM_CREDENTIAL_REMEDY_PATTERN = /\s*(?:Use \/login\b|See:\s).*$/su;

function withoutUpstreamCredentialRemedy(message: string): string {
  return message.replace(UPSTREAM_CREDENTIAL_REMEDY_PATTERN, "").trimEnd() || message;
}

// The guidance is fixed rather than assembled from the provider named upstream so that it stays one bounded, terminal-safe line like every other diagnostic this surface writes. The profile path is the one that was actually booted when the launcher knows it, because telling someone to edit `<PI_HARNESS_HOME or ~/.pi-harness>/profiles/<profile>/cordis.yml` asks them to resolve two placeholders the harness already resolved.
function missingCredentialGuidance(launch: PiHarnessLaunch): string {
  const profilePath = launch.configPath ?? "the booted profile under <PI_HARNESS_HOME or ~/.pi-harness>/profiles";
  return boundedLine(
    `pih has no /login command: set the DEEPSEEK_API_KEY environment variable (the built-in profile selects deepseek), or store the credential in ${launch.agentDir}/auth.json, or start through \`everyapi use pi-web\`, or edit ${profilePath} to name a provider that agent directory already registers.`,
    DIAGNOSTIC_MESSAGE_LIMIT,
  );
}

function isPromptCancellation(value: unknown): boolean {
  return dataProperty(value, "name") === "PiHarnessStdioCancelledError";
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function toolArgumentPreview(value: unknown, state: PreviewState, depth = 0): unknown {
  if (state.remaining <= 0) return "[Truncated]";
  state.remaining -= 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, TOOL_ARGUMENT_STRING_LIMIT);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[Undefined]";
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return "[Symbol]";
  if (typeof value !== "object") return "[Unknown]";
  if (depth >= TOOL_ARGUMENT_DEPTH_LIMIT) return "[Max Depth]";
  if (state.seen.has(value)) return "[Circular]";
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const length = dataProperty(value, "length");
      const arrayLength = typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : 0;
      const output: unknown[] = [];
      for (let index = 0; index < Math.min(arrayLength, TOOL_ARGUMENT_PROPERTY_LIMIT); index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        output.push(
          descriptor === undefined ? null : "value" in descriptor ? toolArgumentPreview(descriptor.value as unknown, state, depth + 1) : "[Accessor]",
        );
      }
      if (arrayLength > TOOL_ARGUMENT_PROPERTY_LIMIT) output.push(`[${arrayLength - TOOL_ARGUMENT_PROPERTY_LIMIT} more items]`);
      return output;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const output: Record<string, unknown> = {};
    let properties = 0;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === "__proto__" || descriptor.enumerable !== true) continue;
      if (properties >= TOOL_ARGUMENT_PROPERTY_LIMIT) {
        output["…"] = "[More properties]";
        break;
      }
      output[key.slice(0, TOOL_ARGUMENT_STRING_LIMIT)] =
        "value" in descriptor ? toolArgumentPreview(descriptor.value as unknown, state, depth + 1) : "[Accessor]";
      properties += 1;
    }
    return properties === 0 ? "[Object]" : output;
  } catch {
    return "[Unavailable]";
  }
}

function findLastAssistantMessage(messages: unknown): unknown {
  const length = dataProperty(messages, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length <= 0) return undefined;
  const firstIndex = Math.max(0, length - SESSION_MESSAGE_SCAN_LIMIT);
  for (let index = length - 1; index >= firstIndex; index -= 1) {
    const message = dataProperty(messages, String(index));
    if (dataProperty(message, "role") === "assistant") return message;
  }
  return undefined;
}

function summarizeToolArguments(args: unknown): string {
  let text: string;
  try {
    const preview = toolArgumentPreview(args, { remaining: TOOL_ARGUMENT_NODE_LIMIT, seen: new WeakSet<object>() });
    text = typeof preview === "string" ? preview : (JSON.stringify(preview) ?? "");
  } catch {
    return "";
  }
  const line = singleLine(text);
  return line.length > TOOL_ARGUMENT_SUMMARY_LIMIT ? `${line.slice(0, TOOL_ARGUMENT_SUMMARY_LIMIT)}...` : line;
}

export class StdioApplication implements PiHarnessApplication {
  readonly #runtime: PiRuntimeService;
  readonly #launch: PiHarnessLaunch;
  readonly #stdio: PiHarnessStdio;
  #running = false;
  #pendingSeparator = false;
  #wroteOutput = false;
  #outputEndsWithNewline = false;

  constructor(runtime: PiRuntimeService, launch: PiHarnessLaunch, stdio: PiHarnessStdio) {
    this.#runtime = runtime;
    this.#launch = launch;
    this.#stdio = stdio;
  }

  /** Writes one failure line, and for a missing credential swaps Pi's remedy for the one this launcher can honour rather than printing both and contradicting itself. */
  #writeFailure(message: string): void {
    if (!MISSING_CREDENTIAL_PATTERN.test(message)) {
      this.#stdio.writeError(`${message}\n`);
      return;
    }
    this.#stdio.writeError(`${withoutUpstreamCredentialRemedy(message)}\n`);
    this.#stdio.writeError(`${missingCredentialGuidance(this.#launch)}\n`);
  }

  writeSessionEvent(event: AgentSessionEvent): void {
    if (!this.#running) return;
    const eventType = dataProperty(event, "type");
    const assistantEvent = eventType === "message_update" ? dataProperty(event, "assistantMessageEvent") : undefined;
    if (dataProperty(assistantEvent, "type") === "text_delta") {
      const delta = dataProperty(assistantEvent, "delta");
      if (typeof delta !== "string" || delta === "") return;
      if (this.#pendingSeparator) {
        this.#pendingSeparator = false;
        if (!this.#outputEndsWithNewline) this.#stdio.writeOutput("\n");
      }
      this.#wroteOutput = true;
      this.#outputEndsWithNewline = delta.endsWith("\n");
      this.#stdio.writeOutput(delta);
      return;
    }
    if (eventType === "tool_execution_start") {
      const rawToolName = dataProperty(event, "toolName");
      const toolName = typeof rawToolName === "string" ? boundedLine(rawToolName, TOOL_NAME_LIMIT) : "";
      if (toolName === "") return;
      if (this.#wroteOutput) this.#pendingSeparator = true;
      this.#stdio.writeError(`> ${toolName} ${summarizeToolArguments(dataProperty(event, "args"))}\n`);
      return;
    }
    if (eventType === "tool_execution_end") {
      const rawToolName = dataProperty(event, "toolName");
      const toolName = typeof rawToolName === "string" ? boundedLine(rawToolName, TOOL_NAME_LIMIT) : "";
      if (toolName !== "" && dataProperty(event, "isError") === true) this.#stdio.writeError(`! ${toolName} failed\n`);
      return;
    }
    if (eventType === "auto_retry_start") {
      const rawMessage = dataProperty(event, "errorMessage");
      const message = typeof rawMessage === "string" ? boundedLine(rawMessage, DIAGNOSTIC_MESSAGE_LIMIT) : "";
      const attempt = dataProperty(event, "attempt");
      const maxAttempts = dataProperty(event, "maxAttempts");
      if (
        message !== "" &&
        typeof attempt === "number" &&
        Number.isSafeInteger(attempt) &&
        attempt >= 1 &&
        typeof maxAttempts === "number" &&
        Number.isSafeInteger(maxAttempts) &&
        maxAttempts >= attempt
      )
        this.#stdio.writeError(`Retrying after ${message} (attempt ${attempt}/${maxAttempts})\n`);
    }
  }

  async #readPrompt(signal: AbortSignal | undefined): Promise<string> {
    if (signal === undefined) return await this.#stdio.readPrompt();
    if (signal.aborted) throw new PiHarnessStdioCancelledError();
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<string>((_resolve, reject) => {
      cancel = () => reject(new PiHarnessStdioCancelledError());
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      return await Promise.race([this.#stdio.readPrompt(), cancelled]);
    } finally {
      if (cancel !== undefined) signal.removeEventListener("abort", cancel);
    }
  }

  async #prompt(prompt: string, signal: AbortSignal | undefined): Promise<void> {
    const request = this.#runtime.prompt(prompt);
    if (signal === undefined) return await request;
    if (signal.aborted) {
      void request.catch(() => {});
      throw new PiHarnessStdioCancelledError();
    }
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<void>((_resolve, reject) => {
      cancel = () => reject(new PiHarnessStdioCancelledError());
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      return await Promise.race([request, cancelled]);
    } finally {
      if (cancel !== undefined) signal.removeEventListener("abort", cancel);
    }
  }

  async run(signal?: AbortSignal): Promise<number> {
    if (this.#running) throw new Error("stdio application is already running");
    this.#running = true;
    this.#pendingSeparator = false;
    this.#wroteOutput = false;
    this.#outputEndsWithNewline = false;
    const onAbort = () => {
      try {
        void this.#runtime.abort().catch(() => {});
      } catch {
        // The signal still cancels this surface even if the runtime abort hook is already unavailable.
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signalIsAborted(signal)) return PROMPT_CANCELLED_EXIT_CODE;
      let prompt: string;
      try {
        prompt = promptFromArgs(this.#launch.args) ?? (await this.#readPrompt(signal));
      } catch (error) {
        if (isPromptCancellation(error)) return PROMPT_CANCELLED_EXIT_CODE;
        this.#stdio.writeError(`${failureMessage(error, "Could not read prompt input")}\n`);
        return 2;
      }
      if (Buffer.byteLength(prompt, "utf8") > MAX_STDIO_PROMPT_BYTES) {
        this.#stdio.writeError(`Prompt must be at most ${MAX_STDIO_PROMPT_BYTES} UTF-8 bytes\n`);
        return 2;
      }
      if (prompt.trim().length === 0) {
        this.#stdio.writeError("Prompt is empty\n");
        return 2;
      }
      try {
        await this.#prompt(prompt, signal);
      } catch (error) {
        if (signalIsAborted(signal)) {
          if (this.#wroteOutput && !this.#outputEndsWithNewline) this.#stdio.writeOutput("\n");
          return PROMPT_CANCELLED_EXIT_CODE;
        }
        this.#writeFailure(failureMessage(error, "Agent request failed"));
        return 1;
      }
      if (signalIsAborted(signal)) {
        if (this.#wroteOutput && !this.#outputEndsWithNewline) this.#stdio.writeOutput("\n");
        return PROMPT_CANCELLED_EXIT_CODE;
      }
      let lastAssistantMessage: unknown;
      try {
        lastAssistantMessage = findLastAssistantMessage(this.#runtime.session.messages);
      } catch (error) {
        if (this.#wroteOutput && !this.#outputEndsWithNewline) this.#stdio.writeOutput("\n");
        this.#stdio.writeError(`${failureMessage(error, "Could not inspect final agent response")}\n`);
        return 1;
      }
      if (lastAssistantMessage === undefined) {
        if (this.#wroteOutput && !this.#outputEndsWithNewline) this.#stdio.writeOutput("\n");
        this.#stdio.writeError("Could not determine the final assistant response\n");
        return 1;
      }
      const stopReason = dataProperty(lastAssistantMessage, "stopReason");
      if (stopReason !== "stop" && stopReason !== "error" && stopReason !== "aborted" && stopReason !== "length") {
        if (this.#wroteOutput && !this.#outputEndsWithNewline) this.#stdio.writeOutput("\n");
        this.#stdio.writeError("Could not determine the final assistant stop reason\n");
        return 1;
      }
      if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
        if (this.#wroteOutput && !this.#outputEndsWithNewline) this.#stdio.writeOutput("\n");
        const rawErrorMessage = dataProperty(lastAssistantMessage, "errorMessage");
        const fallback = stopReason === "length" ? "Response was truncated by the model's output limit" : `Request ${stopReason}`;
        const errorMessage = typeof rawErrorMessage === "string" ? boundedLine(rawErrorMessage, DIAGNOSTIC_MESSAGE_LIMIT) || fallback : fallback;
        this.#writeFailure(errorMessage);
        return 1;
      }
      if (!this.#wroteOutput) {
        this.#stdio.writeError("The agent produced no output\n");
        return 1;
      }
      if (!this.#outputEndsWithNewline) this.#stdio.writeOutput("\n");
      return 0;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#running = false;
      this.#pendingSeparator = false;
      this.#outputEndsWithNewline = false;
      await this.#stdio.flush?.();
    }
  }
}
