import { describe, expect, test } from "vitest";
import { workspaceNavigatorPanelView } from "../src/workspace-navigator-view.js";

const nodes = Array.from({ length: 500 }, (_, index) =>
  index === 0
    ? { kind: "directory" as const, name: "tenants", path: "tenants", depth: 1 }
    : {
        kind: index % 2 === 0 ? ("directory" as const) : ("file" as const),
        name: `entry-${String(index).padStart(3, "0")}`,
        path: `tenants/entry-${String(index).padStart(3, "0")}`,
        depth: 2,
      },
);
const entries = Array.from({ length: 500 }, (_, index) => ({ status: " M", path: `tenants/tenant-${String(index).padStart(3, "0")}/orders.ts` }));

function valid() {
  return {
    cwd: "/workspace/commerce-platform",
    latest: {
      nodes,
      directoryCount: 250,
      fileCount: 250,
      truncated: false,
      scannedEntries: 500,
      path: ".",
      maxDepth: 4,
      maxNodes: 500,
    },
    git: { available: true, failureReason: null, branch: "audit/tenant-refunds", clean: false, entries, changedCount: 500, truncated: false },
    nodeCount: 500,
    gitTimeoutMs: 10_000,
  };
}

describe("workspace navigator panel view", () => {
  test("preserves the complete backend-bounded tree and Git inventories", () => {
    const view = workspaceNavigatorPanelView(valid());

    expect(view).toEqual({ ...valid(), malformed: false });
    expect(view.latest?.nodes).toHaveLength(500);
    expect(view.git?.entries).toHaveLength(500);
  });

  test("accepts literal POSIX backslashes and exact empty unavailable states", () => {
    const value = {
      ...valid(),
      latest: {
        ...valid().latest,
        nodes: [{ kind: "file" as const, name: "tenant\\refund.ts", path: "tenant\\refund.ts", depth: 1 }],
        directoryCount: 0,
        fileCount: 1,
        scannedEntries: 1,
      },
      git: { available: false, failureReason: "not-repository", branch: null, clean: false, entries: [], changedCount: 0, truncated: false },
      nodeCount: 1,
    };

    expect(workspaceNavigatorPanelView(value)).toMatchObject({
      malformed: false,
      latest: { nodes: [{ path: "tenant\\refund.ts" }] },
      git: { available: false },
    });
  });

  test("fails closed on contradictory, accessor, and proxy snapshots", () => {
    const accessor = valid();
    let accessed = false;
    Object.defineProperty(accessor, "nodeCount", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("nodeCount accessor executed");
      },
    });
    const revoked = Proxy.revocable(valid(), {});
    revoked.revoke();
    const malformed = [
      null,
      { ...valid(), extra: true },
      { ...valid(), nodeCount: 499 },
      { ...valid(), latest: { ...valid().latest, directoryCount: 249 } },
      { ...valid(), latest: { ...valid().latest, scannedEntries: 4_096, truncated: false } },
      { ...valid(), latest: { ...valid().latest, path: "../outside" } },
      { ...valid(), latest: { ...valid().latest, nodes: [{ ...nodes[0], path: "/absolute" }, ...nodes.slice(1)] } },
      { ...valid(), latest: { ...valid().latest, nodes: [{ ...nodes[0], name: "different" }, ...nodes.slice(1)] } },
      { ...valid(), latest: { ...valid().latest, nodes: [{ ...nodes[0], depth: 2 }, ...nodes.slice(1)] } },
      { ...valid(), latest: { ...valid().latest, nodes: [{ ...nodes[0], kind: "file" }, ...nodes.slice(1)] } },
      { ...valid(), latest: { ...valid().latest, scannedEntries: 499 } },
      {
        ...valid(),
        latest: {
          ...valid().latest,
          nodes: Array.from({ length: 100 }, (_, index) => ({
            kind: "file" as const,
            name: `${index}-${"x".repeat(1_990)}`,
            path: `${index}-${"x".repeat(1_990)}`,
            depth: 1,
          })),
          directoryCount: 0,
          fileCount: 100,
        },
        nodeCount: 100,
      },
      { ...valid(), git: { ...valid().git, clean: true } },
      { ...valid(), git: { ...valid().git, failureReason: "timeout" } },
      { ...valid(), git: { ...valid().git, changedCount: 501, truncated: false } },
      { ...valid(), git: { ...valid().git, entries: [{ status: "invalid", path: "orders.ts" }] } },
      {
        ...valid(),
        git: {
          ...valid().git,
          entries: Array.from({ length: 100 }, (_, index) => ({ status: " M", path: `${index}-${"x".repeat(1_990)}` })),
          changedCount: 100,
        },
      },
      accessor,
      revoked.proxy,
    ];

    for (const value of malformed) expect(workspaceNavigatorPanelView(value)).toMatchObject({ malformed: true, latest: null, git: null, nodeCount: 0 });
    expect(accessed).toBe(false);
  });
});
