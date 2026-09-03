import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxCandidates = 50;
const maxText = 500;

export interface RewindCandidate {
  entryId: string;
  text: string;
}

export interface RewindResult {
  target: RewindCandidate;
  cancelled: boolean;
  editorText?: string;
  summarized: boolean;
}

export function selectRewindTarget(candidates: readonly RewindCandidate[], turns: number): RewindCandidate | undefined {
  if (!Number.isInteger(turns) || turns < 1 || turns > 20) throw new Error("Turn rewind count must be between 1 and 20");
  if (turns >= candidates.length) return undefined;
  return candidates[candidates.length - turns];
}

function currentCandidates(context: Context): RewindCandidate[] {
  const runtime = context.get("piRuntime");
  if (runtime === undefined) return [];
  return runtime.session
    .getUserMessagesForForking()
    .slice(-maxCandidates)
    .map((item) => ({ entryId: item.entryId, text: item.text.slice(0, maxText) }));
}

export default {
  name: "pi-turn-rewind",
  inject: ["piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: RewindResult | undefined;
    const unregister = context.piTools.register(
      defineTool({
        name: "session_rewind",
        label: "Rewind session turn",
        description: "Navigate the native Pi session tree back to a prior user turn while preserving the abandoned branch.",
        promptSnippet: "rewind the current session to a previous user turn without deleting history",
        parameters: Type.Object({
          turns: Type.Optional(Type.Number({ description: "How many user turns to rewind, from 1 to 20" })),
          entryId: Type.Optional(Type.String({ description: "Exact native session entry ID to navigate to" })),
          summarize: Type.Optional(Type.Boolean({ description: "Ask Pi to summarize the abandoned branch" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<RewindResult>> {
          const runtime = context.get("piRuntime");
          if (runtime === undefined) throw new Error("Pi runtime is not ready");
          if (runtime.session.isStreaming) throw new Error("Cannot rewind while a prompt is running");
          const candidates = currentCandidates(context);
          const requestedId = params.entryId?.trim();
          const target = requestedId ? candidates.find((candidate) => candidate.entryId === requestedId) : selectRewindTarget(candidates, params.turns ?? 1);
          if (target === undefined) throw new Error("No matching previous user turn was found");
          const result = await runtime.session.navigateTree(target.entryId, { summarize: params.summarize === true });
          latest = {
            target,
            cancelled: result.cancelled,
            ...(result.editorText === undefined ? {} : { editorText: result.editorText }),
            summarized: params.summarize === true,
          };
          return {
            content: [{ type: "text", text: result.cancelled ? "Session rewind was cancelled." : `Session rewound to: ${target.text}` }],
            details: latest,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "turn-rewind-panel",
      pluginId: "@pi-harness/core/plugins/turn-rewind",
      title: "Turn Rewind",
      description: "回到之前的用户轮次并保留原分支，不直接删除会话历史。",
      icon: "↶",
      read: () => ({ candidates: currentCandidates(context), latest: latest ?? null }),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
