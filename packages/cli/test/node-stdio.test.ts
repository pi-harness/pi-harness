import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { PiHarnessStdioCancelledError } from "@pi-harness/core";
import { NodeStdio } from "../src/node-stdio.js";

type FakeTty = PassThrough & { isTTY?: boolean; setRawMode?: () => void };

function createTerminal(): { input: FakeTty; output: FakeTty; stdio: NodeStdio } {
  const input: FakeTty = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output: FakeTty = new PassThrough();
  output.isTTY = true;
  output.resume();
  return { input, output, stdio: new NodeStdio(input, output, output) };
}

async function settle(promise: Promise<string>): Promise<string> {
  return await Promise.race([
    promise.then((value) => `resolved:${value}`, (error: Error) => `rejected:${error.name}`),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 1_000)),
  ]);
}

describe("NodeStdio interactive prompt", () => {
  test("resolves a typed line", async () => {
    const { input, stdio } = createTerminal();
    const read = stdio.readPrompt();
    input.write("hello\n");

    await expect(settle(read)).resolves.toBe("resolved:hello");
  });

  test.each([
    ["Ctrl-C", (input: FakeTty) => input.write(Buffer.from([3]))],
    ["Ctrl-D", (input: FakeTty) => input.write(Buffer.from([4]))],
    ["end of input", (input: FakeTty) => input.end()],
  ])("reports %s as a cancellation instead of hanging", async (_label, act) => {
    const { input, stdio } = createTerminal();
    const read = stdio.readPrompt();
    act(input);

    await expect(settle(read)).resolves.toBe("rejected:PiHarnessStdioCancelledError");
  });

  test("cancels a pending read when the stdio is closed", async () => {
    const { stdio } = createTerminal();
    const read = stdio.readPrompt();
    stdio.close();

    await expect(settle(read)).resolves.toBe("rejected:PiHarnessStdioCancelledError");
    await expect(stdio.readPrompt()).rejects.toBeInstanceOf(PiHarnessStdioCancelledError);
  });

  test("reads a piped prompt to end of stream", async () => {
    const input: FakeTty = new PassThrough();
    const output: FakeTty = new PassThrough();
    output.resume();
    const stdio = new NodeStdio(input, output, output);
    const read = stdio.readPrompt();
    input.end("piped prompt\n");

    await expect(settle(read)).resolves.toBe("resolved:piped prompt");
  });
});
