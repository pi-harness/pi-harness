import { Context } from "@deepseek-ai/cordis";

export interface ClientStatus {
  readonly status: string;
  readonly model: string;
  readonly messages: number;
  readonly cwd: string;
  readonly agentDir: string;
  readonly plugins: readonly string[];
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
  readonly nav: readonly HTMLButtonElement[];
  readonly viewHost: HTMLElement;
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

function readableContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (typeof part === "object" && part !== null) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
    return "";
  }).join("");
}

const shellPlugin = {
  name: "pi-client-shell",
  inject: ["clientRoot"],
  apply(context: Context) {
    const root = context.get("clientRoot");
    if (!(root instanceof HTMLElement)) throw new Error("Client root is not an HTMLElement");
    root.innerHTML = "<div class=\"shell\"><aside class=\"rail\"><div class=\"brand\">pi<span>/</span>harness</div><div class=\"eyebrow\">Control surfaces</div><nav><button class=\"nav active\">Runtime</button><button class=\"nav\">Profiles</button><button class=\"nav\">Extensions</button><button class=\"nav\">Sessions</button></nav><div class=\"rail-foot\">CORDIS / PI RUNTIME<br>ALL SYSTEMS ARE PLUGINS<br><span data-clock>--:--:--</span></div></aside><main class=\"main\"><header class=\"top\"><div><div class=\"kicker\">Live harness console</div><h1>Give the runtime a job.</h1><p>A browser surface for the Pi agent. Send a task, inspect the active session, and see the Cordis services behind it.</p></div><div class=\"pulse\" data-status-pill>connecting</div></header><section class=\"stats\"><div class=\"stat\"><small>RUNTIME</small><strong data-runtime>loading</strong></div><div class=\"stat\"><small>MODEL</small><strong data-model>loading</strong></div><div class=\"stat\"><small>SESSION</small><strong data-session-count>0 messages</strong></div><div class=\"stat\"><small>SURFACE</small><strong>web / cordis</strong></div></section><div class=\"workspace\"><section class=\"conversation\"><div class=\"panel-head\"><strong>Active conversation</strong><span data-state>ready</span></div><div class=\"messages\" data-messages><div class=\"empty\"><b>No prompts yet.</b>Send a prompt below. Responses appear here when the configured provider is ready.</div></div><form class=\"composer\" data-composer><textarea data-prompt aria-label=\"Prompt\" placeholder=\"Ask the agent to inspect, explain, or build…\" rows=\"1\"></textarea><button data-send type=\"submit\">Send prompt</button></form></section><aside class=\"inspector\"><div class=\"panel-head\"><strong>Service inspector</strong><span>CORDIS</span></div><dl><div><dt>loader</dt><dd>active</dd></div><div><dt>model runtime</dt><dd data-inspector-model>isolated</dd></div><div><dt>resources</dt><dd>loaded</dd></div><div><dt>tool registry</dt><dd>leased at run</dd></div><div><dt>transport</dt><dd>HTTP / JSON</dd></div><div><dt>cwd</dt><dd data-cwd>--</dd></div><div><dt>agent dir</dt><dd data-agent-dir>--</dd></div></dl><div class=\"tip\">The browser surface is a Cordis plugin tree. It shares the host runtime lifecycle instead of bypassing it.</div></aside></div></main></div>";
    const workspace = root.querySelector<HTMLElement>(".workspace");
    if (workspace === null) throw new Error("Client shell is missing .workspace");
    const viewHost = document.createElement("section");
    viewHost.className = "view-host";
    viewHost.hidden = true;
    viewHost.innerHTML = "<div class=\"view-panel\" data-view=\"profiles\"><div class=\"panel-head\"><strong>Active profile</strong><span>CORDIS YAML</span></div><div class=\"view-body profile-grid\"><div><small>PROFILE</small><strong>web / cordis.yml</strong></div><div><small>STORAGE</small><strong>JSONL sessions</strong></div><div><small>HOT RELOAD</small><strong>disabled in production</strong></div><div><small>MODEL</small><strong data-profile-model>loading</strong></div></div></div><div class=\"view-panel\" data-view=\"extensions\"><div class=\"panel-head\"><strong>Loaded plugins</strong><span data-plugin-count>0 active</span></div><div class=\"view-body plugin-list\" data-plugin-list></div></div><div class=\"view-panel\" data-view=\"sessions\"><div class=\"panel-head\"><strong>Session ledger</strong><span data-session-ledger>0 messages</span></div><div class=\"view-body session-list\" data-session-list><div class=\"empty\"><b>No session messages.</b>Start a prompt from Runtime.</div></div></div>";
    workspace.append(viewHost);
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
      nav: [...root.querySelectorAll<HTMLButtonElement>(".nav")],
      viewHost,
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
        const profileModel = context.clientSurface.root.querySelector("[data-profile-model]");
        const pluginList = context.clientSurface.root.querySelector("[data-plugin-list]");
        const pluginCount = context.clientSurface.root.querySelector("[data-plugin-count]");
        if (profileModel) profileModel.textContent = value.model;
        if (pluginCount) pluginCount.textContent = value.plugins.length + " active";
        if (pluginList) {
          pluginList.replaceChildren(...value.plugins.map((plugin) => {
            const item = document.createElement("div");
            item.className = "plugin-item";
            item.innerHTML = "<span class=\"plugin-dot\"></span><code></code>";
            const code = item.querySelector("code");
            if (code) code.textContent = plugin;
            return item;
          }));
        }
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
        const content = readableContent(value.content) || (typeof value.role === "string" ? value.role + " message" : "session message");
        element.textContent = content;
        context.clientSurface.messages.append(element);
      }
    }
    const ledger = context.clientSurface.root.querySelector("[data-session-ledger]");
    const list = context.clientSurface.root.querySelector("[data-session-list]");
    if (ledger) ledger.textContent = messages.length + " messages";
    if (list && messages.length > 0) {
      list.replaceChildren(...messages.map((message) => {
        const value = message as { role?: unknown; content?: unknown };
        const item = document.createElement("div");
        item.className = "session-item";
        const role = document.createElement("span");
        role.className = "session-role";
        role.textContent = typeof value.role === "string" ? value.role : "message";
        const content = document.createElement("span");
        content.textContent = readableContent(value.content) || "recorded event";
        item.append(role, content);
        return item;
      }));
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

const navigationPlugin = {
  name: "pi-client-navigation",
  inject: ["clientSurface"],
  apply(context: Context) {
    const surface = context.clientSurface;
    const runtimePanels = [...surface.root.querySelectorAll<HTMLElement>(".conversation, .inspector")];
    const views = [...surface.viewHost.querySelectorAll<HTMLElement>("[data-view]")];
    const title = surface.root.querySelector<HTMLElement>(".top h1");
    const subtitle = surface.root.querySelector<HTMLElement>(".top p");
    const runtimeCopy = { title: "Give the runtime a job.", subtitle: "Send a task, inspect the active session, and see the Cordis services behind it." };
    const copy: Record<string, { title: string; subtitle: string }> = {
      Runtime: runtimeCopy,
      Profiles: { title: "Know what is running.", subtitle: "The active profile is the composition contract for this browser session." },
      Extensions: { title: "Every surface is a plugin.", subtitle: "Inspect the live Cordis entry tree that powers this web console." },
      Sessions: { title: "Keep the thread visible.", subtitle: "Review the messages persisted by the active Pi session." },
    };
    const select = (name: string) => {
      const runtime = name === "Runtime";
      runtimePanels.forEach((panel) => { panel.hidden = !runtime; });
      surface.viewHost.hidden = runtime;
      views.forEach((view) => { view.hidden = view.dataset.view !== name.toLowerCase(); });
      const selectedCopy = copy[name] ?? runtimeCopy;
      if (title) title.textContent = selectedCopy.title;
      if (subtitle) subtitle.textContent = selectedCopy.subtitle;
      surface.nav.forEach((button) => {
        const active = button.textContent?.trim() === name;
        button.classList.toggle("active", active);
        button.setAttribute("aria-current", active ? "page" : "false");
      });
    };
    const listeners = surface.nav.map((button) => {
      const listener = () => select(button.textContent?.trim() ?? "Runtime");
      button.addEventListener("click", listener);
      return { button, listener };
    });
    select("Runtime");
    context.effect(() => () => listeners.forEach(({ button, listener }) => button.removeEventListener("click", listener)));
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
      this.context.plugin(navigationPlugin),
    ]);
  }

  async dispose(): Promise<void> {
    await this.context.fiber.dispose();
  }
}
