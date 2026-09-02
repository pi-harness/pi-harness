export interface BrowserSessionTab {
  readonly targetId: string;
  readonly title: string;
  readonly url: string;
}

export function browserSessionTabs(entries: readonly BrowserSessionTab[], limit: number): readonly BrowserSessionTab[] {
  const normalizedLimit = Math.max(0, Math.min(20, Math.trunc(limit)));
  return entries
    .filter((entry) => entry.targetId.trim() !== "" && entry.url.trim() !== "")
    .slice(0, normalizedLimit)
    .map((entry) => ({ targetId: entry.targetId, title: entry.title || "未命名页面", url: entry.url }));
}
