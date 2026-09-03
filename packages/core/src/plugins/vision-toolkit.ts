import { readdir, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { resolveExistingWorkspacePath } from "../workspace-path.js";

const maxImages = 100;
const maxImageBytes = 20 * 1024 * 1024;
const mimeByExtension: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const skippedDirectories = new Set([".git", "node_modules"]);

export interface VisionAsset {
  path: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

function dimensions(data: Buffer, mimeType: string): { width: number; height: number } | undefined {
  if (mimeType === "image/png" && data.length >= 24 && data.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary")))
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (mimeType === "image/gif" && data.length >= 10 && data.subarray(0, 3).toString("ascii") === "GIF")
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (mimeType === "image/webp" && data.length >= 30 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = data.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
  }
  if (mimeType !== "image/jpeg" || data.length < 4 || data.readUInt16BE(0) !== 0xffd8) return undefined;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1] ?? 0;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > data.length) return undefined;
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.length) return undefined;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && segmentLength >= 7) return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
    offset += segmentLength;
  }
  return undefined;
}

async function imagePath(root: string, requested: string): Promise<{ absolute: string; relativePath: string }> {
  const resolved = await resolveExistingWorkspacePath(root, requested, "Image path must stay inside the workspace");
  const mimeType = mimeByExtension[extname(resolved.target).toLowerCase()];
  if (mimeType === undefined) throw new Error("Unsupported image type; use png, jpeg, gif, or webp");
  return { absolute: resolved.target, relativePath: resolved.relativePath };
}

export async function imageInfo(root: string, requested: string): Promise<VisionAsset> {
  const { absolute, relativePath } = await imagePath(root, requested);
  const mimeType = mimeByExtension[extname(absolute).toLowerCase()]!;
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error("Image path is not a file");
  if (metadata.size > maxImageBytes) throw new Error("Image exceeds the 20 MiB inspection limit");
  const data = await readFile(absolute);
  const size = dimensions(data, mimeType);
  return { path: relativePath, mimeType, bytes: metadata.size, width: size?.width ?? null, height: size?.height ?? null };
}

async function walkImages(root: string, directory: string, prefix: string, output: VisionAsset[]): Promise<void> {
  if (output.length >= maxImages) return;
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (output.length >= maxImages) return;
    if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
      await walkImages(root, resolve(directory, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name, output);
      continue;
    }
    if (!entry.isFile() || mimeByExtension[extname(entry.name).toLowerCase()] === undefined) continue;
    const item = await imageInfo(root, prefix ? `${prefix}/${entry.name}` : entry.name);
    output.push(item);
  }
}

export async function catalogImages(root: string): Promise<VisionAsset[]> {
  const output: VisionAsset[] = [];
  await walkImages(resolve(root), resolve(root), "", output);
  return output;
}

export default {
  name: "pi-vision-toolkit",
  inject: ["piHarnessLaunch", "piTools", "piPluginUi"],
  apply(context: Context) {
    let latest: { root: string; assets: VisionAsset[] } = { root: context.piHarnessLaunch.cwd, assets: [] };
    const unregisterCatalog = context.piTools.register(
      defineTool({
        name: "vision_catalog",
        label: "Vision catalog",
        description: "List local workspace images with safe relative paths, MIME types, byte sizes, and dimensions.",
        promptSnippet: "catalog the images in the current workspace",
        parameters: Type.Object({}),
        async execute(): Promise<AgentToolResult<{ root: string; assets: VisionAsset[] }>> {
          latest = { root: context.piHarnessLaunch.cwd, assets: await catalogImages(context.piHarnessLaunch.cwd) };
          return {
            content: [
              {
                type: "text",
                text: latest.assets.map((asset) => `${asset.path} ${asset.width ?? "?"}x${asset.height ?? "?"}`).join("\n") || "No supported images found.",
              },
            ],
            details: latest,
          };
        },
      }),
    );
    const unregisterInfo = context.piTools.register(
      defineTool({
        name: "vision_image_info",
        label: "Image info",
        description: "Inspect one workspace image without exposing its contents or reading outside the workspace.",
        promptSnippet: "inspect the dimensions and type of a local image",
        parameters: Type.Object({ path: Type.String({ description: "Image path relative to the workspace" }) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<VisionAsset>> {
          const asset = await imageInfo(context.piHarnessLaunch.cwd, params.path);
          latest = { root: context.piHarnessLaunch.cwd, assets: [asset] };
          return {
            content: [{ type: "text", text: `${asset.path}: ${asset.mimeType}, ${asset.bytes} bytes, ${asset.width ?? "?"}x${asset.height ?? "?"}` }],
            details: asset,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "vision-toolkit-panel",
      pluginId: "@pi-harness/core/plugins/vision-toolkit",
      title: "视觉素材",
      description: "盘点工作区图片的类型、尺寸和大小，再交由视觉模型分析内容。",
      icon: "◉",
      read: () => ({ root: latest.root, count: latest.assets.length, assets: [...latest.assets] }),
    });
    context.effect(() => () => {
      unregisterCatalog();
      unregisterInfo();
      disposePanel();
    });
  },
};
