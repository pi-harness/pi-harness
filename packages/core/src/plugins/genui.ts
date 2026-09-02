import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxBlocks = 12;
const maxTextLength = 4000;
type BlockType = "text" | "badge" | "progress";
type Tone = "neutral" | "info" | "success" | "warning" | "danger";
type GenUiBlock = { type: BlockType; label: string; value: string | number; tone: Tone };
type GenUiReport = { title: string; blocks: GenUiBlock[]; renderedAt: string };

function cleanText(value: string, field: string): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`${field} must not be empty`);
  if (text.length > maxTextLength) throw new Error(`${field} must be at most ${maxTextLength} characters`);
  return text;
}

function normalizeBlock(block: { type: BlockType; label: string; value: string; tone?: Tone }): GenUiBlock {
  const label = cleanText(block.label, "Block label");
  const rawValue = cleanText(block.value, "Block value");
  if (block.type !== "progress") return { type: block.type, label, value: rawValue, tone: block.tone ?? "neutral" };
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Progress value must be a number from 0 to 100");
  return { type: "progress", label, value, tone: block.tone ?? "info" };
}

export default {
  name: "pi-genui",
  inject: ["piPluginUi", "piTools"],
  apply(context: Context) {
    let rendered = 0;
    let latest: GenUiReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "genui_render",
        label: "Render structured UI",
        description: "Render safe structured text, badge, and progress blocks in the GenUI panel; HTML and scripts are treated as plain text.",
        promptSnippet: "render a structured status card for the user",
        parameters: Type.Object({
          title: Type.String(),
          blocks: Type.Array(
            Type.Object({
              type: Type.Union(["text", "badge", "progress"]),
              label: Type.String(),
              value: Type.String(),
              tone: Type.Optional(Type.Union(["neutral", "info", "success", "warning", "danger"])),
            }),
          ),
        }),
        execute(_toolCallId, params): Promise<AgentToolResult<GenUiReport>> {
          return Promise.resolve().then(() => {
            if (params.blocks.length === 0 || params.blocks.length > maxBlocks) throw new Error(`GenUI requires 1 to ${maxBlocks} blocks`);
            latest = {
              title: cleanText(params.title, "Title"),
              blocks: params.blocks.map((block) =>
                normalizeBlock({
                  type: block.type as BlockType,
                  label: block.label,
                  value: block.value,
                  ...(block.tone === undefined ? {} : { tone: block.tone as Tone }),
                }),
              ),
              renderedAt: new Date().toISOString(),
            };
            rendered += 1;
            return {
              content: [{ type: "text" as const, text: `Rendered ${latest.blocks.length} structured UI block(s): ${latest.title}` }],
              details: latest,
            };
          });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "genui-panel",
      pluginId: "@pi-harness/core/plugins/genui",
      title: "GenUI",
      description: "渲染安全的结构化状态卡片；文本中的 HTML 和脚本不会被执行。",
      icon: "▤",
      read: () => ({ rendered, latest: latest ?? null }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
