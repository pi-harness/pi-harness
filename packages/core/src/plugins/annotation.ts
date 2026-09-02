import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxQuoteLength = 4_000;
const maxNoteLength = 1_000;
const maxAnnotations = 50;

export interface Annotation {
  id: number;
  quote: string;
  note: string;
  createdAt: string;
}

export interface AnnotationReport {
  count: number;
  annotations: Annotation[];
}

function requiredText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (text.length === 0 || text.length > max) throw new Error(`${label} must contain 1-${max} characters`);
  return text;
}

function formatPrompt(annotations: readonly Annotation[], question: string): string {
  const lines = annotations.flatMap((item) => [`${item.id}. ${item.quote}`, ...(item.note === "" ? [] : [`   Note: ${item.note}`])]);
  const instruction = annotations.map((item) => `Annotation ${item.id}: …`).join("; ");
  const body = lines.join("\n");
  const ask = question.trim();
  return `I annotated the following ${annotations.length} passage(s):\n\n${body}\n\nPlease respond to each annotation using ${instruction}.\n\nAsk:\n${ask}`;
}

export default {
  name: "pi-annotation",
  inject: ["piPluginUi", "piTools"],
  apply(context: Context) {
    let annotations: Annotation[] = [];
    let lastPrompt: string | undefined;
    const report = (): AnnotationReport => ({ count: annotations.length, annotations: [...annotations] });
    const unregister = context.piTools.register(
      defineTool({
        name: "annotation_manage",
        label: "Manage annotations",
        description: "Collect numbered passage annotations and render them into a model-ready prompt block.",
        promptSnippet: "collect a passage annotation and prepare it for the next question",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("remove"), Type.Literal("clear"), Type.Literal("prompt")]),
          quote: Type.Optional(Type.String()),
          note: Type.Optional(Type.String()),
          id: Type.Optional(Type.Number()),
          question: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<AnnotationReport | Annotation | { prompt: string }>> {
          await Promise.resolve();
          if (params.action === "add") {
            if (annotations.length >= maxAnnotations) throw new Error(`At most ${maxAnnotations} annotations can be collected`);
            const quote = requiredText(params.quote ?? "", "Annotation quote", maxQuoteLength);
            const note = (params.note ?? "").trim();
            if (note.length > maxNoteLength) throw new Error(`Annotation note must contain 0-${maxNoteLength} characters`);
            const annotation: Annotation = {
              id: annotations.length === 0 ? 1 : Math.max(...annotations.map((item) => item.id)) + 1,
              quote,
              note,
              createdAt: new Date().toISOString(),
            };
            annotations = [...annotations, annotation];
            return { content: [{ type: "text", text: `Annotation ${annotation.id} added.` }], details: annotation };
          }
          if (params.action === "remove") {
            if (!Number.isInteger(params.id) || params.id === undefined) throw new Error("Annotation id is required");
            const before = annotations.length;
            annotations = annotations.filter((item) => item.id !== params.id);
            if (annotations.length === before) throw new Error(`Annotation ${params.id} was not found`);
            return { content: [{ type: "text", text: `Annotation ${params.id} removed.` }], details: report() };
          }
          if (params.action === "clear") {
            annotations = [];
            lastPrompt = undefined;
            return { content: [{ type: "text", text: "Annotations cleared." }], details: report() };
          }
          if (params.action === "prompt") {
            if (annotations.length === 0) throw new Error("Add at least one annotation before rendering a prompt");
            const prompt = formatPrompt(annotations, params.question ?? "");
            lastPrompt = prompt;
            return { content: [{ type: "text", text: prompt }], details: { prompt } };
          }
          return { content: [{ type: "text", text: `${annotations.length} annotation(s) collected.` }], details: report() };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "annotation-panel",
      pluginId: "@pi-harness/core/plugins/annotation",
      title: "Annotations",
      description: "收集回复片段并生成带编号的提问上下文。",
      icon: "⌁",
      read: () => ({ ...report(), lastPrompt }),
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
