import type { PluginContext } from "@pi-harness/plugin-api";

export const plugin = (ctx: PluginContext) => {
  ctx.registerTool({
    name: "example_hello",
    description: "Return a greeting from the example plugin.",
    parameters: {},
    execute() {
      return Promise.resolve({ content: [{ type: "text", text: "Hello from Pi Harness." }] });
    },
  });
};
