export const plugin = (ctx: any) => {
  ctx.registerTool({
    name: "example_hello",
    description: "Return a greeting from the example plugin.",
    parameters: {},
    async execute() {
      return { content: [{ type: "text", text: "Hello from Pi Harness." }] };
    },
  });
};
