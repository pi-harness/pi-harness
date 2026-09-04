import { describe, expect, it } from "vitest";
import type { ClientMarketplacePage, ClientMarketplacePlugin } from "../src/control-room.js";
import { loadMarketplaceCatalog } from "../src/marketplace-catalog.js";

const plugin = (id: string): ClientMarketplacePlugin => ({
  id,
  packageName: `example-${id}`,
  version: "1.0.0",
  name: id,
  description: id,
  author: "example",
  repository: "https://example.com",
  license: "MIT",
  source: "official",
  status: "verified",
  category: { id: "tools", label: "工具" },
  capabilities: [],
  hooks: [],
  profile: { name: id, config: {} },
});

const page = (items: readonly ClientMarketplacePlugin[], pageNumber: number, total: number, hasNext: boolean): ClientMarketplacePage => ({
  items,
  capabilities: [],
  categories: [],
  total,
  page: pageNumber,
  pageSize: 100,
  hasNext,
});

describe("marketplace catalog loading", () => {
  it("loads every page instead of reusing the visible marketplace page", async () => {
    const calls: number[] = [];
    const pages = [page([plugin("first")], 0, 2, true), page([plugin("second")], 1, 2, false)];
    const items = await loadMarketplaceCatalog({
      listMarketplace: (_query, _capability, pageNumber) => {
        calls.push(pageNumber ?? 0);
        return Promise.resolve(pages[pageNumber ?? 0]!);
      },
    });

    expect(items.map((item) => item.id)).toEqual(["first", "second"]);
    expect(calls).toEqual([0, 1]);
  });

  it("stops safely if a backend reports another page but returns no items", async () => {
    const items = await loadMarketplaceCatalog({ listMarketplace: () => Promise.resolve(page([], 0, 1, true)) });

    expect(items).toEqual([]);
  });
});
