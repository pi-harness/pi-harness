import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "../config.js";

const customType = "pi-harness/openpets";
const maxNameLength = 128;
const maxRecoveryEntries = 10_000;
const maxPersistenceErrorLength = 2_000;
const parameterNames = new Set(["action", "mood"]);
type PetMood = "idle" | "focused" | "happy" | "concerned";
type PetParameters = { action: "status" } | { action: "feed" } | { action: "play" } | { action: "set_mood"; mood: PetMood };
type PetState = { name: string; mood: PetMood; energy: number; interactions: number; lastEvent: string; updatedAt: string };
type RecoveryState = { sessionEntries: number; scanned: number; truncated: boolean; restored: boolean };
type PersistenceState = { attempts: number; failures: number; lastError: string | null };

const petMoods = new Set<PetMood>(["idle", "focused", "happy", "concerned"]);
const petEvents = new Set(["session_start", "agent_start", "agent_end", "tool_execution_end", "feed", "play", "set_mood"]);

export interface OpenPetsPluginConfig {
  name?: string;
}

export const Config: z<OpenPetsPluginConfig> = z.object({ name: z.string().min(1).max(maxNameLength).default("Pi") });

function companionName(config: OpenPetsPluginConfig): string {
  assertKnownConfigKeys("OpenPets", config, ["name"]);
  const rawName = config.name ?? "Pi";
  if (typeof rawName !== "string" || rawName.length === 0 || rawName.length > maxNameLength)
    throw new Error(`OpenPets name must contain 1-${maxNameLength} characters`);
  if (rawName.includes("\0")) throw new Error("OpenPets name must not contain NUL characters");
  const name = rawName.trim();
  if (name === "") throw new Error("OpenPets name must contain a non-whitespace character");
  return name;
}

function petParameters(value: unknown): PetParameters {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("OpenPets parameters must be an object");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error("OpenPets parameters must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !parameterNames.has(key)))
    throw new Error("OpenPets parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("OpenPets parameters must use data properties");
  const action: unknown = descriptors.action?.value as unknown;
  if (action !== "status" && action !== "feed" && action !== "play" && action !== "set_mood")
    throw new Error("OpenPets action must be status, feed, play, or set_mood");
  const mood: unknown = descriptors.mood?.value as unknown;
  if (action !== "set_mood") {
    if (mood !== undefined) throw new Error("OpenPets mood is only allowed for set_mood");
    return { action };
  }
  if (mood !== "idle" && mood !== "focused" && mood !== "happy" && mood !== "concerned")
    throw new Error("OpenPets mood must be idle, focused, happy, or concerned");
  return { action, mood };
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("OpenPets action was cancelled", { cause: signal.reason });
}

function petSessionEvent(value: unknown): "agent_start" | "agent_end" | "tool_error" | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const typeDescriptor = descriptors.type;
  if (typeDescriptor === undefined || !("value" in typeDescriptor)) return undefined;
  if (typeDescriptor.value === "agent_start") return "agent_start";
  if (typeDescriptor.value === "agent_end") return "agent_end";
  if (typeDescriptor.value !== "tool_execution_end") return undefined;
  const errorDescriptor = descriptors.isError;
  return errorDescriptor !== undefined && "value" in errorDescriptor && errorDescriptor.value === true ? "tool_error" : undefined;
}

function clampEnergy(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function incrementInteractions(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function incrementCount(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function boundedPersistenceError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, maxPersistenceErrorLength);
  if (error !== null && typeof error === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") return descriptor.value.slice(0, maxPersistenceErrorLength);
  }
  return "Unknown OpenPets persistence error";
}

function initialState(name: string): PetState {
  return { name, mood: "idle", energy: 80, interactions: 0, lastEvent: "session_start", updatedAt: new Date(0).toISOString() };
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function persistedState(value: unknown, name: string): PetState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") || Object.values(descriptors).some((descriptor) => !("value" in descriptor)))
    return undefined;
  const mood = descriptors.mood?.value as unknown;
  const energy = descriptors.energy?.value as unknown;
  const interactions = descriptors.interactions?.value as unknown;
  const lastEvent = descriptors.lastEvent?.value as unknown;
  const updatedAt = descriptors.updatedAt?.value as unknown;
  return {
    name,
    mood: typeof mood === "string" && petMoods.has(mood as PetMood) ? (mood as PetMood) : "idle",
    energy: typeof energy === "number" && Number.isSafeInteger(energy) && energy >= 0 && energy <= 100 ? energy : 80,
    interactions: typeof interactions === "number" && Number.isSafeInteger(interactions) && interactions >= 0 ? interactions : 0,
    lastEvent: typeof lastEvent === "string" && petEvents.has(lastEvent) ? lastEvent : "session_start",
    updatedAt: validTimestamp(updatedAt) ? updatedAt : new Date(0).toISOString(),
  };
}

function entryData(entry: unknown): unknown {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(entry);
  if (!Object.values(descriptors).every((descriptor) => "value" in descriptor)) return undefined;
  if (descriptors.type?.value !== "custom" || descriptors.customType?.value !== customType) return undefined;
  return descriptors.data?.value;
}

function readState(context: Context, name: string): { state: PetState; recovery: RecoveryState } {
  const entries = context.piSession.manager.getEntries();
  const scanned = Math.min(entries.length, maxRecoveryEntries);
  const recovery: RecoveryState = { sessionEntries: entries.length, scanned, truncated: entries.length > scanned, restored: false };
  for (let index = entries.length - 1; index >= entries.length - scanned; index -= 1) {
    const data = entryData(entries[index]);
    if (data === undefined) continue;
    const state = persistedState(data, name);
    if (state !== undefined) return { state, recovery: { ...recovery, restored: true } };
  }
  return { state: initialState(name), recovery };
}

export default {
  name: "pi-openpets",
  inject: ["piSession", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: OpenPetsPluginConfig) {
    const name = companionName(config);
    const recovered = readState(context, name);
    let state = recovered.state;
    const persistence: PersistenceState = { attempts: 0, failures: 0, lastError: null };
    const persist = (next: PetState): void => {
      persistence.attempts = incrementCount(persistence.attempts);
      try {
        context.piSession.manager.appendCustomEntry(customType, { ...next });
        persistence.lastError = null;
      } catch (error) {
        persistence.failures = incrementCount(persistence.failures);
        persistence.lastError = boundedPersistenceError(error);
        throw error instanceof Error ? error : new Error("OpenPets persistence failed with a non-Error reason", { cause: error });
      }
    };
    const update = (next: Partial<PetState>, persistState = true): PetState => {
      state = { ...state, ...next, name, updatedAt: new Date().toISOString() };
      if (persistState) persist(state);
      return { ...state };
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      const type = petSessionEvent(event);
      try {
        if (type === "agent_start") update({ mood: "focused", energy: clampEnergy(state.energy - 5), lastEvent: type });
        else if (type === "agent_end") update({ mood: "happy", energy: clampEnergy(state.energy + 5), lastEvent: type });
        else if (type === "tool_error" && (state.mood !== "concerned" || state.lastEvent !== "tool_execution_end"))
          update({ mood: "concerned", lastEvent: "tool_execution_end" });
      } catch {
        // Session-event observers must not unwind the Agent run. The panel exposes the bounded persistence failure.
      }
    });
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "pet_react",
        label: "Pet companion",
        description: "Read or update the local OpenPets companion state for the current Pi session.",
        promptSnippet: "check the companion state or let the pet react",
        parameters: Type.Object(
          {
            action: Type.Union([Type.Literal("status"), Type.Literal("feed"), Type.Literal("play"), Type.Literal("set_mood")]),
            mood: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("focused"), Type.Literal("happy"), Type.Literal("concerned")])),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<PetState>> {
          return Promise.resolve().then(() => {
            const params = petParameters(rawParams);
            throwIfCancelled(signal);
            if (params.action === "status")
              return {
                content: [{ type: "text" as const, text: `${state.name}: ${state.mood}, energy ${state.energy}` }],
                details: { ...state },
              };
            if (params.action === "feed")
              return {
                content: [{ type: "text" as const, text: `${state.name} is refreshed.` }],
                details: update({ mood: "happy", energy: 100, interactions: incrementInteractions(state.interactions), lastEvent: "feed" }),
              };
            if (params.action === "play")
              return {
                content: [{ type: "text" as const, text: `${state.name} had a play break.` }],
                details: update({
                  mood: "happy",
                  energy: clampEnergy(state.energy + 10),
                  interactions: incrementInteractions(state.interactions),
                  lastEvent: "play",
                }),
              };
            return {
              content: [{ type: "text" as const, text: `${state.name} mood set to ${params.mood}.` }],
              details: update({ mood: params.mood, interactions: incrementInteractions(state.interactions), lastEvent: "set_mood" }),
            };
          });
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "openpets-panel",
        pluginId: "@pi-harness/core/plugins/openpets",
        title: "OpenPets",
        description: "根据 Pi 会话事件反应的本地桌面伙伴状态。",
        icon: "◉",
        read: () => ({
          ...state,
          recovery: { ...recovered.recovery },
          persistence: { ...persistence },
          limits: { nameCharacters: maxNameLength, recoveryEntries: maxRecoveryEntries, persistenceErrorCharacters: maxPersistenceErrorLength },
        }),
      });
    } catch (error) {
      unsubscribe();
      unregisterTool();
      throw error;
    }
    context.effect(() => () => {
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
