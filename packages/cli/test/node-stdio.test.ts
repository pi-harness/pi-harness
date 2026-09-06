import { PassThrough, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { MAX_STDIO_PROMPT_BYTES, PiHarnessStdioCancelledError } from "@pi-harness/core";
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
    promise.then(
      (value) => `resolved:${value}`,
      (error: Error) => `rejected:${error.name}`,
    ),
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

  test("flush resolves only once buffered output has drained", async () => {
    const input: FakeTty = new PassThrough();
    const output: FakeTty = new PassThrough({ highWaterMark: 16 });
    const stdio = new NodeStdio(input, output, output);
    stdio.writeOutput("x".repeat(4_096));
    let drained = false;

    const flushed = stdio.flush().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);
    output.resume();
    await flushed;

    expect(drained).toBe(true);
  });

  test("flush waits for an asynchronous write below the backpressure threshold", async () => {
    const input: FakeTty = new PassThrough();
    let completeWrite: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 64 * 1_024,
      write(_chunk, _encoding, callback) {
        completeWrite = callback;
      },
    });
    const stdio = new NodeStdio(input, output, output);
    stdio.writeOutput("pending");
    let flushed = false;
    const flush = stdio.flush().then(() => {
      flushed = true;
    });

    expect(output.writableNeedDrain).toBe(false);
    expect(completeWrite).toBeTypeOf("function");
    expect(flushed).toBe(false);
    completeWrite?.();
    let expectationError: unknown;
    try {
      await expect.poll(() => flushed, { interval: 10, timeout: 200 }).toBe(true);
    } catch (error) {
      expectationError = error;
    } finally {
      output.destroy();
      await flush;
    }
    if (expectationError !== undefined)
      throw expectationError instanceof Error ? expectationError : new Error("Flush expectation failed", { cause: expectationError });
  });

  test("flush resolves immediately when nothing is buffered", async () => {
    const input: FakeTty = new PassThrough();
    const output: FakeTty = new PassThrough();
    output.resume();
    const stdio = new NodeStdio(input, output, output);

    await expect(Promise.race([stdio.flush().then(() => "flushed"), new Promise((resolve) => setTimeout(() => resolve("pending"), 500))])).resolves.toBe(
      "flushed",
    );
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

  test("accepts a piped prompt at the exact UTF-8 byte limit", async () => {
    const input: FakeTty = new PassThrough();
    const output: FakeTty = new PassThrough();
    output.resume();
    const stdio = new NodeStdio(input, output, output);
    const read = stdio.readPrompt();
    const prompt = `${"界".repeat(349_525)}a`;
    expect(Buffer.byteLength(prompt, "utf8")).toBe(MAX_STDIO_PROMPT_BYTES);
    input.end(prompt);

    await expect(read).resolves.toBe(prompt);
  });

  test("removes temporary piped-input listeners after the read settles", async () => {
    const input: FakeTty = new PassThrough();
    const output: FakeTty = new PassThrough();
    output.resume();
    const stdio = new NodeStdio(input, output, output);
    const baseline = {
      data: input.listenerCount("data"),
      end: input.listenerCount("end"),
      error: input.listenerCount("error"),
    };
    const read = stdio.readPrompt();
    input.end("done");

    await expect(read).resolves.toBe("done");
    expect(input.listenerCount("data")).toBe(baseline.data);
    expect(input.listenerCount("end")).toBe(baseline.end);
    expect(input.listenerCount("error")).toBe(baseline.error);
  });

  test("rejects piped input above the fixed prompt byte limit", async () => {
    const input: FakeTty = new PassThrough();
    const output: FakeTty = new PassThrough();
    output.resume();
    const stdio = new NodeStdio(input, output, output);
    const read = stdio.readPrompt();
    input.end("x".repeat(MAX_STDIO_PROMPT_BYTES + 1));

    await expect(read).rejects.toThrow(`Prompt must be at most ${MAX_STDIO_PROMPT_BYTES} UTF-8 bytes`);
    expect(input.isPaused()).toBe(true);
  });

  test("rejects interactive input above the fixed prompt byte limit", async () => {
    const { input, stdio } = createTerminal();
    const read = stdio.readPrompt();
    input.write(`${"界".repeat(349_526)}\n`);

    await expect(read).rejects.toThrow(`Prompt must be at most ${MAX_STDIO_PROMPT_BYTES} UTF-8 bytes`);
    expect(input.isPaused()).toBe(true);
  });

  test("accepts an exact-limit interactive prompt whose UTF-8 character spans input chunks", async () => {
    const { input, stdio } = createTerminal();
    const read = stdio.readPrompt();
    const prompt = `${"界".repeat(349_525)}a`;
    const bytes = Buffer.from(prompt, "utf8");
    expect(bytes).toHaveLength(MAX_STDIO_PROMPT_BYTES);

    input.write(bytes.subarray(0, 1));
    input.write(bytes.subarray(1));
    input.write("\n");

    await expect(read).resolves.toBe(prompt);
  });

  test("removes its temporary interactive byte-counting listener after the read settles", async () => {
    const { input, stdio } = createTerminal();
    const baseline = {
      end: input.listenerCount("end"),
      error: input.listenerCount("error"),
    };
    const read = stdio.readPrompt();
    const readingDataListeners = input.listenerCount("data");
    input.write("done\n");

    await expect(read).resolves.toBe("done");
    expect(input.listenerCount("data")).toBeLessThan(readingDataListeners);
    expect(input.listenerCount("end")).toBe(baseline.end);
    expect(input.listenerCount("error")).toBe(baseline.error);
  });
});

describe("NodeStdio interactive prompt marker placement", () => {
  function collect(stream: PassThrough): () => string {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    return () => Buffer.concat(chunks).toString("utf8");
  }

  test("writes the marker to a TTY stderr instead of a redirected stdout", async () => {
    const input: FakeTty = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => {};
    const output: FakeTty = new PassThrough();
    const error: FakeTty = new PassThrough();
    error.isTTY = true;
    const written = collect(output);
    const shown = collect(error);
    const stdio = new NodeStdio(input, output, error);
    const read = stdio.readPrompt();
    input.write("hello\n");

    await expect(settle(read)).resolves.toBe("resolved:hello");
    expect(written()).toBe("");
    expect(shown()).toContain("> ");
  });

  test("writes no marker at all when neither stdout nor stderr is a terminal", async () => {
    const input: FakeTty = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => {};
    const output: FakeTty = new PassThrough();
    const error: FakeTty = new PassThrough();
    const written = collect(output);
    const shown = collect(error);
    const stdio = new NodeStdio(input, output, error);
    const read = stdio.readPrompt();
    input.write("hello\n");

    await expect(settle(read)).resolves.toBe("resolved:hello");
    expect(written()).toBe("");
    expect(shown()).toBe("");
  });
});
