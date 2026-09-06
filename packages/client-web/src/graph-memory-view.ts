type RelationKind = "USED_SKILL" | "SOLVED_BY" | "REQUIRES" | "PATCHES" | "CONFLICTS_WITH" | "RELATED_TO";

const relationKinds = new Set<RelationKind>(["USED_SKILL", "SOLVED_BY", "REQUIRES", "PATCHES", "CONFLICTS_WITH", "RELATED_TO"]);
const defaults = { nodes: 2_000, relations: 5_000, fileBytes: 4_194_304, searchResults: 50 };
const recentLimit = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function text(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, maximum) : undefined;
}

function time(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function node(value: unknown) {
  if (!isRecord(value) || typeof value.id !== "string" || (value.kind !== "task" && value.kind !== "skill" && value.kind !== "event")) return undefined;
  const label = text(value.label, 160);
  const summary = text(value.summary, 2_000);
  if (label === undefined || summary === undefined) return undefined;
  return {
    id: value.id.slice(0, 160),
    kind: value.kind,
    label,
    summary,
    source: text(value.source, 512) ?? null,
    updatedAt: time(value.updatedAt),
  };
}

function relation(value: unknown) {
  if (!isRecord(value) || typeof value.relation !== "string" || !relationKinds.has(value.relation as RelationKind)) return undefined;
  const kind = value.relation as RelationKind;
  const fromLabel = text(value.fromLabel ?? value.from, 160);
  const toLabel = text(value.toLabel ?? value.to, 160);
  if (fromLabel === undefined || toLabel === undefined) return undefined;
  return { id: text(value.id, 160) ?? "relation", relation: kind, fromLabel, toLabel, createdAt: time(value.createdAt) };
}

export function graphMemoryPanelView(data: unknown) {
  const source = isRecord(data) ? data : {};
  const rawRecent = Array.isArray(source.recent) ? source.recent : [];
  const visibleRecent = rawRecent.slice(0, recentLimit);
  const recent = visibleRecent.map(node).filter((item): item is NonNullable<ReturnType<typeof node>> => item !== undefined);
  const rawRelations = Array.isArray(source.recentRelations) ? source.recentRelations : [];
  const visibleRelations = rawRelations.slice(0, recentLimit);
  const recentRelations = visibleRelations.map(relation).filter((item): item is NonNullable<ReturnType<typeof relation>> => item !== undefined);
  const rawKinds = isRecord(source.kinds) ? source.kinds : {};
  const rawLimits = isRecord(source.limits) ? source.limits : {};
  const rawSearch = isRecord(source.lastSearch) ? source.lastSearch : undefined;
  const searchNodes = rawSearch !== undefined && Array.isArray(rawSearch.nodes) ? Math.min(rawSearch.nodes.length, defaults.searchResults) : 0;
  const query = rawSearch === undefined ? undefined : text(rawSearch.query, 160);
  const stringTruncated = visibleRecent.some(
    (item) =>
      isRecord(item) && [item.label, item.summary, item.source].some((value, index) => typeof value === "string" && value.length > [160, 2_000, 512][index]),
  );
  const truncated =
    rawRecent.length > recentLimit ||
    recent.length !== visibleRecent.length ||
    rawRelations.length > recentLimit ||
    recentRelations.length !== visibleRelations.length ||
    stringTruncated ||
    (rawSearch !== undefined && typeof rawSearch.query === "string" && rawSearch.query.length > 160) ||
    (rawSearch !== undefined && Array.isArray(rawSearch.nodes) && rawSearch.nodes.length > defaults.searchResults);
  return {
    nodes: count(source.nodes, recent.length),
    relations: count(source.relations, recentRelations.length),
    kinds: { task: count(rawKinds.task, 0), skill: count(rawKinds.skill, 0), event: count(rawKinds.event, 0) },
    recent,
    recentRelations,
    lastSearch: rawSearch === undefined || query === undefined ? null : { query, total: count(rawSearch.total, searchNodes), shown: searchNodes },
    limits: {
      nodes: positive(rawLimits.nodes, defaults.nodes),
      relations: positive(rawLimits.relations, defaults.relations),
      fileBytes: positive(rawLimits.fileBytes, defaults.fileBytes),
      searchResults: positive(rawLimits.searchResults, defaults.searchResults),
    },
    truncated,
  };
}
