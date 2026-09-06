import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { MAX_STDIO_PROMPT_BYTES, PiHarnessStdioCancelledError, type PiHarnessStdio } from "@pi-harness/core";

type TerminalReadable = Readable & { isTTY?: boolean };
type PendingWrite = { readonly promise: Promise<void>; readonly resolve: () => void };

export class NodeStdio implements PiHarnessStdio {
  readonly #input: TerminalReadable;
  readonly #output: Writable;
  readonly #error: Writable;
  readonly #abort = new AbortController();
  #readline: Interface | undefined;
  readonly #broken = new WeakSet<Writable>();
  readonly #pendingWrites = new WeakMap<Writable, Set<PendingWrite>>();

  constructor(input: Readable, output: Writable, error: Writable) {
    this.#input = input;
    this.#output = output;
    this.#error = error;
    for (const stream of new Set([output, error])) stream.on("error", () => this.#markBroken(stream));
  }

  async readPrompt(): Promise<string> {
    if (this.#abort.signal.aborted) throw new PiHarnessStdioCancelledError();
    if (this.#input.isTTY === true) return await this.#question();
    this.#input.setEncoding("utf8");
    let content = "";
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: unknown) => {
        const text = String(chunk);
        bytes += Buffer.byteLength(text, "utf8");
        if (bytes > MAX_STDIO_PROMPT_BYTES) {
          this.#input.pause();
          settle(new Error(`Prompt must be at most ${MAX_STDIO_PROMPT_BYTES} UTF-8 bytes`));
          return;
        }
        content += text;
      };
      const settle = (error?: Error) => {
        this.#input.off("data", onData);
        this.#input.off("end", onEnd);
        this.#input.off("error", onError);
        this.#abort.signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onEnd = () => settle();
      const onError = (error: Error) => settle(error);
      const onAbort = () => {
        this.#input.pause();
        settle(new PiHarnessStdioCancelledError());
      };
      this.#input.on("data", onData);
      this.#input.once("end", onEnd);
      this.#input.once("error", onError);
      this.#abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    return content.trimEnd();
  }

  async #question(): Promise<string> {
    let bytes = 0;
    let lineEnded = false;
    let rejectOversized: (reason?: unknown) => void = () => {};
    const oversized = new Promise<string>((_resolve, reject) => {
      rejectOversized = reject;
    });
    const onInputData = (chunk: unknown) => {
      if (lineEnded) return;
      if (chunk instanceof Uint8Array) {
        let lineEnd = chunk.length;
        for (let index = 0; index < chunk.length; index += 1) {
          if (chunk[index] === 10 || chunk[index] === 13) {
            lineEnd = index;
            lineEnded = true;
            break;
          }
        }
        bytes += lineEnd;
      } else {
        const text = String(chunk);
        const lineEnd = text.search(/[\r\n]/u);
        const promptText = lineEnd < 0 ? text : text.slice(0, lineEnd);
        if (lineEnd >= 0) lineEnded = true;
        bytes += Buffer.byteLength(promptText, "utf8");
      }
      if (bytes <= MAX_STDIO_PROMPT_BYTES) return;
      this.#input.pause();
      rejectOversized(new Error(`Prompt must be at most ${MAX_STDIO_PROMPT_BYTES} UTF-8 bytes`));
    };
    this.#input.on("data", onInputData);
    const readline = createInterface({ input: this.#input, output: this.#output });
    this.#readline = readline;
    readline.on("SIGINT", () => this.close());
    try {
      return await Promise.race([
        readline.question("> ", { signal: this.#abort.signal }),
        new Promise<string>((_, reject) => readline.once("close", () => reject(new PiHarnessStdioCancelledError()))),
        oversized,
      ]);
    } catch (cause) {
      throw this.#abort.signal.aborted || cause instanceof PiHarnessStdioCancelledError ? new PiHarnessStdioCancelledError() : cause;
    } finally {
      this.#readline = undefined;
      this.#input.off("data", onInputData);
      readline.close();
    }
  }

  writeOutput(text: string): void {
    this.#write(this.#output, text);
  }

  writeError(text: string): void {
    this.#write(this.#error, text);
  }

  #write(stream: Writable, text: string): void {
    if (this.#broken.has(stream) || stream.destroyed || stream.writableEnded) return;
    let resolve!: () => void;
    const pending: PendingWrite = {
      promise: new Promise<void>((settle) => {
        resolve = settle;
      }),
      resolve: () => resolve(),
    };
    let writes = this.#pendingWrites.get(stream);
    if (writes === undefined) {
      writes = new Set();
      this.#pendingWrites.set(stream, writes);
    }
    writes.add(pending);
    try {
      stream.write(text, (error) => {
        if (error !== null && error !== undefined) this.#markBroken(stream);
        else this.#settleWrite(stream, pending);
      });
    } catch {
      this.#markBroken(stream);
    }
  }

  async flush(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const stream of new Set([this.#output, this.#error])) {
      for (const write of this.#pendingWrites.get(stream) ?? []) pending.push(write.promise);
    }
    await Promise.all(pending);
  }

  #settleWrite(stream: Writable, pending: PendingWrite): void {
    this.#pendingWrites.get(stream)?.delete(pending);
    pending.resolve();
  }

  #markBroken(stream: Writable): void {
    this.#broken.add(stream);
    const writes = this.#pendingWrites.get(stream);
    if (writes === undefined) return;
    this.#pendingWrites.delete(stream);
    for (const pending of writes) pending.resolve();
  }

  close(): void {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort(new PiHarnessStdioCancelledError());
    this.#readline?.close();
    this.#input.pause();
  }
}
