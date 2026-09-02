import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type ReadmeReport = { name: string; version: string; description: string; scripts: string[]; plugins: string[]; markdown: string };

async function generate(context: Context): Promise<ReadmeReport> {
  const path = join(context.piHarnessLaunch.cwd, "package.json");
  const source = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid package.json: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("package.json root must be an object");
  const packageJson = parsed as Record<string, unknown>;
  const name = typeof packageJson.name === "string" ? packageJson.name : "Unnamed project";
  const version = typeof packageJson.version === "string" ? packageJson.version : "unknown";
  const description = typeof packageJson.description === "string" ? packageJson.description : "";
  const scripts =
    packageJson.scripts !== null && typeof packageJson.scripts === "object" && !Array.isArray(packageJson.scripts)
      ? Object.keys(packageJson.scripts).sort()
      : [];
  const loader = context.get("loader") as { entries(): Iterable<{ disabled?: boolean | null; options: { name: string } }> } | undefined;
  const plugins =
    loader === undefined
      ? []
      : [...loader.entries()]
          .filter((entry) => !entry.disabled)
          .map((entry) => entry.options.name)
          .filter((plugin) => !plugin.startsWith("cordis:"))
          .sort();
  const markdown = [
    `# ${name}`,
    "",
    description,
    "",
    `Version: ${version}`,
    "",
    "## Scripts",
    "",
    ...(scripts.length ? scripts.map((script) => `- \`npm run ${script}\``) : ["- No npm scripts declared."]),
    "",
    "## Runtime plugins",
    "",
    ...(plugins.length ? plugins.map((plugin) => `- \`${plugin}\``) : ["- No runtime plugins reported."]),
    "",
  ].join("\n");
  return { name, version, description, scripts, plugins, markdown };
}

export default {
  name: "pi-readme-gen",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: ReadmeReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "readme_report",
        label: "README report",
        description: "Generate a Markdown project overview from the local package manifest and active Pi runtime plugins.",
        promptSnippet: "generate a project README overview",
        parameters: Type.Object({}),
        async execute(): Promise<AgentToolResult<ReadmeReport>> {
          latest = await generate(context);
          return { content: [{ type: "text", text: latest.markdown }], details: latest };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "readme-gen-panel",
      pluginId: "@pi-harness/core/plugins/readme-gen",
      title: "README Generator",
      description: "从当前项目清单生成可复制的 Markdown 概览，不会自动覆盖 README 文件。",
      icon: "▰",
      read: () =>
        latest === undefined ? { generated: false } : { generated: true, name: latest.name, scripts: latest.scripts.length, plugins: latest.plugins.length },
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
