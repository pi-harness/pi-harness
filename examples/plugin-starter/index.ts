import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type {} from "@pi-harness/plugin-api";

const helloTool = defineTool({
  name: "example_hello",
  label: "Example hello",
  description: "Return a greeting from the example plugin.",
  parameters: Type.Object({}),
  execute() {
    return Promise.resolve({ content: [{ type: "text", text: "Hello from Pi Harness." }], details: undefined });
  },
});

export default {
  name: "example-plugin",
  inject: ["piTools"],
  apply(context: Context) {
    context.effect(() => context.piTools.register(helloTool));
  },
};
