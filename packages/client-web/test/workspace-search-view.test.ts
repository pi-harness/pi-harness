import { describe, expect, test } from "vitest";
import { workspaceSearchPanelView } from "../src/workspace-search-view.js";

const match = (index: number) => ({ path: `apps/tenant-${index}/orders/refund-handler.ts`, line: index + 1, text: `tenant-${index} refund policy` });

function report() {
  return {
    cwd: "/workspace/commerce-platform",
    query: "refund",
    matchCount: 2,
    scannedFiles: 12,
    latest: {
      query: "refund",
      path: ".",
      matches: [match(0), match(1)],
      matchCount: 2,
      scannedFiles: 12,
      skippedFiles: 0,
      truncated: false,
      scannedEntries: 24,
      readBytes: 4_096,
    },
  };
}

describe("workspace search panel view", () => {
  test("preserves a complete valid search report", () => {
    expect(workspaceSearchPanelView(report())).toEqual({ ...report(), malformed: false });
  });

  test("accepts all one hundred bounded matches without clipping them again", () => {
    const matches = Array.from({ length: 100 }, (_, index) => ({
      path: `apps/tenant-${index}/${"nested/".repeat(40)}refund-handler.ts`,
      line: index + 1,
      text: `…${String(index).padStart(3, "0")}${"x".repeat(497)}…`,
    }));
    const value = {
      ...report(),
      matchCount: 100,
      latest: { ...report().latest, matches, matchCount: 100, truncated: true },
    };

    const view = workspaceSearchPanelView(value);

    expect(view.malformed).toBe(false);
    expect(view.latest?.matches).toHaveLength(100);
    expect(view.latest?.matches[99]).toEqual(matches[99]);
  });

  test("accepts exact read-budget completion and long canonical producer paths", () => {
    const canonicalPath = Array.from({ length: 30 }, (_, index) => `tenant-${index}-segment`).join("/");
    const value = {
      ...report(),
      latest: {
        ...report().latest,
        path: canonicalPath,
        matches: [{ ...match(0), path: `${canonicalPath}/refund-handler.ts` }],
        matchCount: 1,
        readBytes: 64 * 1024 * 1024,
      },
      matchCount: 1,
    };

    expect(canonicalPath.length).toBeGreaterThan(512);
    expect(workspaceSearchPanelView(value)).toMatchObject({ malformed: false, latest: { path: canonicalPath, readBytes: 64 * 1024 * 1024 } });
  });

  test("accepts a POSIX filename containing a literal backslash", () => {
    const value = {
      ...report(),
      matchCount: 1,
      latest: { ...report().latest, matches: [{ ...match(0), path: "tenant\\refund.txt" }], matchCount: 1 },
    };

    expect(workspaceSearchPanelView(value)).toMatchObject({ malformed: false, latest: { matches: [{ path: "tenant\\refund.txt" }] } });
  });

  test("fails closed on contradictory, malformed, accessor, and proxy payloads", () => {
    const accessor = report();
    let accessed = false;
    Object.defineProperty(accessor, "query", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("query accessor executed");
      },
    });
    const revoked = Proxy.revocable(report(), {});
    revoked.revoke();
    const malformed = [
      null,
      { ...report(), query: "different" },
      { ...report(), matchCount: 1 },
      { ...report(), scannedFiles: 11 },
      { ...report(), latest: { ...report().latest, matchCount: 1 } },
      { ...report(), latest: { ...report().latest, skippedFiles: 1, truncated: false } },
      { ...report(), latest: { ...report().latest, matches: [match(0), match(0)] } },
      { ...report(), latest: { ...report().latest, path: "/absolute" } },
      { ...report(), latest: { ...report().latest, path: "../escape" } },
      { ...report(), latest: { ...report().latest, path: "tenant/./orders" } },
      { ...report(), latest: { ...report().latest, matches: [{ ...match(0), path: "tenant-a/../../outside" }, match(1)] } },
      { ...report(), latest: { ...report().latest, matches: [{ ...match(0), path: "/absolute" }, match(1)] } },
      { ...report(), latest: { ...report().latest, extra: true } },
      accessor,
      revoked.proxy,
    ];

    for (const value of malformed) expect(workspaceSearchPanelView(value)).toMatchObject({ malformed: true, latest: null, matchCount: 0 });
    expect(accessed).toBe(false);
  });
});
