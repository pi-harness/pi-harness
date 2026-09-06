import { ownRecord } from "./panel-safe.js";

export type PluginDevStatus = "idle" | "queued" | "running" | "reloaded" | "failed" | "cancelled";

const defaults = { reasonCharacters: 1_000, errorCharacters: 2_000 } as const;
const statuses = new Set<PluginDevStatus>(["idle", "queued", "running", "reloaded", "failed", "cancelled"]);

function boundedString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function optionalString(value: unknown, maximum: number): string | null {
  const text = boundedString(value, maximum);
  return text === "" ? null : text;
}

function limit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= fallback ? value : fallback;
}

export function pluginDevPanelView(data: unknown) {
  const source = ownRecord(data) ?? {};
  const rawLimits = ownRecord(source.limits) ?? {};
  const limits = {
    reasonCharacters: limit(rawLimits.reasonCharacters, defaults.reasonCharacters),
    errorCharacters: limit(rawLimits.errorCharacters, defaults.errorCharacters),
  };
  const status = typeof source.status === "string" && statuses.has(source.status as PluginDevStatus) ? (source.status as PluginDevStatus) : "idle";
  return {
    status,
    reason: boundedString(source.reason, limits.reasonCharacters),
    requestedAt: optionalString(source.requestedAt, 64),
    startedAt: optionalString(source.startedAt, 64),
    reloadedAt: optionalString(source.reloadedAt, 64),
    error: optionalString(source.error, limits.errorCharacters),
    busy: status === "queued" || status === "running",
    limits,
  };
}
