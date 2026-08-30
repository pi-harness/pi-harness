import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type {} from "@pi-harness/core";

export const helloTool = defineTool({
  name: "hello",
  label: "Hello",
  description: "Greet a person by name.",
  parameters: Type.Object({
    name: Type.String({ description: "The name to greet." }),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `Hello, ${params.name}!` }],
      details: undefined,
    };
  },
});

export default {
  name: "pi-hello",
  inject: ["piTools"],
  apply(context: Context) {
    context.effect(() => context.piTools.register(helloTool));
  },
};
