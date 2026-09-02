import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxFiles = 32;
const maxFileBytes = 256 * 1024;
const maxTotalBytes = 2 * 1024 * 1024;

type SkillFile = { path: string; bytes: number };
type SkillReport = { slug: string; directory: string; files: SkillFile[]; bytes: number };

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  if (slug.length === 0) throw new Error("Skill name must contain at least one letter or number");
  return slug;
}

function resolveWorkspaceFile(cwd: string, input: string): { absolute: string; display: string } {
  if (typeof input !== "string" || input.trim() === "" || isAbsolute(input)) throw new Error("Skill files must be non-empty relative paths");
  const absolute = resolve(cwd, input);
  const display = relative(cwd, absolute);
  if (display === "" || display.startsWith("..") || isAbsolute(display)) throw new Error(`Skill file must stay inside the workspace: ${input}`);
  return { absolute, display };
}

async function createSkill(context: Context, params: { name: string; description: string; files: string[] }): Promise<SkillReport> {
  if (!Array.isArray(params.files) || params.files.length === 0) throw new Error("At least one source file is required");
  if (params.files.length > maxFiles) throw new Error(`A skill can include at most ${maxFiles} files`);
  const cwd = context.piHarnessLaunch.cwd;
  const slug = slugify(params.name);
  const sources = params.files.map((file) => resolveWorkspaceFile(cwd, file));
  const unique = new Set(sources.map((source) => source.display));
  if (unique.size !== sources.length) throw new Error("Skill files must be unique");
  let bytes = 0;
  const files: SkillFile[] = [];
  const output = join(cwd, ".pi", "skills", slug);
  for (const source of sources) {
    const content = await readFile(source.absolute);
    if (content.byteLength > maxFileBytes) throw new Error(`Skill file exceeds ${maxFileBytes} bytes: ${source.display}`);
    bytes += content.byteLength;
    if (bytes > maxTotalBytes) throw new Error(`Skill sources exceed ${maxTotalBytes} bytes`);
    const target = join(output, "references", source.display);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content);
    files.push({ path: source.display, bytes: content.byteLength });
  }
  const description = params.description.trim();
  if (description.length === 0) throw new Error("Skill description must not be empty");
  const references = files.map((file) => `- [${file.path}](references/${file.path})`).join("\n");
  const markdown = `---\nname: ${slug}\ndescription: ${description.replaceAll("\n", " ")}\n---\n\n# ${params.name.trim()}\n\n${description}\n\n## Reference files\n\n${references}\n`;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "SKILL.md"), markdown, "utf8");
  return { slug, directory: output, files, bytes };
}

export default {
  name: "pi-code2skill",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  apply(context: Context) {
    let generated = 0;
    let latest: SkillReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "skill_pack_create",
        label: "Create skill pack",
        description: "Package selected workspace source files into a local .pi/skills skill with a manifest and references.",
        promptSnippet: "turn selected project files into a reusable skill pack",
        parameters: Type.Object({ name: Type.String(), description: Type.String(), files: Type.Array(Type.String()) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<SkillReport>> {
          latest = await createSkill(context, params);
          generated += 1;
          return { content: [{ type: "text", text: `Skill pack created: ${latest.slug} (${latest.files.length} file(s)).` }], details: latest };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "code2skill-panel",
      pluginId: "@pi-harness/core/plugins/code2skill",
      title: "Code2Skill",
      description: "把工作区代码打包为可复用的 Pi Skill，保留来源文件并生成 SKILL.md。",
      icon: "✦",
      read: () => ({ generated, latest: latest ?? null }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
