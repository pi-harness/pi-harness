import type { WriteStream } from "node:tty";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import StderrConsoleExporter from "../src/plugins/logger.js";

// `getColorDepth` is defined on a stream exactly when it is a TTY, and a test run has one on neither stream, so the probe is installed on stderr alone: a level that still comes back from stdout cannot be mistaken for this one.
function withStderrColorDepth<T>(depth: number, body: () => T): T {
  const owned = Object.getOwnPropertyDescriptor(process.stderr, "getColorDepth");
  Object.defineProperty(process.stderr, "getColorDepth", { configurable: true, value: () => depth });
  try {
    return body();
  } finally {
    if (owned === undefined) delete (process.stderr as Partial<WriteStream>).getColorDepth;
    else Object.defineProperty(process.stderr, "getColorDepth", owned);
  }
}

describe("StderrConsoleExporter", () => {
  test.each([
    [24, 3],
    [8, 2],
    [4, 1],
    [1, 0],
  ])("takes its color level from the stream the records land on: depth %i renders at level %i", (depth, level) => {
    expect(withStderrColorDepth(depth, () => new StderrConsoleExporter(new Context(), {}).colors)).toBe(level);
  });
});
