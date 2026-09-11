import { constants } from "node:fs";
import { open } from "node:fs/promises";

export class BoundedFileSizeError extends Error {}
export class BoundedFileTypeError extends Error {}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Bounded file read cancelled", { cause: signal.reason });
}

export async function readBoundedFile(path: string, maxBytes: number, label: string, signal?: AbortSignal): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Bounded file size must be a non-negative safe integer");
  throwIfAborted(signal);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NOFOLLOW only rejects symbolic links. Without O_NONBLOCK a FIFO or a blocking device node would suspend the open until a writer appears, so the regular-file check below would never run and the libuv thread serving the call would be lost for the life of the process.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    throwIfAborted(signal);
    const metadata = await handle.stat();
    throwIfAborted(signal);
    if (!metadata.isFile()) throw new BoundedFileTypeError(`${label} must be a regular file`);
    if (metadata.size > maxBytes) throw new BoundedFileSizeError(`${label} exceeds the ${maxBytes}-byte limit`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      throwIfAborted(signal);
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      throwIfAborted(signal);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw new BoundedFileSizeError(`${label} exceeds the ${maxBytes}-byte limit`);
    return Buffer.concat(chunks, total);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new BoundedFileTypeError(`${label} cannot be a symbolic link`, { cause: error });
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readBoundedTextFile(path: string, maxBytes: number, label: string, signal?: AbortSignal): Promise<string> {
  const bytes = await readBoundedFile(path, maxBytes, label, signal);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must contain valid UTF-8`, { cause: error });
  }
}
