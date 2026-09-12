import type { AgentSession, AgentSessionRuntime, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { PiRuntimeService } from "@pi-harness/plugin-api";

export class PiRuntimeDisposedError extends Error {
  override readonly name = "PiRuntimeDisposedError";

  constructor() {
    super("Pi runtime is disposed");
  }
}

export class PiRuntime implements PiRuntimeService {
  readonly sessionRuntime: AgentSessionRuntime;
  #disposed = false;
  #sessionDisposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(sessionRuntime: AgentSessionRuntime) {
    this.sessionRuntime = sessionRuntime;
  }

  get session(): AgentSession {
    return this.sessionRuntime.session;
  }

  async prompt(text: string, options?: Pick<PromptOptions, "streamingBehavior">): Promise<void> {
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
