const themeIds = ["light", "midnight", "paper", "high-contrast"] as const;
const tokenKeys = [
  "--color-green-soft",
  "--color-red-soft",
  "--color-amber-soft",
  "--color-surface",
  "--color-inverse",
  "--color-ink",
  "--color-muted",
  "--color-faint",
  "--color-line",
  "--color-soft",
  "--color-blue",
  "--color-blue-soft",
  "--color-green",
  "--color-red",
  "--color-amber",
  "--color-empty",
  "--color-starter-border",
];
function record(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !("value" in descriptors[key])) return undefined;
      output[key] = descriptors[key].value;
    }
    return output;
  } catch {
    return undefined;
  }
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}]/u.test(value);
}
function color(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 48) return false;
  if (/^#[0-9a-f]{6}$/iu.test(value)) return true;
  const match = /^rgba\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3}),\s*(0|1|0\.\d{1,3})\)$/u.exec(value);
  return match !== null && match.slice(1, 4).every((part) => Number(part) <= 255);
}
export function themeStudioView(data: unknown) {
  const source = record(data),
    tokens = record(source?.tokens);
  if (!source || !tokens || Object.keys(tokens).length !== tokenKeys.length || !tokenKeys.every((key) => color(tokens[key]))) return undefined;
  const theme = source.theme;
  if (
    typeof theme !== "string" ||
    !themeIds.includes(theme as (typeof themeIds)[number]) ||
    !boundedText(source.label, 100) ||
    !boundedText(source.description, 300) ||
    !boundedText(source.sessionId, 128)
  )
    return undefined;
  if (
    typeof source.changed !== "boolean" ||
    (source.changed
      ? typeof source.changedAt !== "string" || !Number.isFinite(Date.parse(source.changedAt)) || new Date(source.changedAt).toISOString() !== source.changedAt
      : source.changedAt !== null)
  )
    return undefined;
  return {
    theme,
    label: source.label,
    description: source.description,
    sessionId: source.sessionId,
    changed: source.changed,
    changedAt: source.changedAt as string | null,
    tokens: tokens as Record<string, string>,
  };
}
