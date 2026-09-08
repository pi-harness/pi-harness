import { isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { BoundedFileSizeError, BoundedFileTypeError, assertKnownConfigKeys, readBoundedFile, resolveExistingWorkspacePath } from "@pi-harness/plugin-api";

const maxBytes = 256 * 1024;
const maxPathLength = 512;

export type AtFileConfig = Record<never, never>;

export const Config: z<AtFileConfig> = z.object({});

function throwIfCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? new Error(signal.reason.message, { cause: signal.reason }) : new Error("File context operation was cancelled");
}

function fileContextParameters(value: unknown): { path: string } {
  if (value === null || typeof value !== "object") throw new Error("File context parameters must be a plain object");
  let descriptors: PropertyDescriptorMap;
  let prototype: unknown;
  let array: boolean;
  try {
    array = Array.isArray(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value) as unknown;
  } catch (error) {
    throw new Error("File context parameters must be an accessible plain object", { cause: error });
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) throw new Error("File context parameters must be a plain object");
  if (Reflect.ownKeys(descriptors).some((key) => key !== "path")) throw new Error("File context parameters must contain only path");
  const descriptor = descriptors.path;
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string")
    throw new Error("File context parameters must contain a path data property");
  const path = descriptor.value;
  if (path.trim() === "") throw new Error("File context parameters path must be a non-empty path");
  if (path !== path.trim()) throw new Error("File context parameters path must not have leading or trailing whitespace");
  if (path.length > maxPathLength || Buffer.byteLength(path, "utf8") > maxPathLength)
    throw new Error(`File context parameters path must be at most ${maxPathLength} characters and UTF-8 bytes`);
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path) || /^[\\/]{2}/u.test(path))
    throw new Error("File context parameters path must be relative to the current workspace");
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(path)) throw new Error("File context parameters path cannot contain Unicode control characters");
  return { path };
}

function escapeFileAttribute(value: string): string {
  return value.replace(/[&<>"'\r\n\t]/gu, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    if (character === "'") return "&#39;";
    if (character === "\r") return "&#13;";
    return character === "\n" ? "&#10;" : "&#9;";
  });
}

export default {
  name: "pi-at-file",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: AtFileConfig) {
    assertKnownConfigKeys("at-file", config, []);
    let lastFile: { path: string; bytes: number } | undefined;
    const readScope = () => {
      const session = context.get("piRuntime")?.session;
      return { session, manager: session?.sessionManager, id: session?.sessionId, cwd: session?.sessionManager.getCwd() ?? context.piHarnessLaunch.cwd };
    };
    let scope = readScope();
    const refreshScope = () => {
      const next = readScope();
      if (next.session !== scope.session || next.manager !== scope.manager || next.id !== scope.id || next.cwd !== scope.cwd) {
        scope = next;
        lastFile = undefined;
      }
      return scope;
    };
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort(new Error("At-file plugin was disposed")));
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "file_context",
        label: "File context",
        description: "Attach a bounded UTF-8 text file from the current workspace as untrusted model-context data.",
        promptSnippet: "attach a workspace text file as untrusted context data",
        parameters: Type.Object(
          { path: Type.String({ description: "File path relative to the workspace", minLength: 1, maxLength: maxPathLength }) },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<{ path: string; bytes: number }>> {
          throwIfCancelled(lifecycle.signal);
          const operationScope = refreshScope();
          const assertCurrent = () => {
            if (refreshScope() !== operationScope) throw new Error("File context workspace changed during attachment");
          };
          const params = fileContextParameters(rawParams);
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          throwIfCancelled(operationSignal);
          assertCurrent();
          let resolved: Awaited<ReturnType<typeof resolveExistingWorkspacePath>>;
          try {
            resolved = await resolveExistingWorkspacePath(operationScope.cwd, params.path, "File path must stay inside the current workspace");
          } catch (error) {
            throw new Error("Could not resolve context file inside the current workspace", { cause: error });
          }
          throwIfCancelled(operationSignal);
          assertCurrent();
          if (
            resolved.relativePath.trim() === "" ||
            resolved.relativePath !== resolved.relativePath.trim() ||
            resolved.relativePath.length > maxPathLength ||
            Buffer.byteLength(resolved.relativePath, "utf8") > maxPathLength ||
            /[\p{Cc}\p{Cf}\p{Cs}]/u.test(resolved.relativePath)
          )
            throw new Error("Resolved context file path is not safe to display");
          let source: Buffer;
          try {
            source = await readBoundedFile(resolved.target, maxBytes, "Context file");
          } catch (error) {
            if (error instanceof BoundedFileTypeError) throw new Error("Context path is not a file", { cause: error });
            if (error instanceof BoundedFileSizeError) throw new Error("Context file exceeds the 256 KiB attachment limit", { cause: error });
            throw new Error("Could not read context file", { cause: error });
          }
          throwIfCancelled(operationSignal);
          assertCurrent();
          if (source.includes(0)) throw new Error("Context file must be UTF-8 text without NUL bytes");
          const path = resolved.relativePath;
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(source);
          } catch (error) {
            throw new Error("Context file must contain valid UTF-8 text", { cause: error });
          }
          const wrappedText = text.replace(/<\/file(?=\s*>)/giu, "<\\/file");
          lastFile = { path, bytes: source.byteLength };
          return {
            content: [{ type: "text", text: `<file path="${escapeFileAttribute(path)}" untrusted="true">\n${wrappedText}\n</file>` }],
            details: { ...lastFile },
          };
        },
      }),
    );
    context.effect(() => unregisterTool);
    const disposePanel = context.piPluginUi.register({
      id: "at-file-panel",
      pluginId: "@pi-harness/plugin-at-file",
      title: "@file 上下文",
      description: "将工作区内的文本文件安全附加到当前对话。",
      icon: "⌁",
      read: () => {
        refreshScope();
        return { lastFile: lastFile === undefined ? null : { ...lastFile }, maxBytes };
      },
    });
    context.effect(() => disposePanel);
  },
};
