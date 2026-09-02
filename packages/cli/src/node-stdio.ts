import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { PiHarnessStdioCancelledError, type PiHarnessStdio } from "@pi-harness/core";

type TerminalReadable = Readable & { isTTY?: boolean };

export class NodeStdio implements PiHarnessStdio {
  readonly #input: TerminalReadable;
  readonly #output: Writable;
  readonly #error: Writable;
  readonly #abort = new AbortController();
  #readline: Interface | undefined;
  readonly #broken = new WeakSet<Writable>();

  constructor(input: Readable, output: Writable, error: Writable) {
    this.#input = input;
    this.#output = output;
    this.#error = error;
    output.on("error", () => this.#broken.add(output));
    error.on("error", () => this.#broken.add(error));
  }

  async readPrompt(): Promise<string> {
    if (this.#abort.signal.aborted) throw new PiHarnessStdioCancelledError();
    if (this.#input.isTTY === true) return await this.#question();
    this.#input.setEncoding("utf8");
    let content = "";
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: unknown) => { content += String(chunk); };
      const settle = (error?: Error) => {
        this.#input.off("data", onData);
        this.#input.off("end", onEnd);
        this.#input.off("error", onError);
        this.#abort.signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve(); else reject(error);
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
    const readline = createInterface({ input: this.#input, output: this.#output });
    this.#readline = readline;
    readline.on("SIGINT", () => this.close());
    try {
      return await Promise.race([
        readline.question("> ", { signal: this.#abort.signal }),
        new Promise<string>((_, reject) => readline.once("close", () => reject(new PiHarnessStdioCancelledError()))),
      ]);
    } catch (cause) {
      throw this.#abort.signal.aborted || cause instanceof PiHarnessStdioCancelledError ? new PiHarnessStdioCancelledError() : cause;
    } finally {
      this.#readline = undefined;
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
    try {
      stream.write(text, (error) => {
        if (error !== null && error !== undefined) this.#broken.add(stream);
      });
    } catch {
      this.#broken.add(stream);
    }
  }

  close(): void {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort(new PiHarnessStdioCancelledError());
    this.#readline?.close();
    this.#input.pause();
  }
}
