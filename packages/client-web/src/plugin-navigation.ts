export function installedPluginDetailPath(packageName: string): string {
  return `?page=plugins&plugin=${encodeURIComponent(packageName)}`;
}

export function readInstalledPluginDetailId(params: URLSearchParams): string | undefined {
  if (params.get("page") !== "plugins") return undefined;
  const id = params.get("plugin")?.trim();
  return id || undefined;
}
