import { describe, expect, test } from "vitest";
import { selectRewindTarget } from "../src/plugins/turn-rewind.js";

describe("turn rewind", () => {
  test("selects a previous user turn from the native fork candidates", () => {
    const candidates = [
      { entryId: "u1", text: "第一轮" },
      { entryId: "u2", text: "第二轮" },
      { entryId: "u3", text: "第三轮" },
    ];
    expect(selectRewindTarget(candidates, 1)).toEqual({ entryId: "u3", text: "第三轮" });
    expect(selectRewindTarget(candidates, 3)).toBeUndefined();
  });

  test("rejects invalid turn counts instead of choosing an unexpected branch", () => {
    expect(() => selectRewindTarget([{ entryId: "u1", text: "only" }], 0)).toThrow("Turn rewind count must be between 1 and 20");
    expect(() => selectRewindTarget([{ entryId: "u1", text: "only" }], 21)).toThrow("Turn rewind count must be between 1 and 20");
  });
});
