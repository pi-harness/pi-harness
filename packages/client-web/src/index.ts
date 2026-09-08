import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { ControlRoomView } from "./react-room.js";
import { createClientApi, type ClientApi } from "./control-room.js";
import { activeLocale, readStoredLocale, resolveLocale, setLocale } from "./i18n.js";

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
  // The catalog is awaited before the first render so the console never paints in Chinese and then flips, and the stored choice wins over the browser's own preferences because it is the one the user made here.
  async run(): Promise<void> {
    await setLocale(readStoredLocale(globalThis.localStorage) ?? resolveLocale(navigator.languages));
    document.documentElement.lang = activeLocale();
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
