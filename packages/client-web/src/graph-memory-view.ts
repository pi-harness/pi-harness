type NodeKind = "task" | "skill" | "event";
type RelationKind = "USED_SKILL" | "SOLVED_BY" | "REQUIRES" | "PATCHES" | "CONFLICTS_WITH" | "RELATED_TO";

export interface GraphNodeView {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly summary: string;
  readonly source?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GraphRelationView {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly relation: RelationKind;
  readonly createdAt: string;
}

export interface GraphRecentRelationView extends GraphRelationView {
  readonly fromLabel: string;
  readonly toLabel: string;
}

export interface GraphSearchPanelView {
  readonly query: string;
  readonly total: number;
  readonly nodes: readonly GraphNodeView[];
  readonly relations: readonly GraphRelationView[];
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly nodesTruncated: boolean;
  readonly relationsOffset: number;
  readonly relationsTotal: number;
  readonly nextRelationsOffset: number | null;
  readonly relationsTruncated: boolean;
}

export interface GraphMemoryPanelView {
  readonly filePath: string;
  readonly nodes: number;
  readonly relations: number;
  readonly kinds: Readonly<Record<NodeKind, number>>;
  readonly recent: readonly GraphNodeView[];
  readonly recentRelations: readonly GraphRecentRelationView[];
  readonly lastSearch: GraphSearchPanelView | null;
  readonly limits: {
    readonly nodes: number;
    readonly relations: number;
    readonly fileBytes: number;
    readonly searchResults: number;
  };
  readonly truncated: boolean;
  readonly malformed: boolean;
}

const nodeKinds = new Set<NodeKind>(["task", "skill", "event"]);
const relationKinds = new Set<RelationKind>(["USED_SKILL", "SOLVED_BY", "REQUIRES", "PATCHES", "CONFLICTS_WITH", "RELATED_TO"]);
const rootKeys = new Set(["filePath", "nodes", "relations", "kinds", "recent", "recentRelations", "lastSearch", "limits"]);
const kindsKeys = new Set(["task", "skill", "event"]);
const limitsKeys = new Set(["nodes", "relations", "fileBytes", "searchResults"]);
const nodeKeys = new Set(["id", "kind", "label", "summary", "source", "createdAt", "updatedAt"]);
const requiredNodeKeys = new Set(["id", "kind", "label", "summary", "createdAt", "updatedAt"]);
const relationKeys = new Set(["id", "from", "to", "relation", "createdAt"]);
const recentRelationKeys = new Set([...relationKeys, "fromLabel", "toLabel"]);
const searchKeys = new Set([
  "query",
  "total",
  "nodes",
  "relations",
  "offset",
  "nextOffset",
  "nodesTruncated",
  "relationsOffset",
  "relationsTotal",
  "nextRelationsOffset",
  "relationsTruncated",
]);
const recentLimit = 8;
const maxNodes = 2_000;
const maxRelations = 5_000;
const maxSearchResults = 50;
const maxSearchRelations = maxSearchResults * 4;

function ownDataRecord(value: unknown, allowed: ReadonlySet<string>, required: ReadonlySet<string> = allowed): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length < required.size ||
      keys.length > allowed.size ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      [...required].some((key) => !keys.includes(key))
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function ownDataArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key) || String(Number(key)) !== key || Number(key) >= (length as number)),
      ) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
}

function safeInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : undefined;
}

function exactText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim() && !value.includes("\0") ? value : undefined;
}

function timestamp(value: unknown): { text: string; milliseconds: number } | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString() === value ? { text: value, milliseconds } : undefined;
  } catch {
    return undefined;
  }
}

function graphNode(value: unknown): GraphNodeView | undefined {
  const source = ownDataRecord(value, nodeKeys, requiredNodeKeys);
  if (source === undefined) return undefined;
  const id = exactText(source.id, 160);
  const label = exactText(source.label, 160);
  const summary =
    typeof source.summary === "string" &&
    source.summary.length <= 16 * 1024 &&
    source.summary.trim().length > 0 &&
    source.summary === source.summary.trim() &&
    !source.summary.includes("\0")
      ? source.summary
      : undefined;
  const provenance = source.source === undefined ? undefined : exactText(source.source, 512);
  const createdAt = timestamp(source.createdAt);
  const updatedAt = timestamp(source.updatedAt);
  if (
    id === undefined ||
    !nodeKinds.has(source.kind as NodeKind) ||
    label === undefined ||
    summary === undefined ||
    new TextEncoder().encode(summary).byteLength > 16 * 1024 ||
    (source.source !== undefined && provenance === undefined) ||
    createdAt === undefined ||
    updatedAt === undefined ||
    updatedAt.milliseconds < createdAt.milliseconds
  )
    return undefined;
  return {
    id,
    kind: source.kind as NodeKind,
    label,
    summary,
    ...(provenance === undefined ? {} : { source: provenance }),
    createdAt: createdAt.text,
    updatedAt: updatedAt.text,
  };
}

function graphRelation(value: unknown, withLabels: false): GraphRelationView | undefined;
function graphRelation(value: unknown, withLabels: true): GraphRecentRelationView | undefined;
function graphRelation(value: unknown, withLabels: boolean): GraphRelationView | GraphRecentRelationView | undefined {
  const source = ownDataRecord(value, withLabels ? recentRelationKeys : relationKeys);
  if (source === undefined) return undefined;
  const id = exactText(source.id, 160);
  const from = exactText(source.from, 160);
  const to = exactText(source.to, 160);
  const createdAt = timestamp(source.createdAt);
  if (
    id === undefined ||
    from === undefined ||
    to === undefined ||
    from === to ||
    !relationKinds.has(source.relation as RelationKind) ||
    createdAt === undefined
  )
    return undefined;
  const base = {
    id,
    from,
    to,
    relation: source.relation as RelationKind,
    createdAt: createdAt.text,
  };
  if (!withLabels) return base;
  const fromLabel = exactText(source.fromLabel, 160);
  const toLabel = exactText(source.toLabel, 160);
  return fromLabel === undefined || toLabel === undefined ? undefined : { ...base, fromLabel, toLabel };
}

function orderedUnique<T extends { id: string }>(items: readonly T[], date: (item: T) => string): boolean {
  return (
    new Set(items.map((item) => item.id)).size === items.length &&
    items.every((item, index) => index === 0 || Date.parse(date(items[index - 1])) >= Date.parse(date(item)))
  );
}

function sameNode(left: GraphNodeView, right: GraphNodeView): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.label === right.label &&
    left.summary === right.summary &&
    left.source === right.source &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function sameRelation(left: GraphRelationView, right: GraphRelationView): boolean {
  return left.id === right.id && left.from === right.from && left.to === right.to && left.relation === right.relation && left.createdAt === right.createdAt;
}

function cursor(value: unknown, maximum: number): number | null | undefined {
  return value === null ? null : safeInteger(value, maximum);
}

function graphSearch(value: unknown): GraphSearchPanelView | undefined {
  const source = ownDataRecord(value, searchKeys);
  if (source === undefined) return undefined;
  const query = exactText(source.query, 160);
  const total = safeInteger(source.total, maxNodes);
  const offset = safeInteger(source.offset, maxNodes);
  const nextOffset = cursor(source.nextOffset, maxNodes);
  const relationsOffset = safeInteger(source.relationsOffset, maxRelations);
  const relationsTotal = safeInteger(source.relationsTotal, maxRelations);
  const nextRelationsOffset = cursor(source.nextRelationsOffset, maxRelations);
  const rawNodes = ownDataArray(source.nodes, maxSearchResults);
  const rawRelations = ownDataArray(source.relations, maxSearchRelations);
  if (
    query === undefined ||
    total === undefined ||
    offset === undefined ||
    nextOffset === undefined ||
    relationsOffset === undefined ||
    relationsTotal === undefined ||
    nextRelationsOffset === undefined ||
    rawNodes === undefined ||
    rawRelations === undefined ||
    typeof source.nodesTruncated !== "boolean" ||
    typeof source.relationsTruncated !== "boolean" ||
    source.nodesTruncated !== (nextOffset !== null) ||
    source.relationsTruncated !== (nextRelationsOffset !== null)
  )
    return undefined;
  const nodes = rawNodes.map(graphNode);
  const relations = rawRelations.map((relation) => graphRelation(relation, false));
  if (nodes.some((node) => node === undefined) || relations.some((relation) => relation === undefined)) return undefined;
  const validNodes = nodes as GraphNodeView[];
  const validRelations = relations as GraphRelationView[];
  if (new Set(validNodes.map((node) => node.id)).size !== validNodes.length || !orderedUnique(validRelations, (relation) => relation.createdAt))
    return undefined;
  const nodeIds = new Set(validNodes.map((node) => node.id));
  if (validRelations.some((relation) => !nodeIds.has(relation.from) && !nodeIds.has(relation.to))) return undefined;
  const nodeEnd = offset + validNodes.length;
  const relationEnd = relationsOffset + validRelations.length;
  if (
    nodeEnd > Math.max(total, offset) ||
    (nextOffset !== null && nextOffset !== nodeEnd) ||
    (nextOffset === null && offset < total && nodeEnd < total) ||
    relationEnd > Math.max(relationsTotal, relationsOffset) ||
    (nextRelationsOffset !== null && nextRelationsOffset !== relationEnd) ||
    (nextRelationsOffset === null && relationsOffset < relationsTotal && relationEnd < relationsTotal)
  )
    return undefined;
  return {
    query,
    total,
    nodes: validNodes,
    relations: validRelations,
    offset,
    nextOffset,
    nodesTruncated: source.nodesTruncated,
    relationsOffset,
    relationsTotal,
    nextRelationsOffset,
    relationsTruncated: source.relationsTruncated,
  };
}

function malformedView(): GraphMemoryPanelView {
  return {
    filePath: "",
    nodes: 0,
    relations: 0,
    kinds: { task: 0, skill: 0, event: 0 },
    recent: [],
    recentRelations: [],
    lastSearch: null,
    limits: {
      nodes: maxNodes,
      relations: maxRelations,
      fileBytes: 4 * 1024 * 1024,
      searchResults: maxSearchResults,
    },
    truncated: false,
    malformed: true,
  };
}

export function graphMemoryPanelView(data: unknown): GraphMemoryPanelView {
  const source = ownDataRecord(data, rootKeys);
  if (source === undefined) return malformedView();
  const kindsSource = ownDataRecord(source.kinds, kindsKeys);
  const limitsSource = ownDataRecord(source.limits, limitsKeys);
  const recentRaw = ownDataArray(source.recent, recentLimit);
  const recentRelationsRaw = ownDataArray(source.recentRelations, recentLimit);
  const nodes = safeInteger(source.nodes, maxNodes);
  const relations = safeInteger(source.relations, maxRelations);
  const filePath =
    typeof source.filePath === "string" && source.filePath.length > 0 && source.filePath.length <= 4_096 && !source.filePath.includes("\0")
      ? source.filePath
      : undefined;
  if (
    kindsSource === undefined ||
    limitsSource === undefined ||
    recentRaw === undefined ||
    recentRelationsRaw === undefined ||
    nodes === undefined ||
    relations === undefined ||
    filePath === undefined
  )
    return malformedView();
  const task = safeInteger(kindsSource.task, maxNodes);
  const skill = safeInteger(kindsSource.skill, maxNodes);
  const event = safeInteger(kindsSource.event, maxNodes);
  const nodeLimit = positiveInteger(limitsSource.nodes, maxNodes);
  const relationLimit = positiveInteger(limitsSource.relations, maxRelations);
  const fileBytes = positiveInteger(limitsSource.fileBytes, 4 * 1024 * 1024);
  const searchResults = positiveInteger(limitsSource.searchResults, maxSearchResults);
  const recent = recentRaw.map(graphNode);
  const recentRelations = recentRelationsRaw.map((relation) => graphRelation(relation, true));
  const lastSearch = source.lastSearch === null ? null : graphSearch(source.lastSearch);
  if (
    task === undefined ||
    skill === undefined ||
    event === undefined ||
    task + skill + event !== nodes ||
    nodeLimit === undefined ||
    relationLimit === undefined ||
    nodes > nodeLimit ||
    relations > relationLimit ||
    fileBytes !== 4 * 1024 * 1024 ||
    searchResults !== maxSearchResults ||
    recent.some((node) => node === undefined) ||
    recentRelations.some((relation) => relation === undefined) ||
    recent.length !== Math.min(nodes, recentLimit) ||
    recentRelations.length !== Math.min(relations, recentLimit) ||
    lastSearch === undefined ||
    (lastSearch !== null && (lastSearch.total > nodes || lastSearch.relationsTotal > relations))
  )
    return malformedView();
  const validRecent = recent as GraphNodeView[];
  const validRecentRelations = recentRelations as GraphRecentRelationView[];
  if (!orderedUnique(validRecent, (node) => node.updatedAt) || !orderedUnique(validRecentRelations, (relation) => relation.createdAt)) return malformedView();
  const namedNodeIds = new Set<string>();
  const knownNodes = new Map<string, GraphNodeView>();
  for (const node of [...validRecent, ...(lastSearch?.nodes ?? [])]) {
    const existing = knownNodes.get(node.id);
    if (existing !== undefined && !sameNode(existing, node)) return malformedView();
    knownNodes.set(node.id, node);
    namedNodeIds.add(node.id);
  }
  const knownRelations = new Map<string, GraphRelationView>();
  const semanticRelations = new Set<string>();
  for (const relation of [...validRecentRelations, ...(lastSearch?.relations ?? [])]) {
    const existing = knownRelations.get(relation.id);
    if (existing !== undefined && !sameRelation(existing, relation)) return malformedView();
    const semanticId = `${relation.from}\0${relation.to}\0${relation.relation}`;
    if (existing === undefined && semanticRelations.has(semanticId)) return malformedView();
    knownRelations.set(relation.id, relation);
    semanticRelations.add(semanticId);
    namedNodeIds.add(relation.from);
    namedNodeIds.add(relation.to);
  }
  if (
    validRecentRelations.some(
      (relation) =>
        (knownNodes.has(relation.from) && knownNodes.get(relation.from)!.label !== relation.fromLabel) ||
        (knownNodes.has(relation.to) && knownNodes.get(relation.to)!.label !== relation.toLabel),
    )
  )
    return malformedView();
  const namedKinds = { task: 0, skill: 0, event: 0 };
  for (const node of knownNodes.values()) namedKinds[node.kind] += 1;
  if (namedKinds.task > task || namedKinds.skill > skill || namedKinds.event > event) return malformedView();
  if (namedNodeIds.size > nodes || knownRelations.size > relations) return malformedView();
  return {
    filePath,
    nodes,
    relations,
    kinds: { task, skill, event },
    recent: validRecent,
    recentRelations: validRecentRelations,
    lastSearch,
    limits: {
      nodes: nodeLimit,
      relations: relationLimit,
      fileBytes,
      searchResults,
    },
    truncated:
      nodes > validRecent.length || relations > validRecentRelations.length || lastSearch?.nodesTruncated === true || lastSearch?.relationsTruncated === true,
    malformed: false,
  };
}
