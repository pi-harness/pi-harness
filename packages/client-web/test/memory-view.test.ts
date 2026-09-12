import { afterEach, describe, expect, test, vi } from "vitest";
import { memoryPanelView } from "../src/memory-view.js";

const memory = {
  id: "id-1",
  key: "tenant-a-refund-policy",
  value: "Preserve\0the source payload",
  tags: ["tenant-a", "refund"],
  createdAt: "2026-09-12T03:00:00.000Z",
  updatedAt: "2026-09-12T03:00:01.000Z",
};
const report = {
  filePath: "/workspace/memory.json",
  count: 1,
  shown: 1,
  truncated: false,
  last: { query: "refund", total: 1, shown: 1, truncated: false, memories: [memory] },
  memories: [memory],
};

afterEach(() => vi.restoreAllMocks());

describe("Memory panel view", () => {
  test("returns detached recent and search inventories", () => {
    const view = memoryPanelView(report);
    expect(view).toEqual({ ...report, malformed: false });
    expect(view.memories).not.toBe(report.memories);
    expect(view.memories[0]).not.toBe(memory);
    expect(view.last?.memories).not.toBe(report.last.memories);
  });

  test("fails closed for contradictory counts, invalid records, duplicates, and oversized arrays", () => {
    const newer = { ...memory, id: "id-2", key: "tenant-b", updatedAt: "2026-09-12T03:00:02.000Z" };
    const malformed = [
      null,
      { ...report, count: 2 },
      { ...report, shown: 0 },
      { ...report, truncated: true },
      { ...report, memories: [{ ...memory, updatedAt: "not-a-date" }] },
      { ...report, memories: [{ ...memory, tags: ["refund", "refund"] }] },
      { ...report, last: { ...report.last, total: 2 } },
      { ...report, count: 2, shown: 2, memories: [memory, memory] },
      { ...report, count: 2, shown: 2, memories: [memory, newer] },
      { ...report, last: { query: "refund", total: 2, shown: 2, truncated: false, memories: [memory, newer] } },
      { ...report, count: 9, shown: 8, truncated: true, memories: Array.from({ length: 9 }, () => memory) },
    ];
    for (const value of malformed) expect(memoryPanelView(value)).toMatchObject({ malformed: true, count: 0, memories: [] });
  });

  test("does not invoke accessors or revoked proxies", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "count", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [accessor, revoked.proxy]) expect(memoryPanelView(value)).toMatchObject({ malformed: true });
    expect(getterCalls).toBe(0);
  });

  test("rejects oversized arrays and values before expensive inspection", () => {
    let ownKeysCalls = 0;
    const oversizedMemories = new Proxy(
      Array.from({ length: 9 }, () => memory),
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const encode = vi.spyOn(TextEncoder.prototype, "encode");

    expect(memoryPanelView({ ...report, count: 9, shown: 8, truncated: true, memories: oversizedMemories })).toMatchObject({ malformed: true });
    expect(memoryPanelView({ ...report, memories: [{ ...memory, value: "x".repeat(64 * 1024 + 1) }] })).toMatchObject({ malformed: true });
    expect(ownKeysCalls).toBe(0);
    expect(encode).not.toHaveBeenCalled();
  });
});
