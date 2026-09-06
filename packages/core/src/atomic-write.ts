import { randomUUID } from "node:crypto";
import { link, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  encoding?: BufferEncoding | null;
  mode?: number;
  overwrite?: boolean;
  signal?: AbortSignal;
}

const writeQueues = new Map<string, Promise<void>>();

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Atomic write was cancelled", { cause: signal.reason });
}

async function writeAtomic(target: string, data: string | NodeJS.ArrayBufferView, options: AtomicWriteOptions): Promise<void> {
  throwIfAborted(options.signal);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let committed = false;
  try {
    await writeFile(temporary, data, { encoding: options.encoding, mode: options.mode ?? 0o600, flag: "wx", signal: options.signal });
    throwIfAborted(options.signal);
    if (options.overwrite === false) {
      await link(temporary, target);
      await rm(temporary);
    } else {
      await rename(temporary, target);
    }
    committed = true;
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
