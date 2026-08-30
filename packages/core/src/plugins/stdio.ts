import type { Context } from "@deepseek-ai/cordis";
import { StdioApplication } from "../stdio.js";

export default {
  name: "pi-stdio",
  inject: ["piRuntime", "piResources", "piHarnessStdio", "piHarnessLaunch"],
  apply(context: Context) {
    const application = new StdioApplication(context.piRuntime, context.piHarnessLaunch, context.piHarnessStdio);
    for (const diagnostic of context.piResources.diagnostics) {
      if (diagnostic.type !== "error") context.piHarnessStdio.writeError(`Resource ${diagnostic.type}: ${diagnostic.message}\n`);
    }
    context.on("pi/session-event", (event) => {
      application.writeSessionEvent(event);
    });
    context.on("pi/extension-error", (error) => {
      context.piHarnessStdio.writeError(`Extension error (${error.extensionPath}): ${error.error}\n`);
    });
    context.provide("piApplication", application);
  },
};
