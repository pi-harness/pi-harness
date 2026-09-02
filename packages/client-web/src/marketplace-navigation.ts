export function marketplaceDetailPath(id: string): string {
  return `?page=marketplace&plugin=${encodeURIComponent(id)}`;
}

export function readMarketplaceDetailId(params: URLSearchParams): string | undefined {
  if (params.get("page") !== "marketplace") return undefined;
  const id = params.get("plugin")?.trim();
  return id || undefined;
}

export interface MarketplaceCategoryTab {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

export function marketplaceCategoryTabs(categories: readonly MarketplaceCategoryTab[]): readonly MarketplaceCategoryTab[] {
  const total = categories.reduce((sum, category) => sum + category.count, 0);
  return [{ id: "", label: "全部", count: total }, ...categories];
}
