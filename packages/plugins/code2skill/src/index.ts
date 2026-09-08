import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig, prepareWorkspaceFile, readBoundedFile, resolveExistingWorkspacePath } from "@pi-harness/plugin-api";

const maxFiles = 32;
const maxNameLength = 128;
const maxDescriptionLength = 1024;
const maxPathLength = 4096;
const maxFileBytes = 256 * 1024;
const maxTotalBytes = 2 * 1024 * 1024;
const parameterNames = new Set(["name", "description", "files"]);

type SkillFile = { path: string; bytes: number };
type SkillReport = { slug: string; directory: string; files: SkillFile[]; bytes: number };

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  if (slug.length === 0) throw new Error("Skill name must contain at least one ASCII letter or number");
  return slug;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Skill creation was cancelled", { cause: signal.reason });
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function parseParams(value: unknown): { name: string; description: string; files: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill parameters must be an object");
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Skill parameters must be a plain object");
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof Error && error.message === "Skill parameters must be a plain object") throw error;
    throw new Error("Skill parameters must be an accessible plain object", { cause: error });
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !parameterNames.has(key)))
    throw new Error("Skill parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Skill parameters must use data properties");
  const name: unknown = descriptors.name?.value;
  const description: unknown = descriptors.description?.value;
  const rawFiles: unknown = descriptors.files?.value;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > maxNameLength || name.includes("\0"))
    throw new Error(`Skill name must be non-blank text between 1 and ${maxNameLength} characters`);
  if (typeof description !== "string" || description.trim().length === 0 || description.length > maxDescriptionLength || description.includes("\0"))
    throw new Error(`Skill description must be non-blank text between 1 and ${maxDescriptionLength} characters`);
  if (!Array.isArray(rawFiles)) throw new Error(`Skill files must contain between 1 and ${maxFiles} source paths`);
  let fileDescriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (Object.getPrototypeOf(rawFiles) !== Array.prototype) throw new Error("Skill files must be a plain array");
    fileDescriptors = Object.getOwnPropertyDescriptors(rawFiles) as unknown as Record<PropertyKey, PropertyDescriptor>;
  } catch (error) {
    if (error instanceof Error && error.message === "Skill files must be a plain array") throw error;
    throw new Error("Skill files must be an accessible plain array", { cause: error });
  }
  const length: unknown = fileDescriptors.length?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length === 0 || length > maxFiles)
    throw new Error(`Skill files must contain between 1 and ${maxFiles} source paths`);
  if (Reflect.ownKeys(fileDescriptors).some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/u.test(key))))
    throw new Error("Skill files contain an unknown property");
  const files: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = fileDescriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) throw new Error("Skill files must be a dense array of data properties");
    const file: unknown = descriptor.value;
    if (typeof file !== "string" || file.trim().length === 0 || file.length > maxPathLength || hasControlCharacters(file))
      throw new Error(`Each skill file must be a non-empty relative path of at most ${maxPathLength} characters`);
    files.push(file);
  }
  return { name, description, files };
}

function markdownLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function markdownTarget(value: string): string {
  return value
    .split("/")
    .map((component) => encodeURIComponent(component).replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`))
    .join("/");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

async function assertSkillTargetAvailable(directory: string, slug: string, boundaryError: string): Promise<void> {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink()) throw new Error(boundaryError);
    throw new Error(`Skill pack already exists: ${slug}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function resolveWorkspaceFile(cwd: string, input: string): Promise<{ absolute: string; display: string }> {
  if (typeof input !== "string" || input.trim() === "" || isAbsolute(input)) throw new Error("Skill files must be non-empty relative paths");
  const resolved = await resolveExistingWorkspacePath(cwd, input, `Skill file must stay inside the workspace: ${input}`);
  if (resolved.relativePath === ".") throw new Error(`Skill file must stay inside the workspace: ${input}`);
  return { absolute: resolved.target, display: resolved.relativePath.split(sep).join("/") };
}

async function createSkill(cwd: string, params: { name: string; description: string; files: string[] }, assertCurrent: () => void): Promise<SkillReport> {
  assertCurrent();
  const displayName = params.name.trim().replace(/\s+/gu, " ");
  const slug = slugify(displayName);
  const description = params.description.trim();
  const sources = [];
  for (const file of params.files) {
    assertCurrent();
    sources.push(await resolveWorkspaceFile(cwd, file));
  }
  const unique = new Set(sources.map((source) => source.display));
  if (unique.size !== sources.length) throw new Error("Skill files must be unique");
  let bytes = 0;
  const loaded: Array<SkillFile & { content: Buffer }> = [];
  for (const source of sources) {
    assertCurrent();
    const content = await readBoundedFile(source.absolute, maxFileBytes, `Skill file ${source.display}`);
    bytes += content.byteLength;
    if (bytes > maxTotalBytes) throw new Error(`Skill sources exceed ${maxTotalBytes} bytes`);
    loaded.push({ path: source.display, bytes: content.byteLength, content });
  }
  const boundaryError = "Skill output path must stay inside the workspace and must not overwrite an existing skill";
  assertCurrent();
  const boundary = await prepareWorkspaceFile(cwd, join(".pi", "skills", ".code2skill-boundary"), boundaryError);
  assertCurrent();
  const skillsDirectory = dirname(boundary.target);
  const finalDirectory = join(skillsDirectory, slug);
  await assertSkillTargetAvailable(finalDirectory, slug, boundaryError);
  const files = loaded.map((file) => ({ path: file.path, bytes: file.bytes }));
  const references = files.map((file) => `- [${markdownLabel(file.path)}](references/${markdownTarget(file.path)})`).join("\n");
  const frontmatterDescription = description.replace(/\s+/gu, " ");
  const markdown = `---\nname: ${slug}\ndescription: ${JSON.stringify(frontmatterDescription)}\n---\n\n# ${displayName}\n\n${description}\n\n## Reference files\n\n${references}\n`;
  assertCurrent();
  const stagingDirectory = await mkdtemp(join(skillsDirectory, ".code2skill-"));
  try {
    for (const [index, file] of loaded.entries()) {
      assertCurrent();
      const target = join(stagingDirectory, "references", ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      assertCurrent();
      await writeFile(target, loaded[index]!.content, { flag: "wx", mode: 0o600 });
    }
    assertCurrent();
    await writeFile(join(stagingDirectory, "SKILL.md"), markdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
    assertCurrent();
    await assertSkillTargetAvailable(finalDirectory, slug, boundaryError);
    assertCurrent();
    await rename(stagingDirectory, finalDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  return { slug, directory: join(".pi", "skills", slug), files, bytes };
}

export default {
  name: "pi-code2skill",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    let creationQueue: Promise<void> = Promise.resolve();
    let generated = 0;
    let latest: SkillReport | undefined;
    const readScope = () => {
      const session = context.get("piRuntime")?.session;
      return { session, manager: session?.sessionManager, id: session?.sessionId, cwd: session?.sessionManager.getCwd() ?? context.piHarnessLaunch.cwd };
    };
    let scope = readScope();
    const refreshScope = () => {
      const next = readScope();
      if (next.session !== scope.session || next.manager !== scope.manager || next.id !== scope.id || next.cwd !== scope.cwd) {
        scope = next;
        latest = undefined;
        generated = 0;
      }
      return scope;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "skill_pack_create",
        label: "Create skill pack",
        description: "Package selected workspace source files into a local .pi/skills skill with a manifest and references.",
        promptSnippet: "turn selected project files into a reusable skill pack",
        parameters: Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: maxNameLength }),
            description: Type.String({ minLength: 1, maxLength: maxDescriptionLength }),
            files: Type.Array(Type.String({ minLength: 1, maxLength: maxPathLength, pattern: "^[^\\u0000-\\u001F\\u007F]+$" }), {
              minItems: 1,
              maxItems: maxFiles,
            }),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<SkillReport>> {
          throwIfAborted(lifecycle.signal);
          const operationScope = refreshScope();
          const validated = parseParams(params);
          const actionSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          const assertCurrent = () => {
            throwIfAborted(actionSignal);
            if (refreshScope() !== operationScope) throw new Error("Skill workspace changed during creation");
          };
          assertCurrent();
          const operation = creationQueue.then(async () => {
            const report = await createSkill(operationScope.cwd, validated, assertCurrent);
            assertCurrent();
            latest = report;
            generated += 1;
            return {
              content: [{ type: "text" as const, text: `Skill pack created: ${report.slug} (${report.files.length} file(s)).` }],
              details: structuredClone(report),
            };
          });
          creationQueue = operation.then(
            () => undefined,
            () => undefined,
          );
          return operation;
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "code2skill-panel",
      pluginId: "@pi-harness/plugin-code2skill",
      title: "Code2Skill",
      description: "把工作区代码打包为可复用的 Pi Skill，保留来源文件并生成 SKILL.md。",
      icon: "✦",
      read: () => {
        refreshScope();
        return { generated, latest: latest === undefined ? null : structuredClone(latest) };
      },
    });
    context.effect(() => () => {
      lifecycle.abort(new Error("Code2Skill plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
