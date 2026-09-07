import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "../config.js";

const maxBlocks = 12;
const maxTitleLength = 256;
const maxLabelLength = 256;
const maxValueLength = 4_000;
const maxTotalTextLength = 16_384;
const blockTypes = new Set<BlockType>(["text", "badge", "progress"]);
const tones = new Set<Tone>(["neutral", "info", "success", "warning", "danger"]);
const decimalPattern = /^(?:\d+(?:\.\d+)?|\.\d+)$/u;

type BlockType = "text" | "badge" | "progress";
type Tone = "neutral" | "info" | "success" | "warning" | "danger";
type GenUiBlock = { type: BlockType; label: string; value: string | number; tone: Tone };
type GenUiReport = { title: string; blocks: GenUiBlock[]; renderedAt: string };
type NormalizedCard = { title: string; blocks: GenUiBlock[]; totalText: number };

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("GenUI render was cancelled", { cause: signal.reason });
}

function cleanText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (value.length > maximum) throw new Error(`${field} must be at most ${maximum} characters`);
  if (value.includes("\0")) throw new Error(`${field} must not contain NUL characters`);
  const text = value.trim();
  if (text.length === 0) throw new Error(`${field} must not be empty`);
  return text;
}

function dataDescriptors(value: unknown, field: string, allowed: ReadonlySet<string>): Record<PropertyKey, PropertyDescriptor> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const descriptors: Record<PropertyKey, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) throw new Error(`${field} contains an unknown property`);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error(`${field} must use data properties`);
  return descriptors;
}

function blockAt(value: unknown, index: number): { block: GenUiBlock; rawText: number } {
  const descriptors = dataDescriptors(value, `GenUI block ${index + 1}`, new Set(["type", "label", "value", "tone"]));
  const rawType: unknown = descriptors.type?.value;
  if (typeof rawType !== "string" || !blockTypes.has(rawType as BlockType)) throw new Error(`GenUI block type must be text, badge, or progress`);
  const type = rawType as BlockType;
  const label = cleanText(descriptors.label?.value as unknown, "Block label", maxLabelLength);
  const rawValue = cleanText(descriptors.value?.value as unknown, "Block value", maxValueLength);
  const rawTone: unknown = descriptors.tone?.value;
  if (rawTone !== undefined && (typeof rawTone !== "string" || !tones.has(rawTone as Tone)))
    throw new Error("GenUI block tone must be neutral, info, success, warning, or danger");
  const tone = rawTone === undefined ? (type === "progress" ? "info" : "neutral") : (rawTone as Tone);
  if (type !== "progress") return { block: { type, label, value: rawValue, tone }, rawText: label.length + rawValue.length };
  if (!decimalPattern.test(rawValue)) throw new Error("Progress value must be a decimal number from 0 to 100");
  const progress = Number(rawValue);
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error("Progress value must be a decimal number from 0 to 100");
  return { block: { type, label, value: progress, tone }, rawText: label.length + rawValue.length };
}

function normalizeCard(value: unknown): NormalizedCard {
  const descriptors = dataDescriptors(value, "GenUI parameters", new Set(["title", "blocks"]));
  const title = cleanText(descriptors.title?.value as unknown, "Title", maxTitleLength);
  const rawBlocks: unknown = descriptors.blocks?.value;
  if (!Array.isArray(rawBlocks)) throw new Error("GenUI blocks must be an array");
  if (rawBlocks.length === 0 || rawBlocks.length > maxBlocks) throw new Error(`GenUI requires 1 to ${maxBlocks} blocks`);
  const blockDescriptors = Object.getOwnPropertyDescriptors(rawBlocks);
  const blocks: GenUiBlock[] = [];
  let totalText = title.length;
  for (let index = 0; index < rawBlocks.length; index += 1) {
    const descriptor = blockDescriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) throw new Error("GenUI blocks must use dense data properties");
    const normalized = blockAt(descriptor.value as unknown, index);
    totalText += normalized.rawText;
    if (totalText > maxTotalTextLength) throw new Error(`GenUI total text must be at most ${maxTotalTextLength} characters`);
    blocks.push(normalized.block);
  }
  return { title, blocks, totalText };
}

function cloneReport(report: GenUiReport): GenUiReport {
  return { ...report, blocks: report.blocks.map((block) => ({ ...block })) };
}

export default {
  name: "pi-genui",
  inject: ["piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let rendered = 0;
    let latest: GenUiReport | undefined;
    const lifecycle = new AbortController();
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "genui_render",
        label: "Render structured UI",
        description: "Render bounded structured text, badge, and progress blocks in the GenUI panel; HTML and scripts are displayed as plain text.",
        promptSnippet: "render a bounded structured status card for the user",
        parameters: Type.Object(
          {
            title: Type.String({ minLength: 1, maxLength: maxTitleLength }),
            blocks: Type.Array(
              Type.Object({
                type: Type.Union([Type.Literal("text"), Type.Literal("badge"), Type.Literal("progress")]),
                label: Type.String({ minLength: 1, maxLength: maxLabelLength }),
                value: Type.String({ minLength: 1, maxLength: maxValueLength }),
                tone: Type.Optional(
                  Type.Union([Type.Literal("neutral"), Type.Literal("info"), Type.Literal("success"), Type.Literal("warning"), Type.Literal("danger")]),
                ),
              }),
              { minItems: 1, maxItems: maxBlocks },
            ),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<GenUiReport>> {
          return Promise.resolve().then(() => {
            const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            throwIfAborted(operationSignal);
            const card = normalizeCard(rawParams);
            throwIfAborted(operationSignal);
            const report: GenUiReport = { title: card.title, blocks: card.blocks, renderedAt: new Date().toISOString() };
            latest = cloneReport(report);
            rendered = Math.min(Number.MAX_SAFE_INTEGER, rendered + 1);
            return {
              content: [{ type: "text" as const, text: `Rendered ${report.blocks.length} structured UI block(s): ${report.title}` }],
              details: cloneReport(report),
            };
          });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "genui-panel",
      pluginId: "@pi-harness/core/plugins/genui",
      title: "GenUI",
      description: "渲染有界的结构化状态卡片；HTML 和脚本仅作为文本显示。",
      icon: "▤",
      read: () => ({
        rendered,
        latest: latest === undefined ? null : cloneReport(latest),
        limits: { blocks: maxBlocks, title: maxTitleLength, label: maxLabelLength, value: maxValueLength, totalText: maxTotalTextLength },
      }),
    });
    context.effect(() => () => {
      lifecycle.abort(new Error("GenUI plugin disposed"));
      unregisterTool();
      disposePanel();
    });
  },
};
