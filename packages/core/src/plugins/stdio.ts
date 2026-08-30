import type { Context } from "@deepseek-ai/cordis";
import { StdioApplication } from "../stdio.js";

export default {
  name: "pi-stdio",
  inject: ["piRuntime", "piHarnessStdio", "piHarnessLaunch"],
  apply(context: Context) {
    const application = new StdioApplication(context.piRuntime, context.piHarnessLaunch, context.piHarnessStdio);
    context.on("pi/session-event", (event) => {
      application.writeSessionEvent(event);
    });
    context.on("pi/extension-error", (error) => {
      context.piHarnessStdio.writeError(`Extension error (${error.extensionPath}): ${error.error}\n`);
    });
    context.provide("piApplication", application);
  },
};
