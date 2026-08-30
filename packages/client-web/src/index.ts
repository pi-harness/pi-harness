import { Context } from "@deepseek-ai/cordis";

export interface ClientStatus {
  readonly status: string;
  readonly model: string;
  readonly messages: number;
  readonly cwd: string;
  readonly agentDir: string;
}

export interface ClientApi {
  getStatus(): Promise<ClientStatus>;
  getSession(): Promise<{ messages: readonly unknown[] }>;
  prompt(value: string): Promise<{ reply: string; messages: number }>;
}

export interface ClientSurface {
  readonly root: HTMLElement;
  readonly statusPill: HTMLElement;
  readonly status: HTMLElement;
  readonly model: HTMLElement;
  readonly session: HTMLElement;
  readonly messages: HTMLElement;
  readonly composer: HTMLFormElement;
  readonly prompt: HTMLTextAreaElement;
  readonly send: HTMLButtonElement;
  readonly state: HTMLElement;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    clientRoot: HTMLElement;
    clientApi: ClientApi;
    clientSurface: ClientSurface;
  }
}

function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, init).then(async (response) => {
    const payload = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Request failed with status " + response.status);
    return payload;
  });
}

function createApi(): ClientApi {
  return {
    getStatus: () => requestJson<ClientStatus>("/api/status"),
    getSession: () => requestJson<{ messages: readonly unknown[] }>("/api/session"),
    prompt: (value) => requestJson<{ reply: string; messages: number }>("/api/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: value }) }),
  };
}

const shellPlugin = {
  name: "pi-client-shell",
  inject: ["clientRoot"],
  apply(context: Context) {
    const root = context.get("clientRoot");
    if (!(root instanceof HTMLElement)) throw new Error("Client root is not an HTMLElement");
    root.innerHTML = "<div class=\"shell\"><aside class=\"rail\"><div class=\"brand\">pi<span>/</span>harness</div><div class=\"eyebrow\">Control surfaces</div><nav><button class=\"nav active\">Runtime</button><button class=\"nav\">Profiles</button><button class=\"nav\">Extensions</button><button class=\"nav\">Sessions</button></nav><div class=\"rail-foot\">CORDIS / PI RUNTIME<br>ALL SYSTEMS ARE PLUGINS<br><span data-clock>--:--:--</span></div></aside><main class=\"main\"><header class=\"top\"><div><div class=\"kicker\">Live harness console</div><h1>Give the runtime a job.</h1><p>A browser surface for the Pi agent. Send a task, inspect the active session, and see the Cordis services behind it.</p></div><div class=\"pulse\" data-status-pill>connecting</div></header><section class=\"stats\"><div class=\"stat\"><small>RUNTIME</small><strong data-runtime>loading</strong></div><div class=\"stat\"><small>MODEL</small><strong data-model>loading</strong></div><div class=\"stat\"><small>SESSION</small><strong data-session-count>0 messages</strong></div><div class=\"stat\"><small>SURFACE</small><strong>web / cordis</strong></div></section><div class=\"workspace\"><section class=\"conversation\"><div class=\"panel-head\"><strong>Active conversation</strong><span data-state>ready</span></div><div class=\"messages\" data-messages><div class=\"empty\"><b>No prompts yet.</b>Send a prompt below. Responses appear here when the configured provider is ready.</div></div><form class=\"composer\" data-composer><textarea data-prompt aria-label=\"Prompt\" placeholder=\"Ask the agent to inspect, explain, or build…\" rows=\"1\"></textarea><button data-send type=\"submit\">Send prompt</button></form></section><aside class=\"inspector\"><div class=\"panel-head\"><strong>Service inspector</strong><span>CORDIS</span></div><dl><div><dt>loader</dt><dd>active</dd></div><div><dt>model runtime</dt><dd data-inspector-model>isolated</dd></div><div><dt>resources</dt><dd>loaded</dd></div><div><dt>tool registry</dt><dd>leased at run</dd></div><div><dt>transport</dt><dd>HTTP / JSON</dd></div><div><dt>cwd</dt><dd data-cwd>--</dd></div><div><dt>agent dir</dt><dd data-agent-dir>--</dd></div></dl><div class=\"tip\">The browser surface is a Cordis plugin tree. It shares the host runtime lifecycle instead of bypassing it.</div></aside></div></main></div>";
    const query = <T extends Element>(selector: string): T => {
      const element = root.querySelector<T>(selector);
      if (element === null) throw new Error("Client shell is missing " + selector);
      return element;
    };
    context.provide("clientSurface", {
      root,
      statusPill: query("[data-status-pill]"),
      status: query("[data-runtime]"),
      model: query("[data-model]"),
      session: query("[data-session-count]"),
      messages: query("[data-messages]"),
      composer: query("[data-composer]"),
      prompt: query("[data-prompt]"),
      send: query("[data-send]"),
      state: query("[data-state]"),
    });
  },
};

const statusPlugin = {
  name: "pi-client-status",
  inject: ["clientApi", "clientSurface"],
  apply(context: Context) {
    const update = async () => {
      try {
        const value = await context.clientApi.getStatus();
        context.clientSurface.statusPill.textContent = "online";
        context.clientSurface.statusPill.className = "pulse online";
        context.clientSurface.status.textContent = "ready";
        context.clientSurface.status.className = "good";
        context.clientSurface.model.textContent = value.model;
        context.clientSurface.session.textContent = value.messages + " messages";
        const inspectorModel = context.clientSurface.root.querySelector("[data-inspector-model]");
        const cwd = context.clientSurface.root.querySelector("[data-cwd]");
        const agentDir = context.clientSurface.root.querySelector("[data-agent-dir]");
        if (inspectorModel) inspectorModel.textContent = "isolated / " + value.model;
        if (cwd) cwd.textContent = value.cwd;
        if (agentDir) agentDir.textContent = value.agentDir;
      } catch (error) {
        context.clientSurface.statusPill.textContent = "offline";
        context.clientSurface.statusPill.className = "pulse offline";
        context.clientSurface.status.textContent = "offline";
        context.clientSurface.status.className = "error";
        context.clientSurface.state.textContent = error instanceof Error ? error.message : String(error);
      }
    };
    void update();
    const timer = window.setInterval(() => void update(), 5000);
    context.effect(() => () => window.clearInterval(timer));
  },
};

const conversationPlugin = {
  name: "pi-client-conversation",
  inject: ["clientApi", "clientSurface"],
  async apply(context: Context) {
    const session = await context.clientApi.getSession();
    const messages = session.messages;
    if (messages.length > 0) {
      context.clientSurface.messages.replaceChildren();
      for (const message of messages) {
        const value = message as { role?: unknown; content?: unknown };
        const element = document.createElement("div");
        element.className = "message " + (value.role === "user" ? "user" : "assistant");
        const content = typeof value.content === "string" ? value.content : typeof value.role === "string" ? value.role + " message" : "session message";
        element.textContent = content;
        context.clientSurface.messages.append(element);
      }
    }
  },
};

const composerPlugin = {
  name: "pi-client-composer",
  inject: ["clientApi", "clientSurface"],
  apply(context: Context) {
    const addMessage = (role: string, value: string) => {
      const empty = context.clientSurface.messages.querySelector(".empty");
      empty?.remove();
      const element = document.createElement("div");
      element.className = "message " + role;
      const label = document.createElement("span");
      label.className = "role";
      label.textContent = role === "user" ? "operator" : role;
      element.append(label, document.createTextNode(value));
      context.clientSurface.messages.append(element);
      context.clientSurface.messages.scrollTop = context.clientSurface.messages.scrollHeight;
    };
    const submit = (event: SubmitEvent) => {
      event.preventDefault();
      const value = context.clientSurface.prompt.value.trim();
      if (!value || context.clientSurface.send.disabled) return;
      addMessage("user", value);
      context.clientSurface.prompt.value = "";
      context.clientSurface.send.disabled = true;
      context.clientSurface.state.textContent = "thinking";
      void context.clientApi.prompt(value).then((result) => {
        addMessage("assistant", result.reply || "(empty response)");
        context.clientSurface.state.textContent = "ready";
        context.clientSurface.session.textContent = result.messages + " messages";
      }).catch((error: unknown) => {
        addMessage("error", error instanceof Error ? error.message : String(error));
        context.clientSurface.state.textContent = "error";
      }).finally(() => {
        context.clientSurface.send.disabled = false;
        context.clientSurface.prompt.focus();
      });
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        context.clientSurface.composer.requestSubmit();
      }
    };
    context.clientSurface.composer.addEventListener("submit", submit);
    context.clientSurface.prompt.addEventListener("keydown", keydown);
    context.effect(() => () => {
      context.clientSurface.composer.removeEventListener("submit", submit);
      context.clientSurface.prompt.removeEventListener("keydown", keydown);
    });
  },
};

const clockPlugin = {
  name: "pi-client-clock",
  inject: ["clientSurface"],
  apply(context: Context) {
    const clock = context.clientSurface.root.querySelector("[data-clock]");
    if (!(clock instanceof HTMLElement)) return;
    const update = () => { clock.textContent = new Date().toLocaleTimeString("en-GB"); };
    update();
    const timer = window.setInterval(update, 1000);
    context.effect(() => () => window.clearInterval(timer));
  },
};

export class AppWebEntry {
  readonly context: Context;
  readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.context = new Context();
  }

  async run(): Promise<void> {
    this.context.provide("clientRoot", this.root);
    this.context.provide("clientApi", createApi());
    await this.context.plugin(shellPlugin);
    await Promise.all([
      this.context.plugin(statusPlugin),
      this.context.plugin(conversationPlugin),
      this.context.plugin(composerPlugin),
      this.context.plugin(clockPlugin),
    ]);
  }

  async dispose(): Promise<void> {
    await this.context.fiber.dispose();
  }
}
