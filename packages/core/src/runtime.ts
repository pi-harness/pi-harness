import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { PiRuntimeService } from "./services.js";

export class PiRuntimeDisposedError extends Error {
  override readonly name = "PiRuntimeDisposedError";

  constructor() {
    super("Pi runtime is disposed");
  }
}

export class PiRuntime implements PiRuntimeService {
  readonly sessionRuntime: AgentSessionRuntime;
  #disposed = false;

  constructor(sessionRuntime: AgentSessionRuntime) {
    this.sessionRuntime = sessionRuntime;
  }

  get session(): AgentSession {
    return this.sessionRuntime.session;
  }

  async prompt(text: string): Promise<void> {
    if (this.#disposed) throw new PiRuntimeDisposedError();
    await this.sessionRuntime.session.prompt(text);
  }

  async abort(): Promise<void> {
    if (this.#disposed) return;
    await this.sessionRuntime.session.abort();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.sessionRuntime.dispose();
  }
}
