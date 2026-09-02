import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const maxNodes = 100;
const maxEdges = 200;
const maxLabelLength = 256;
const nodeIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
type Direction = "TD" | "LR" | "BT" | "RL";
type CanvasNode = { id: string; label: string };
type CanvasEdge = { from: string; to: string; label?: string };
type CanvasReport = { direction: Direction; nodes: CanvasNode[]; edges: CanvasEdge[]; nodeCount: number; edgeCount: number; mermaid: string };

function label(value: string, field: string): string {
  const result = value.trim();
  if (result.length === 0 || result.length > maxLabelLength) throw new Error(`${field} must contain 1-${maxLabelLength} characters`);
  return result;
}

function render(direction: Direction, nodes: CanvasNode[], edges: CanvasEdge[]): string {
  const escape = (value: string): string => value.replace(/["\r\n]/g, (character) => (character === '"' ? "&quot;" : " "));
  const lines = [`flowchart ${direction}`];
  for (const node of nodes) lines.push(`    ${node.id}["${escape(node.label)}"]`);
  for (const edge of edges) lines.push(`    ${edge.from} -->${edge.label === undefined ? "" : `|${escape(edge.label)}|`} ${edge.to}`);
  return lines.join("\n");
}

export default {
  name: "pi-canvas-draw",
  inject: ["piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: CanvasReport | undefined;
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "canvas_draw",
        label: "Draw canvas",
        description: "Generate a validated Mermaid flowchart from structured nodes and edges without executing or writing files.",
        promptSnippet: "draw a flowchart from these nodes and relationships",
        parameters: Type.Object({
          direction: Type.Optional(Type.Union([Type.Literal("TD"), Type.Literal("LR"), Type.Literal("BT"), Type.Literal("RL")])),
          nodes: Type.Array(Type.Object({ id: Type.String(), label: Type.String() })),
          edges: Type.Array(Type.Object({ from: Type.String(), to: Type.String(), label: Type.Optional(Type.String()) })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<CanvasReport>> {
          const nodes = params.nodes.map((node) => ({ id: node.id.trim(), label: label(node.label, "Node label") }));
          const edges = params.edges.map((edge) => ({
            from: edge.from.trim(),
            to: edge.to.trim(),
            ...(edge.label === undefined ? {} : { label: label(edge.label, "Edge label") }),
          }));
          if (nodes.length === 0 || nodes.length > maxNodes) throw new Error(`Canvas must contain 1-${maxNodes} nodes`);
          if (edges.length > maxEdges) throw new Error(`Canvas must contain at most ${maxEdges} edges`);
          const ids = new Set<string>();
          for (const node of nodes) {
            if (!nodeIdPattern.test(node.id)) throw new Error(`Invalid node id: ${node.id}`);
            if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
            ids.add(node.id);
          }
          for (const edge of edges) {
            if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error(`Canvas edge references an unknown node: ${edge.from} -> ${edge.to}`);
          }
          const report: CanvasReport = {
            direction: params.direction ?? "TD",
            nodes,
            edges,
            nodeCount: nodes.length,
            edgeCount: edges.length,
            mermaid: render(params.direction ?? "TD", nodes, edges),
          };
          latest = report;
          return { content: [{ type: "text", text: report.mermaid }], details: report };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "canvas-draw-panel",
      pluginId: "@pi-harness/core/plugins/canvas-draw",
      title: "Canvas Draw",
      description: "将结构化节点和边转换为可复制的 Mermaid 流程图源码。",
      icon: "⌘",
      read: () => ({ latest: latest ?? null, nodeCount: latest?.nodeCount ?? 0, edgeCount: latest?.edgeCount ?? 0 }),
    });
    context.effect(() => () => {
      unregisterTool();
      disposePanel();
    });
  },
};
