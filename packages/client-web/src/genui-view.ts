type BlockType = "text" | "badge" | "progress";
type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export interface GenUiBlockView {
  readonly type: BlockType;
  readonly label: string;
  readonly value: string | number;
  readonly tone: Tone;
}

export interface GenUiCardView {
  readonly title: string;
  readonly renderedAt: string | null;
  readonly blocks: readonly GenUiBlockView[];
  readonly truncated: boolean;
}

export interface GenUiPanelView {
  readonly rendered: number;
  readonly latest: GenUiCardView | null;
  readonly limits: { readonly blocks: number; readonly title: number; readonly label: number; readonly value: number; readonly totalText: number };
}

const defaultLimits = { blocks: 12, title: 256, label: 256, value: 4_000, totalText: 16_384 } as const;
const visibleValueLimit = 2_000;
const blockTypes = new Set<BlockType>(["text", "badge", "progress"]);
const tones = new Set<Tone>(["neutral", "info", "success", "warning", "danger"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function block(value: unknown): GenUiBlockView | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || !blockTypes.has(value.type as BlockType)) return undefined;
  if (typeof value.label !== "string" || value.label.trim() === "" || typeof value.tone !== "string" || !tones.has(value.tone as Tone)) return undefined;
  const type = value.type as BlockType;
  const tone = value.tone as Tone;
  if (type === "progress") {
    if (typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0 || value.value > 100) return undefined;
    return { type, label: value.label.slice(0, defaultLimits.label), value: value.value, tone };
  }
  if (typeof value.value !== "string") return undefined;
  return { type, label: value.label.slice(0, defaultLimits.label), value: value.value.slice(0, visibleValueLimit), tone };
}

function card(value: unknown): GenUiCardView | null {
  if (!isRecord(value) || typeof value.title !== "string" || value.title.trim() === "" || !Array.isArray(value.blocks)) return null;
  const blocks = value.blocks
    .slice(0, defaultLimits.blocks)
    .map(block)
    .filter((item): item is GenUiBlockView => item !== undefined);
  const renderedAt = typeof value.renderedAt === "string" && Number.isFinite(Date.parse(value.renderedAt)) ? new Date(value.renderedAt).toISOString() : null;
  return {
    title: value.title.slice(0, defaultLimits.title),
    renderedAt,
    blocks,
    truncated:
      value.title.length > defaultLimits.title ||
      value.blocks.length > defaultLimits.blocks ||
      blocks.length !== Math.min(value.blocks.length, defaultLimits.blocks) ||
      value.blocks.some(
        (item) =>
          isRecord(item) &&
          ((typeof item.label === "string" && item.label.length > defaultLimits.label) ||
            (typeof item.value === "string" && item.value.length > visibleValueLimit)),
      ),
  };
}

export function genUiPanelView(data: unknown): GenUiPanelView {
  const source = isRecord(data) ? data : {};
  const limits = isRecord(source.limits) ? source.limits : {};
  return {
    rendered: count(source.rendered, 0),
    latest: card(source.latest),
    limits: {
      blocks: count(limits.blocks, defaultLimits.blocks) || defaultLimits.blocks,
      title: count(limits.title, defaultLimits.title) || defaultLimits.title,
      label: count(limits.label, defaultLimits.label) || defaultLimits.label,
      value: count(limits.value, defaultLimits.value) || defaultLimits.value,
      totalText: count(limits.totalText, defaultLimits.totalText) || defaultLimits.totalText,
    },
  };
}
