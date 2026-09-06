import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "../config.js";

const maxNodes = 100;
const maxEdges = 200;
const maxLabelLength = 256;
const nodeIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
type Direction = "TD" | "LR" | "BT" | "RL";
type CanvasNode = { id: string; label: string };
type CanvasEdge = { from: string; to: string; label?: string };
type CanvasReport = { direction: Direction; nodes: CanvasNode[]; edges: CanvasEdge[]; nodeCount: number; edgeCount: number; mermaid: string };

function label(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (result.length === 0 || result.length > maxLabelLength) throw new Error(`${field} must contain 1-${maxLabelLength} characters`);
  return result;
}

function nodeId(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (!nodeIdPattern.test(result)) throw new Error(`Invalid ${field.toLowerCase()}: ${result}`);
  return result;
}

function direction(value: unknown): Direction {
  if (value === undefined) return "TD";
  if (value === "TD" || value === "LR" || value === "BT" || value === "RL") return value;
  throw new Error("Canvas direction must be TD, LR, BT, or RL");
}

function render(direction: Direction, nodes: CanvasNode[], edges: CanvasEdge[]): string {
  const escape = (value: string): string =>
    value.replace(/[&<>"\r\n]/g, (character) => {
      if (character === "&") return "&amp;";
      if (character === "<") return "&lt;";
      if (character === ">") return "&gt;";
      return character === '"' ? "&quot;" : " ";
    });
  const escapeEdge = (value: string): string => escape(value).replace(/\|/g, "&#124;");
  const lines = [`flowchart ${direction}`];
  for (const node of nodes) lines.push(`    ${node.id}["${escape(node.label)}"]`);
  for (const edge of edges) lines.push(`    ${edge.from} -->${edge.label === undefined ? "" : `|${escapeEdge(edge.label)}|`} ${edge.to}`);
  return lines.join("\n");
}

export default {
  name: "pi-canvas-draw",
  inject: ["piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let latest: CanvasReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "canvas_draw",
        label: "Draw canvas",
        description: "Generate a validated Mermaid flowchart from structured nodes and edges without executing or writing files.",
        promptSnippet: "draw a flowchart from these nodes and relationships",
        parameters: Type.Object(
          {
            direction: Type.Optional(Type.Union([Type.Literal("TD"), Type.Literal("LR"), Type.Literal("BT"), Type.Literal("RL")])),
            nodes: Type.Array(
              Type.Object({
                id: Type.String({ minLength: 1, maxLength: 64, pattern: nodeIdPattern.source }),
                label: Type.String({ minLength: 1, maxLength: maxLabelLength }),
              }),
              { minItems: 1, maxItems: maxNodes },
            ),
            edges: Type.Array(
              Type.Object({
                from: Type.String({ minLength: 1, maxLength: 64, pattern: nodeIdPattern.source }),
                to: Type.String({ minLength: 1, maxLength: 64, pattern: nodeIdPattern.source }),
                label: Type.Optional(Type.String({ minLength: 1, maxLength: maxLabelLength })),
              }),
              { maxItems: maxEdges },
            ),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        execute(_toolCallId, params): Promise<AgentToolResult<CanvasReport>> {
          return Promise.resolve().then(() => {
            const input = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
            const rawNodes = input.nodes;
            const rawEdges = input.edges;
            if (!Array.isArray(rawNodes)) throw new Error("Canvas nodes must be an array");
            if (!Array.isArray(rawEdges)) throw new Error("Canvas edges must be an array");
            if (rawNodes.length === 0 || rawNodes.length > maxNodes) throw new Error(`Canvas must contain 1-${maxNodes} nodes`);
            if (rawEdges.length > maxEdges) throw new Error(`Canvas must contain at most ${maxEdges} edges`);
            const flowDirection = direction(input.direction);
            const nodes = rawNodes.map((rawNode, index) => {
              if (typeof rawNode !== "object" || rawNode === null) throw new Error(`Canvas node ${index + 1} must be an object`);
              const node = rawNode as Record<string, unknown>;
              return { id: nodeId(node.id, "Node id"), label: label(node.label, "Node label") };
            });
            const edges = rawEdges.map((rawEdge, index) => {
              if (typeof rawEdge !== "object" || rawEdge === null) throw new Error(`Canvas edge ${index + 1} must be an object`);
              const edge = rawEdge as Record<string, unknown>;
              return {
                from: nodeId(edge.from, "Edge source id"),
                to: nodeId(edge.to, "Edge target id"),
                ...(edge.label === undefined ? {} : { label: label(edge.label, "Edge label") }),
              };
            });
            const ids = new Set<string>();
            for (const node of nodes) {
              if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
              ids.add(node.id);
            }
            for (const edge of edges) {
              if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error(`Canvas edge references an unknown node: ${edge.from} -> ${edge.to}`);
            }
            const report: CanvasReport = {
              direction: flowDirection,
              nodes,
              edges,
              nodeCount: nodes.length,
              edgeCount: edges.length,
              mermaid: render(flowDirection, nodes, edges),
            };
            latest = report;
            return { content: [{ type: "text" as const, text: report.mermaid }], details: structuredClone(report) };
          });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "canvas-draw-panel",
      pluginId: "@pi-harness/core/plugins/canvas-draw",
      title: "Canvas Draw",
      description: "将结构化节点和边转换为可复制的 Mermaid 流程图源码。",
      icon: "⌘",
      read: () => ({ latest: latest === undefined ? null : structuredClone(latest), nodeCount: latest?.nodeCount ?? 0, edgeCount: latest?.edgeCount ?? 0 }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
