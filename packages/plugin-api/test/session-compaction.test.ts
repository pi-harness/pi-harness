import { describe, expect, test } from "vitest";
import { tryAcquireSessionCompaction } from "../src/session-compaction.js";

describe("session compaction coordinator", () => {
  test("allows exactly one owner per native session until its release runs", () => {
    const firstSession = {};
    const secondSession = {};
    const releaseFirst = tryAcquireSessionCompaction(firstSession);
    const releaseSecond = tryAcquireSessionCompaction(secondSession);

    expect(releaseFirst).toEqual(expect.any(Function));
    expect(tryAcquireSessionCompaction(firstSession)).toBeUndefined();
    expect(releaseSecond).toEqual(expect.any(Function));

    releaseFirst?.();
    releaseFirst?.();
    const releaseReplacement = tryAcquireSessionCompaction(firstSession);
    expect(releaseReplacement).toEqual(expect.any(Function));

    releaseReplacement?.();
    releaseSecond?.();
  });
});
