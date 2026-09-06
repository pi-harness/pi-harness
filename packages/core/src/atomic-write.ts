import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  encoding?: BufferEncoding | null;
  /** Permission bits for the written file. Defaults to the existing regular target's own bits, or 0o600 for a new file. */
  mode?: number;
  overwrite?: boolean;
  signal?: AbortSignal;
}

const writeQueues = new Map<string, Promise<void>>();

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Atomic write was cancelled", { cause: signal.reason });
}

// Directory fsync makes the rename itself durable. Windows has no directory handles to sync, and some filesystems reject fsync on a directory descriptor; those cases degrade to the file-level guarantee instead of failing a write that already completed.
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM" && code !== "EBADF") throw error;
  } finally {
    await handle.close();
  }
}

// The commit replaces the target inode, so the temporary file's permission bits become the target's. A caller that only replaces content must not silently downgrade an existing file, so its current bits are carried over unless the caller pins a mode explicitly.
async function targetFileMode(target: string): Promise<number | undefined> {
  try {
    const info = await lstat(target);
    return info.isFile() ? info.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

async function writeAtomic(target: string, data: string | NodeJS.ArrayBufferView, options: AtomicWriteOptions): Promise<void> {
  throwIfAborted(options.signal);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const mode = options.mode ?? (await targetFileMode(target)) ?? 0o600;
  let committed = false;
  try {
    // The temporary file must reach stable storage before it is renamed over the target, otherwise a power loss can commit the directory entry while the data blocks are still only in the page cache, leaving an empty or truncated target after the old contents are already gone.
    const handle = await open(temporary, "wx", mode);
    try {
      // open() masks the requested bits with the process umask, so the mode is restated on the handle to land exactly the requested permissions.
      await handle.chmod(mode);
      const bytes = typeof data === "string" ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      await handle.writeFile(bytes, { encoding: options.encoding, signal: options.signal });
      throwIfAborted(options.signal);
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(options.signal);
    if (options.overwrite === false) {
      await link(temporary, target);
      await rm(temporary);
    } else {
      await rename(temporary, target);
    }
    committed = true;
    await syncDirectory(dirname(target));
  } finally {
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function atomicWriteFile(target: string, data: string | NodeJS.ArrayBufferView, options: AtomicWriteOptions = {}): Promise<void> {
  const previous = writeQueues.get(target);
  const operation = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined)).then(async () => writeAtomic(target, data, options));
  writeQueues.set(target, operation);
  return operation.finally(() => {
    if (writeQueues.get(target) === operation) writeQueues.delete(target);
  });
}
