import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

const mimeByExtension: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export default {
  name: "pi-modlens",
  inject: ["piHarnessLaunch", "piTools", "piPluginUi"],
  apply(context: Context) {
    let lastImage: { path: string; mimeType: string; bytes: number } | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "vision_inspect",
        label: "Vision inspect",
        description: "Attach a local image from the current workspace so a vision-capable model can inspect it.",
        promptSnippet: "attach a local image for visual inspection",
        parameters: Type.Object({ path: Type.String({ description: "Image path relative to the workspace" }) }),
        async execute(_toolCallId, params) {
          const workspace = resolve(context.piHarnessLaunch.cwd);
          const target = resolve(workspace, params.path);
          const relativePath = relative(workspace, target);
          if (relativePath.startsWith("..") || relativePath.includes("/..")) throw new Error("Image path must stay inside the current workspace");
          const mimeType = mimeByExtension[extname(target).toLowerCase()];
          if (mimeType === undefined) throw new Error("Unsupported image type; use png, jpeg, gif, or webp");
          const metadata = await stat(target);
          if (!metadata.isFile()) throw new Error("Image path is not a file");
          if (metadata.size > 10 * 1024 * 1024) throw new Error("Image exceeds the 10 MiB attachment limit");
          const data = (await readFile(target)).toString("base64");
          lastImage = { path: relativePath || ".", mimeType, bytes: metadata.size };
          return {
            content: [{ type: "image", data, mimeType }],
            details: lastImage,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "modlens-panel",
      pluginId: "@pi-harness/core/plugins/modlens",
      title: "视觉桥接",
      description: "将工作区内的图片安全附加到当前对话，交由支持视觉的模型分析。",
      icon: "◉",
      read: () => ({
        attached: lastImage !== undefined,
        image: lastImage ?? null,
        supportedTypes: Object.keys(mimeByExtension).map((extension) => extension.slice(1)),
      }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
