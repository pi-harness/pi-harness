import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

export type ReadmeMetadata = { name: string; version: string; description: string; scripts: string[]; plugins: string[] };
export type ReadmeReport = ReadmeMetadata & { markdown: string };
export type ReadmeWriteReport = { path: string; bytes: number; overwritten: boolean };

export function renderReadme(metadata: ReadmeMetadata): string {
  const { name, version, description, scripts, plugins } = metadata;
  return [
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
}

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
  const metadata = { name, version, description, scripts, plugins };
  return { ...metadata, markdown: renderReadme(metadata) };
}

function outputPath(root: string, requested: string): string {
  const value = requested.trim() || "README.generated.md";
  if (value.length > 512 || value.includes("\\")) throw new Error("README output path must be a relative POSIX path of at most 512 characters");
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, value);
  const remainder = relative(resolvedRoot, target);
  if (remainder === ".." || remainder.startsWith(`..${"/"}`) || remainder.startsWith("/")) throw new Error("README output path must stay inside the workspace");
  return target;
}

export async function writeReadmeFile(root: string, markdown: string, requestedPath: string, confirm: boolean): Promise<ReadmeWriteReport> {
  if (!confirm) throw new Error("Writing a README requires confirm=true");
  const workspace = await realpath(resolve(root));
  const target = outputPath(workspace, requestedPath);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const parentRemainder = relative(workspace, realParent);
  if (parentRemainder === ".." || parentRemainder.startsWith(`..${"/"}`) || parentRemainder.startsWith("/"))
    throw new Error("README output path must stay inside the workspace");
  let overwritten = false;
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("README output path must be a regular file and cannot be a symbolic link");
    overwritten = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, markdown, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  return { path: relative(workspace, target), bytes: Buffer.byteLength(markdown, "utf8"), overwritten };
}

export default {
  name: "pi-readme-gen",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: ReadmeReport | undefined;
    let lastWrite: ReadmeWriteReport | undefined;
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
    const unregisterWrite = context.piTools.register(
      defineTool({
        name: "readme_write",
        label: "Write README",
        description: "Write the generated Markdown to a workspace file only after explicit confirmation; defaults to README.generated.md.",
        promptSnippet: "write the generated README to a confirmed workspace path",
        parameters: Type.Object({ outputPath: Type.Optional(Type.String()), confirm: Type.Boolean() }),
        async execute(_toolCallId, params): Promise<AgentToolResult<ReadmeWriteReport>> {
          const report = latest ?? (latest = await generate(context));
          lastWrite = await writeReadmeFile(context.piHarnessLaunch.cwd, report.markdown, params.outputPath ?? "README.generated.md", params.confirm);
          return { content: [{ type: "text", text: `README written: ${lastWrite.path} (${lastWrite.bytes} bytes)` }], details: lastWrite };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "readme-gen-panel",
      pluginId: "@pi-harness/core/plugins/readme-gen",
      title: "README Generator",
      description: "从当前项目清单生成 Markdown 概览；写入文件需要显式确认，默认不会覆盖 README。",
      icon: "▰",
      read: () =>
        latest === undefined
          ? { generated: false, lastWrite: lastWrite ?? null }
          : { generated: true, name: latest.name, scripts: latest.scripts.length, plugins: latest.plugins.length, lastWrite: lastWrite ?? null },
    });
    context.effect(() => () => {
      unregisterTool();
      unregisterWrite();
      disposePanel();
    });
  },
};
