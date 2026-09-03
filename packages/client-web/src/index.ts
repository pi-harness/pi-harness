import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { ControlRoomView } from "./react-room.js";
import { createClientApi, type ClientApi } from "./control-room.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    clientRoot: HTMLElement;
    clientApi: ClientApi;
  }
}

export class AppWebEntry {
  readonly context: Context;
  readonly root: HTMLElement;
  readonly version?: string;
  #reactRoot?: Root;
  constructor(root: HTMLElement, options: { readonly version?: string } = {}) {
    this.root = root;
    this.version = options.version;
    this.context = new Context();
  }
  run(): void {
    this.context.provide("clientRoot", this.root);
    this.context.provide("clientApi", createClientApi());
    this.#reactRoot = createRoot(this.root);
    this.#reactRoot.render(createElement(ControlRoomView, { api: this.context.clientApi, appVersion: this.version }));
  }
  async dispose(): Promise<void> {
    this.#reactRoot?.unmount();
    await this.context.fiber.dispose();
  }
}
