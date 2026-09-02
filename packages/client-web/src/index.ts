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
  #reactRoot?: Root;
  constructor(root: HTMLElement) {
    this.root = root;
    this.context = new Context();
  }
  run(): void {
    this.context.provide("clientRoot", this.root);
    this.context.provide("clientApi", createClientApi());
    this.#reactRoot = createRoot(this.root);
    this.#reactRoot.render(createElement(ControlRoomView, { api: this.context.clientApi }));
  }
  async dispose(): Promise<void> {
    this.#reactRoot?.unmount();
    await this.context.fiber.dispose();
  }
}
