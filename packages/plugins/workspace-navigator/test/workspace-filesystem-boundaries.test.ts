import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

const filesystem = vi.hoisted(() => ({ lstat: vi.fn(), opendir: vi.fn(), realpath: vi.fn() }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  filesystem.lstat.mockImplementation(actual.lstat);
  filesystem.opendir.mockImplementation(actual.opendir);
  filesystem.realpath.mockImplementation(actual.realpath);
  return { ...actual, lstat: filesystem.lstat, opendir: filesystem.opendir, realpath: filesystem.realpath };
});

import { listWorkspaceNodes } from "../src/index.js";

describe("workspace filesystem boundaries", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    filesystem.lstat.mockReset();
    filesystem.opendir.mockReset();
    filesystem.realpath.mockReset();
    filesystem.lstat.mockImplementation(actual.lstat);
    filesystem.opendir.mockImplementation(actual.opendir);
    filesystem.realpath.mockImplementation(actual.realpath);
  });

  test("rechecks ignored directories after authoritative lstat when dirent type is unknown", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "pi-navigator-unknown-dirent-"));
    await mkdir(join(root, "parent", "node_modules"), { recursive: true });
    await writeFile(join(root, "parent", "node_modules", "hidden.js"), "hidden\n");
    filesystem.opendir.mockImplementation(async (...args: Parameters<typeof actual.opendir>) => {
      const handle = await actual.opendir(...args);
      const read = handle.read.bind(handle);
      handle.read = async () => {
        const entry = await read();
        if (entry !== null && Buffer.isBuffer(entry.name) && entry.name.equals(Buffer.from("node_modules"))) {
          Object.defineProperty(entry, "isDirectory", { configurable: true, value: () => false });
        }
        return entry;
      };
      return handle;
    });
    try {
      await expect(listWorkspaceNodes(root, { maxDepth: 1 })).resolves.toMatchObject({
        nodes: [{ kind: "directory", path: "parent", depth: 1 }],
        truncated: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not follow a directory replaced by an external symlink before recursion", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "pi-navigator-race-root-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-navigator-race-outside-"));
    const inside = join(root, "inside");
    const parked = join(root, "parked");
    await mkdir(inside);
    await writeFile(join(inside, "safe.txt"), "safe\n");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    const canonicalRoot = await actual.realpath(root);
    filesystem.opendir.mockImplementation(async (...args: Parameters<typeof actual.opendir>) => {
      const handle = await actual.opendir(...args);
      if (args[0].toString() !== canonicalRoot) return handle;
      const read = handle.read.bind(handle);
      let replaced = false;
      handle.read = async () => {
        const entry = await read();
        if (entry === null && !replaced) {
          replaced = true;
          await rename(inside, parked);
          await symlink(outside, inside, "dir");
        }
        return entry;
      };
      return handle;
    });
    try {
      const result = await listWorkspaceNodes(root, { maxDepth: 3 });
      expect(result.nodes.some((node) => node.path === "inside")).toBe(false);
      expect(result.nodes.some((node) => node.path.includes("secret.txt"))).toBe(false);
      expect(result.truncated).toBe(true);
    } finally {
      filesystem.opendir.mockImplementation(actual.opendir);
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("skips undecodable byte names and marks the tree incomplete", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "pi-navigator-byte-name-"));
    filesystem.opendir.mockImplementation(async (...args: Parameters<typeof actual.opendir>) => {
      const handle = await actual.opendir(...args);
      let returned = false;
      const byteHandle = handle as unknown as { read: () => Promise<unknown> };
      byteHandle.read = async () => {
        if (returned) return null;
        returned = true;
        return {
          name: Buffer.from([0xff]),
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      };
      return handle;
    });
    try {
      await expect(listWorkspaceNodes(root)).resolves.toMatchObject({ nodes: [], scannedEntries: 1, truncated: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
