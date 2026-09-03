export interface PluginStarsRowInput {
  readonly fullName: string;
  readonly name: string;
  readonly stars: number;
  readonly htmlUrl: string;
  readonly updatedAt: string;
}

export interface PluginStarsRow extends PluginStarsRowInput {
  readonly rank: number;
}

export function pluginStarsRows(entries: readonly PluginStarsRowInput[], limit: number): readonly PluginStarsRow[] {
  const normalizedLimit = Math.max(0, Math.min(50, Math.trunc(limit)));
  return [...entries]
    .sort((left, right) => right.stars - left.stars || left.fullName.localeCompare(right.fullName))
    .slice(0, normalizedLimit)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}
