import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiRuntimeService } from "./services.js";

export class PiRuntimeDisposedError extends Error {
  override readonly name = "PiRuntimeDisposedError";

  constructor() {
    super("Pi runtime is disposed");
  }
}

export class PiRuntime implements PiRuntimeService {
  readonly session: AgentSession;
  #disposed = false;
  #sessionDisposed = false;

  constructor(session: AgentSession) {
    this.session = session;
  }

  async prompt(text: string): Promise<void> {
    if (this.#disposed) throw new PiRuntimeDisposedError();
    await this.session.prompt(text);
  }

  async abort(): Promise<void> {
    if (this.#sessionDisposed) return;
    await this.session.abort();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      if (!this.session.isIdle) await this.session.abort();
      const runner = this.session.extensionRunner;
      if (runner.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      this.#sessionDisposed = true;
      this.session.dispose();
    }
  }
}
