import { ownRecord } from "./panel-safe.js";

export type OpenPetsMood = "idle" | "focused" | "happy" | "concerned";

const defaults = { nameCharacters: 128, recoveryEntries: 10_000, persistenceErrorCharacters: 2_000 } as const;
const moods = new Set<OpenPetsMood>(["idle", "focused", "happy", "concerned"]);
const events = new Set(["session_start", "agent_start", "agent_end", "tool_execution_end", "feed", "play", "set_mood"]);

function limit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= fallback ? value : fallback;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function boundedString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

export function openPetsPanelView(data: unknown) {
  const source = ownRecord(data) ?? {};
  const rawLimits = ownRecord(source.limits) ?? {};
  const limits = {
    nameCharacters: limit(rawLimits.nameCharacters, defaults.nameCharacters),
    recoveryEntries: limit(rawLimits.recoveryEntries, defaults.recoveryEntries),
    persistenceErrorCharacters: limit(rawLimits.persistenceErrorCharacters, defaults.persistenceErrorCharacters),
  };
  const rawRecovery = ownRecord(source.recovery) ?? {};
  const sessionEntries = nonNegativeInteger(rawRecovery.sessionEntries);
  const scanned = Math.min(sessionEntries, limits.recoveryEntries, nonNegativeInteger(rawRecovery.scanned));
  const rawPersistence = ownRecord(source.persistence) ?? {};
  const attempts = nonNegativeInteger(rawPersistence.attempts);
  const name = boundedString(source.name, limits.nameCharacters);
  const mood = typeof source.mood === "string" && moods.has(source.mood as OpenPetsMood) ? (source.mood as OpenPetsMood) : "idle";
  const lastEvent = typeof source.lastEvent === "string" && events.has(source.lastEvent) ? source.lastEvent : "session_start";
  const energy = typeof source.energy === "number" && Number.isSafeInteger(source.energy) && source.energy >= 0 && source.energy <= 100 ? source.energy : 80;
  return {
    name: name || "Pi",
    mood,
    energy,
    interactions: nonNegativeInteger(source.interactions),
    lastEvent,
    updatedAt: timestamp(source.updatedAt),
    recovery: {
      sessionEntries,
      scanned,
      truncated: rawRecovery.truncated === true || sessionEntries > scanned,
      restored: rawRecovery.restored === true,
    },
    persistence: {
      attempts,
      failures: Math.min(attempts, nonNegativeInteger(rawPersistence.failures)),
      lastError: boundedString(rawPersistence.lastError, limits.persistenceErrorCharacters) || null,
    },
    limits,
  };
}
