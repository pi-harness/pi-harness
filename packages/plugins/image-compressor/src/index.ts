import { inflateSync, deflateSync } from "node:zlib";
import { realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig, atomicWriteFile, prepareWorkspaceFile, readBoundedFile } from "@pi-harness/plugin-api";

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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Image compression cancelled");
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
    if (source.readUInt32BE(end - 4) !== crc32(source.subarray(offset + 4, end - 4))) throw new Error(`PNG ${type} chunk has an invalid CRC`);
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
    const lifecycle = new AbortController();
    const readScope = () => {
      const session = context.get("piRuntime")?.session;
      return { session, manager: session?.sessionManager, id: session?.sessionId, cwd: session?.sessionManager.getCwd() ?? context.piHarnessLaunch.cwd };
    };
    let scope = readScope();
    const refreshScope = () => {
      const next = readScope();
      if (next.session !== scope.session || next.manager !== scope.manager || next.id !== scope.id || next.cwd !== scope.cwd) {
        scope = next;
        last = undefined;
      }
      return scope;
    };
    const assertCurrent = (operationScope: ReturnType<typeof readScope>, signal: AbortSignal) => {
      throwIfAborted(signal);
      if (refreshScope() !== operationScope) throw new Error("Image workspace changed during compression");
    };
    const compress = async (
      requestedPath: string,
      requestedOutput: string | undefined,
      confirm: boolean,
      signal: AbortSignal,
      operationScope: ReturnType<typeof readScope>,
    ): Promise<CompressionReport> => {
      const assertOperationCurrent = () => assertCurrent(operationScope, signal);
      assertOperationCurrent();
      if (!confirm) throw new Error("Image compression writes a file and requires confirm=true");
      const root = await realpath(operationScope.cwd);
      assertOperationCurrent();
      const input = await realpath(workspacePath(root, requestedPath));
      if (!isImageCompressorPathInside(root, input)) throw new Error("Image path must stay inside the current workspace");
      assertOperationCurrent();
      const inputBytes = await readBoundedFile(input, maxInputBytes, "Input image");
      assertOperationCurrent();
      const compressed = optimizePng(inputBytes);
      assertOperationCurrent();
      // Without an explicit outputPath the result lands next to its source, not at the workspace root, so same-named inputs in different directories cannot collide. dirname(input) is already realpath'd and containment-checked above, so it must not go back through workspacePath, which would reject the backslashes relative() produces on Windows.
      const explicitOutput = requestedOutput?.trim() || undefined;
      const requestedTarget =
        explicitOutput === undefined ? join(dirname(input), `${basename(input, extname(input))}.min.png`) : workspacePath(root, explicitOutput);
      const { target: output } = await prepareWorkspaceFile(
        root,
        requestedTarget,
        "Image output path must stay inside the current workspace and name a regular file",
      );
      assertOperationCurrent();
      // confirm=true approves compressing the input, not clobbering whatever already sits at the derived path; only an explicit outputPath may replace an existing file.
      try {
        await atomicWriteFile(output, compressed, { mode: 0o600, overwrite: explicitOutput !== undefined, signal, beforeCommit: assertOperationCurrent });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new Error(`Image output already exists: ${relative(root, output)}; pass outputPath explicitly to replace it`, { cause: error });
      }
      assertOperationCurrent();
      const report: CompressionReport = {
        inputPath: relative(root, input),
        outputPath: relative(root, output),
        format: "png",
        inputBytes: inputBytes.length,
        outputBytes: compressed.length,
        savedBytes: inputBytes.length - compressed.length,
        saved: true,
      };
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
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<CompressionReport>> {
          throwIfAborted(lifecycle.signal);
          const operationScope = refreshScope();
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          const report = await compress(params.path, params.outputPath, params.confirm, operationSignal, operationScope);
          assertCurrent(operationScope, operationSignal);
          last = { ...report };
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
        pluginId: "@pi-harness/plugin-image-compressor",
        title: "Image Compressor",
        description: "对工作区 PNG 做确认后的无损重压缩，减少上下文附件体积。",
        icon: "▧",
        read: () => {
          refreshScope();
          return { supported: ["png"], maxInputBytes, maxDecodedBytes, last: last === undefined ? null : { ...last } };
        },
      });
    } catch (error) {
      unregisterTool();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Image compressor plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
