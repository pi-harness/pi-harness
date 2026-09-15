import type { AgentSession, AgentSessionRuntime, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { PiRuntimeService } from "@pi-harness/plugin-api";

export class PiRuntimeDisposedError extends Error {
  override readonly name = "PiRuntimeDisposedError";

  constructor() {
    super("Pi runtime is disposed");
  }
}

export class PiRuntime implements PiRuntimeService {
  readonly sessionRuntime: AgentSessionRuntime;
  readonly #defaultThinkingLevel: ModelThinkingLevel;
  #disposed = false;
  #sessionDisposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(sessionRuntime: AgentSessionRuntime, defaultThinkingLevel: ModelThinkingLevel = "medium") {
    this.sessionRuntime = sessionRuntime;
    this.#defaultThinkingLevel = defaultThinkingLevel;
  }

  get session(): AgentSession {
    return this.sessionRuntime.session;
  }

  async setModel(model: Model<Api>): Promise<void> {
    if (this.#disposed) throw new PiRuntimeDisposedError();
    const session = this.session;
    const shouldRestoreDefault =
      model.reasoning === true &&
      session.model?.reasoning !== true &&
      session.thinkingLevel === "off" &&
      session.settingsManager.getModelThinkingLevel(model.provider, model.id) === undefined &&
      session.settingsManager.getDefaultThinkingLevel() === undefined;
    await session.setModel(model);
    // A non-reasoning model can leave the session at `off`, which Pi may reuse on
    // the next switch even when no persisted preference requests it.
    if (shouldRestoreDefault && session.thinkingLevel === "off" && session.model?.provider === model.provider && session.model.id === model.id) {
      session.setThinkingLevel(this.#defaultThinkingLevel);
    }
  }

  async prompt(text: string, options?: Pick<PromptOptions, "streamingBehavior" | "preflightResult">): Promise<void> {
    if (this.#disposed) throw new PiRuntimeDisposedError();
    await this.session.prompt(text, options);
  }

  async abort(): Promise<void> {
    if (this.#sessionDisposed) return;
    await this.session.abort();
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = this.#disposeSession();
    return this.#disposePromise;
  }

  async #disposeSession(): Promise<void> {
    try {
      // Settle an in-flight turn first so its tool results are persisted before session_shutdown runs.
      if (!this.session.isIdle) await this.session.abort();
    } finally {
      this.#sessionDisposed = true;
      await this.sessionRuntime.dispose();
    }
  }
}
