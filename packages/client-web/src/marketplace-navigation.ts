import { formatLocale, t } from "./i18n.js";

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
  return [{ id: "", label: t("全部"), count: total }, ...categories];
}

export interface MarketplaceCapabilityLabel {
  readonly id: string;
  readonly label: string;
}

/** The capability ids are what the filter and the URL carry, and the labels arrive beside them in the same catalogue response, so the console names a capability the way the catalogue does rather than keeping a second copy of the vocabulary that could drift from it. An id with no label reads as itself, which is what the moment before the first response looks like. */
export function marketplaceCapabilityLabeller(capabilities: readonly MarketplaceCapabilityLabel[]): (id: string) => string {
  const labels = new Map(capabilities.map((capability) => [capability.id, capability.label]));
  return (id) => labels.get(id) ?? id;
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

// Ten thousand is where Chinese and Japanese switch to their own myriad grouping and English switches to K, and Intl already knows which of those the active language wants, so the shortening is left to it rather than hard-coded to 万.
function compactDownloadCount(value: number): string {
  const locale = formatLocale();
  if (value >= 10_000) return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return new Intl.NumberFormat(locale).format(value);
}

export function marketplaceStatisticItems(statistics: MarketplaceStatisticsInput | undefined): readonly MarketplaceStatisticItem[] {
  if (statistics === undefined) return [];
  const items: MarketplaceStatisticItem[] = [];
  if (statistics.downloads30d !== undefined) items.push({ label: t("近 30 天下载量"), value: compactDownloadCount(statistics.downloads30d) });
  if (statistics.quality !== undefined) items.push({ label: t("npm 质量分"), value: String(Math.round(statistics.quality * 100)) });
  if (statistics.updatedAt !== undefined && Number.isFinite(Date.parse(statistics.updatedAt)))
    items.push({ label: t("npm 更新时间"), value: statistics.updatedAt.slice(0, 10) });
  return items;
}
