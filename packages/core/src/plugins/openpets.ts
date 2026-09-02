import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const customType = "pi-harness/openpets";
type PetMood = "idle" | "focused" | "happy" | "concerned";
type PetState = { name: string; mood: PetMood; energy: number; interactions: number; lastEvent: string; updatedAt: string };

export interface OpenPetsPluginConfig {
  name?: string;
}

export const Config: z<OpenPetsPluginConfig> = z.object({ name: z.string().default("Pi") });

function clampEnergy(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function initialState(name: string): PetState {
  return { name, mood: "idle", energy: 80, interactions: 0, lastEvent: "session_start", updatedAt: new Date(0).toISOString() };
}

function readState(context: Context, name: string): PetState {
  const entry = [...context.piSession.manager.getEntries()].reverse().find((item) => item.type === "custom" && item.customType === customType);
  if (entry?.type !== "custom" || entry.data === undefined || typeof entry.data !== "object" || entry.data === null) return initialState(name);
  const value = entry.data as Partial<PetState>;
  const mood: PetMood = value.mood === "focused" || value.mood === "happy" || value.mood === "concerned" ? value.mood : "idle";
  return {
    name: typeof value.name === "string" && value.name.trim() !== "" ? value.name : name,
    mood,
    energy: typeof value.energy === "number" ? clampEnergy(value.energy) : 80,
    interactions: typeof value.interactions === "number" && Number.isFinite(value.interactions) ? Math.max(0, Math.trunc(value.interactions)) : 0,
    lastEvent: typeof value.lastEvent === "string" ? value.lastEvent : "session_start",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

function persist(context: Context, state: PetState): void {
  context.piSession.manager.appendCustomEntry(customType, state);
}

export default {
  name: "pi-openpets",
  inject: ["piSession", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: OpenPetsPluginConfig) {
    const name = config.name?.trim() || "Pi";
    let state = readState(context, name);
    const update = (next: Partial<PetState>, persistState = true): PetState => {
      state = { ...state, ...next, name, updatedAt: new Date().toISOString() };
      if (persistState) persist(context, state);
      return state;
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      if (event.type === "agent_start") update({ mood: "focused", energy: clampEnergy(state.energy - 5), lastEvent: event.type });
      else if (event.type === "agent_end") update({ mood: "happy", energy: clampEnergy(state.energy + 5), lastEvent: event.type });
      else if (event.type === "tool_execution_end" && "isError" in event && event.isError === true) update({ mood: "concerned", lastEvent: event.type });
    });
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "pet_react",
        label: "Pet companion",
        description: "Read or update the local OpenPets companion state for the current Pi session.",
        promptSnippet: "check the companion state or let the pet react",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("status"), Type.Literal("feed"), Type.Literal("play"), Type.Literal("set_mood")]),
          mood: Type.Optional(Type.String()),
        }),
        execute(_toolCallId, params): Promise<AgentToolResult<PetState>> {
          return Promise.resolve().then(() => {
            if (params.action === "status")
              return { content: [{ type: "text" as const, text: `${state.name}: ${state.mood}, energy ${state.energy}` }], details: state };
            if (params.action === "feed")
              return {
                content: [{ type: "text" as const, text: `${state.name} is refreshed.` }],
                details: update({ mood: "happy", energy: 100, interactions: state.interactions + 1, lastEvent: "feed" }),
              };
            if (params.action === "play")
              return {
                content: [{ type: "text" as const, text: `${state.name} had a play break.` }],
                details: update({ mood: "happy", energy: clampEnergy(state.energy + 10), interactions: state.interactions + 1, lastEvent: "play" }),
              };
            const mood = params.mood?.trim();
            if (mood !== "idle" && mood !== "focused" && mood !== "happy" && mood !== "concerned")
              throw new Error("mood must be idle, focused, happy, or concerned");
            return {
              content: [{ type: "text" as const, text: `${state.name} mood set to ${mood}.` }],
              details: update({ mood, interactions: state.interactions + 1, lastEvent: "set_mood" }),
            };
          });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "openpets-panel",
      pluginId: "@pi-harness/core/plugins/openpets",
      title: "OpenPets",
      description: "根据 Pi 会话事件反应的本地桌面伙伴状态。",
      icon: "◉",
      read: () => state,
    });
    context.effect(() => () => {
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
