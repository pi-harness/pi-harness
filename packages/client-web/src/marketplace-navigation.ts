export function marketplaceDetailPath(id: string): string {
  return `?page=marketplace&plugin=${encodeURIComponent(id)}`;
}

export function readMarketplaceDetailId(params: URLSearchParams): string | undefined {
  if (params.get("page") !== "marketplace") return undefined;
  const id = params.get("plugin")?.trim();
  return id || undefined;
}
