import { inflateSync, deflateSync } from "node:zlib";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile } from "../atomic-write.js";
import { EmptyConfig } from "../config.js";

const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const maxInputBytes = 32 * 1024 * 1024;
const maxDecodedBytes = 128 * 1024 * 1024;
const maxPathLength = 512;
const maxChunks = 10_000;
type PngChunk = { type: string; data: Buffer };
type CompressionReport = { inputPath: string; outputPath: string; format: "png"; inputBytes: number; outputBytes: number; savedBytes: number; saved: true };

type PathSemantics = { isAbsolute(path: string): boolean; relative(from: string, to: string): string; sep: string };
const nativePathSemantics: PathSemantics = { isAbsolute, relative, sep };

export function isImageCompressorPathInside(root: string, target: string, pathSemantics: PathSemantics = nativePathSemantics): boolean {
  const remainder = pathSemantics.relative(root, target);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${pathSemantics.sep}`) && !pathSemantics.isAbsolute(remainder));
}

function workspacePath(root: string, requested: string): string {
  if (requested.length === 0 || requested.length > maxPathLength || requested.includes("\\"))
    throw new Error("Image path must be a relative POSIX path of at most 512 characters");
  const target = resolve(root, requested);
  if (!isImageCompressorPathInside(root, target)) throw new Error("Image path must stay inside the current workspace");
  return target;
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.allocUnsafe(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function expectedImageDataBytes(header: Buffer): number {
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  const compression = header[10];
  const filter = header[11];
  const interlace = header[12];
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : undefined;
  const validDepths =
    colorType === 0 ? [1, 2, 4, 8, 16] : colorType === 3 ? [1, 2, 4, 8] : colorType === 2 || colorType === 4 || colorType === 6 ? [8, 16] : [];
  if (
    width === 0 ||
    height === 0 ||
    channels === undefined ||
    bitDepth === undefined ||
    !validDepths.includes(bitDepth) ||
    compression !== 0 ||
    filter !== 0 ||
    (interlace !== 0 && interlace !== 1)
  ) {
    throw new Error("PNG has an invalid IHDR");
  }
  const passBytes = (passWidth: number, passHeight: number): number =>
    passWidth === 0 || passHeight === 0 ? 0 : passHeight * (1 + Math.ceil((passWidth * channels * bitDepth) / 8));
  let expected: number;
  if (interlace === 0) {
    expected = passBytes(width, height);
  } else {
    const passes = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ] as const;
    expected = passes.reduce((total, [startX, startY, stepX, stepY]) => {
      const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
      const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
      return total + passBytes(passWidth, passHeight);
    }, 0);
  }
  if (!Number.isSafeInteger(expected) || expected > maxDecodedBytes) throw new Error("PNG image data exceeds the 128 MiB decompression limit");
  return expected;
}

function optimizePng(source: Buffer): Buffer {
  if (!source.subarray(0, 8).equals(pngSignature)) throw new Error("Image compressor currently supports PNG files only");
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < source.length) {
    if (chunks.length >= maxChunks || offset + 12 > source.length) throw new Error("PNG has an invalid chunk table");
    const length = source.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > source.length) throw new Error("PNG chunk exceeds the input file");
    const type = source.subarray(offset + 4, offset + 8).toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("PNG contains an invalid chunk type");
    chunks.push({ type, data: source.subarray(offset + 8, offset + 8 + length) });
    offset = end;
    if (type === "IEND") break;
  }
  const header = chunks[0];
  if (header?.type !== "IHDR" || header.data.length !== 13 || chunks.at(-1)?.type !== "IEND") throw new Error("PNG is missing a valid IHDR or IEND chunk");
  if (chunks.some(({ type }) => type === "acTL" || type === "fcTL" || type === "fdAT")) throw new Error("Animated PNG files are not supported");
  const idat = chunks.filter(({ type }) => type === "IDAT").map(({ data }) => data);
  if (idat.length === 0) throw new Error("PNG has no image data");
  const expectedBytes = expectedImageDataBytes(header.data);
  let imageData: Buffer;
  try {
    imageData = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedBytes });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
      throw new Error("PNG image data exceeds its IHDR-declared scanline size", { cause: error });
    throw error;
  }
  if (imageData.length !== expectedBytes) throw new Error("PNG image data does not match its IHDR-declared scanline size");
  const compressed = deflateSync(imageData, { level: 9 });
  let wroteImageData = false;
  const output = chunks.flatMap((item): Buffer[] => {
    if (item.type !== "IDAT") return [chunk(item.type, item.data)];
    if (wroteImageData) return [];
    wroteImageData = true;
    return [chunk("IDAT", compressed)];
  });
  return Buffer.concat([pngSignature, ...output]);
}

export default {
  name: "pi-image-compressor",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let last: CompressionReport | undefined;
    const compress = async (requestedPath: string, requestedOutput: string | undefined, confirm: boolean): Promise<CompressionReport> => {
      if (!confirm) throw new Error("Image compression writes a file and requires confirm=true");
      const root = await realpath(context.piHarnessLaunch.cwd);
      const input = await realpath(workspacePath(root, requestedPath));
      if (!isImageCompressorPathInside(root, input)) throw new Error("Image path must stay inside the current workspace");
      const metadata = await stat(input);
      if (!metadata.isFile() || metadata.size > maxInputBytes) throw new Error("Input image must be a regular PNG file no larger than 32 MiB");
      const output = workspacePath(root, requestedOutput?.trim() || `${basename(input, extname(input))}.min.png`);
      const outputParent = dirname(output);
      await mkdir(outputParent, { recursive: true });
      if (!isImageCompressorPathInside(root, await realpath(outputParent))) throw new Error("Image output path must stay inside the current workspace");
      try {
        if ((await lstat(output)).isSymbolicLink()) throw new Error("Image output cannot be a symbolic link");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const inputBytes = await readFile(input);
      const compressed = optimizePng(inputBytes);
      await atomicWriteFile(output, compressed, { mode: 0o600 });
      const report: CompressionReport = {
        inputPath: relative(root, input),
        outputPath: relative(root, output),
        format: "png",
        inputBytes: inputBytes.length,
        outputBytes: compressed.length,
        savedBytes: inputBytes.length - compressed.length,
        saved: true,
      };
      last = report;
      return report;
    };
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "image_compress",
        label: "Compress image",
        description: "Losslessly recompress a PNG inside the current workspace and write a confirmed output file.",
        promptSnippet: "losslessly compress a workspace PNG",
        parameters: Type.Object({ path: Type.String(), outputPath: Type.Optional(Type.String()), confirm: Type.Boolean() }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params): Promise<AgentToolResult<CompressionReport>> {
          const report = await compress(params.path, params.outputPath, params.confirm);
          return {
            content: [
              { type: "text", text: `PNG compressed: ${report.inputPath} -> ${report.outputPath} (${report.inputBytes} -> ${report.outputBytes} bytes)` },
            ],
            details: report,
          };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "image-compressor-panel",
        pluginId: "@pi-harness/core/plugins/image-compressor",
        title: "Image Compressor",
        description: "对工作区 PNG 做确认后的无损重压缩，减少上下文附件体积。",
        icon: "▧",
        read: () => ({ supported: ["png"], maxInputBytes, maxDecodedBytes, last: last ?? null }),
      });
    } catch (error) {
      unregisterTool();
      throw error;
    }
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
