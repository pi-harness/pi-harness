import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { PiHarnessStdio } from "@pi-harness/core";

type TerminalReadable = Readable & { isTTY?: boolean };

export class NodeStdio implements PiHarnessStdio {
  readonly #input: TerminalReadable;
  readonly #output: Writable;
  readonly #error: Writable;

  constructor(input: Readable, output: Writable, error: Writable) {
    this.#input = input;
    this.#output = output;
    this.#error = error;
  }

  async readPrompt(): Promise<string> {
    if (this.#input.isTTY === true) {
      const readline = createInterface({ input: this.#input, output: this.#output });
      try {
        return await readline.question("> ");
      } finally {
        readline.close();
      }
    }
    this.#input.setEncoding("utf8");
    let content = "";
    for await (const chunk of this.#input) content += String(chunk);
    return content.trimEnd();
  }

  writeOutput(text: string): void {
    this.#output.write(text);
  }

  writeError(text: string): void {
    this.#error.write(text);
  }
}
