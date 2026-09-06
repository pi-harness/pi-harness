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

export interface MarketplaceStatisticsInput {
  readonly downloads30d?: number;
  readonly quality?: number;
  readonly updatedAt?: string;
}

export interface MarketplaceStatisticItem {
  readonly label: string;
  readonly value: string;
}

function compactDownloadCount(value: number): string {
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, "")} 万`;
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function marketplaceStatisticItems(statistics: MarketplaceStatisticsInput | undefined): readonly MarketplaceStatisticItem[] {
  if (statistics === undefined) return [];
  const items: MarketplaceStatisticItem[] = [];
  if (statistics.downloads30d !== undefined) items.push({ label: "近 30 天下载量", value: compactDownloadCount(statistics.downloads30d) });
  if (statistics.quality !== undefined) items.push({ label: "npm 质量分", value: String(Math.round(statistics.quality * 100)) });
  if (statistics.updatedAt !== undefined && Number.isFinite(Date.parse(statistics.updatedAt)))
    items.push({ label: "npm 更新时间", value: statistics.updatedAt.slice(0, 10) });
  return items;
}
