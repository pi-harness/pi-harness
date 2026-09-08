import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import canvasDrawPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

async function createCanvas(): Promise<{ context: Context; panels: PiPluginUiRegistry; tools: PiToolRegistry }> {
  const context = new Context();
  const panels = new PiPluginUiRegistry();
  const tools = new PiToolRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(canvasDrawPlugin);
  return { context, panels, tools };
}

function canvasTool(tools: PiToolRegistry) {
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "canvas_draw");
  if (tool === undefined) throw new Error("canvas_draw was not registered");
  return tool;
}

describe("canvas-draw", () => {
  test("declares all node, edge, id, and label bounds in the tool schema", async () => {
    const { context, tools } = await createCanvas();
    try {
      const parameters = canvasTool(tools).parameters;

      expect(parameters).toMatchObject({
        properties: {
          nodes: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
                label: { type: "string", minLength: 1, maxLength: 256 },
              },
            },
          },
          edges: {
            type: "array",
            maxItems: 200,
            items: {
              properties: {
                from: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
                to: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
                label: { type: "string", minLength: 1, maxLength: 256 },
              },
            },
          },
        },
      });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects malformed and oversized inputs before mapping their entries", async () => {
    const { context, tools } = await createCanvas();
    const draw = canvasTool(tools);
    try {
      await expect(draw.execute("null", null, undefined, undefined, {} as never)).rejects.toThrow(/nodes must be an array/iu);
      await expect(draw.execute("edges", { nodes: [{ id: "a", label: "A" }], edges: null }, undefined, undefined, {} as never)).rejects.toThrow(
        /edges must be an array/iu,
      );
      await expect(
        draw.execute("nodes-limit", { nodes: Array.from({ length: 101 }, () => null), edges: [] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/1-100 nodes/iu);
      await expect(
        draw.execute("edges-limit", { nodes: [{ id: "a", label: "A" }], edges: Array.from({ length: 201 }, () => null) }, undefined, undefined, {} as never),
      ).rejects.toThrow(/at most 200 edges/iu);
      await expect(
        draw.execute("direction", { direction: "DOWN", nodes: [{ id: "a", label: "A" }], edges: [] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/direction must be TD, LR, BT, or RL/iu);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("escapes HTML and Mermaid delimiters in node and edge labels", async () => {
    const { context, tools } = await createCanvas();
    try {
      const result = await canvasTool(tools).execute(
        "escape",
        {
          nodes: [
            { id: "start", label: '<script>alert("x")</script> & next\nline' },
            { id: "finish", label: "Finish" },
          ],
          edges: [{ from: "start", to: "finish", label: "ready| --> injected <b>" }],
        },
        undefined,
        undefined,
        {} as never,
      );
      const mermaid = (result.details as { mermaid: string }).mermaid;

      expect(mermaid).not.toContain("<script>");
      expect(mermaid).not.toContain("<b>");
      expect(mermaid).not.toContain("ready| --> injected");
      expect(mermaid).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; next line");
      expect(mermaid).toContain("ready#124; --&gt; injected &lt;b&gt;");
    } finally {
      await context.fiber.dispose();
    }
  });

  test("isolates Mermaid identifiers and quotes edge labels containing flowchart syntax", async () => {
    const { context, tools } = await createCanvas();
    const nodes = [
      { id: "end", label: "End" },
      { id: "canvas_node_0", label: "Other" },
    ];
    const edges = [{ from: "end", to: "canvas_node_0", label: 'ready [a] (b) {c} | "quoted" #quot;' }];
    try {
      const result = await canvasTool(tools).execute("syntax", { nodes, edges }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ nodes, edges });
      expect((result.details as { mermaid: string }).mermaid).toBe(
        'flowchart TD\n    canvas_node_0["End"]\n    canvas_node_1["Other"]\n    canvas_node_0 -->|"ready [a] (b) {c} #124; &quot;quoted&quot; #35;quot;"| canvas_node_1',
      );
    } finally {
      await context.fiber.dispose();
    }
  });

  test("does not expose mutable canvas state through tool results", async () => {
    const { context, panels, tools } = await createCanvas();
    try {
      const result = await canvasTool(tools).execute(
        "draw",
        {
          nodes: [
            { id: "start", label: "Start" },
            { id: "finish", label: "Finish" },
          ],
          edges: [{ from: "start", to: "finish" }],
        },
        undefined,
        undefined,
        {} as never,
      );

      (result.details as { nodes: Array<{ label: string }> }).nodes[0]!.label = "mutated";

      const panel = (await panels.snapshot())[0];
      if (panel === undefined) throw new Error("canvas-draw-panel was not registered");
      const panelLatest = (panel.data as { latest: { nodes: Array<{ label: string }> } }).latest;
      expect(panelLatest.nodes[0]?.label).toBe("Start");
      panelLatest.nodes[0]!.label = "panel-mutated";

      const nextPanel = (await panels.snapshot())[0];
      if (nextPanel === undefined) throw new Error("canvas-draw-panel was not registered");
      expect((nextPanel.data as { latest: { nodes: Array<{ label: string }> } }).latest.nodes[0]?.label).toBe("Start");
    } finally {
      await context.fiber.dispose();
    }
  });

  test("accepts exact collection limits, preserves successful state on failure, and unregisters on disposal", async () => {
    const { context, panels, tools } = await createCanvas();
    const draw = canvasTool(tools);
    const nodes = Array.from({ length: 100 }, (_, index) => ({ id: `node_${index}`, label: `Node ${index}` }));
    const edges = Array.from({ length: 200 }, (_, index) => ({ from: `node_${index % 100}`, to: `node_${(index + 1) % 100}`, label: `Edge ${index}` }));
    try {
      await expect(draw.execute("limits", { direction: "RL", nodes, edges }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { direction: "RL", nodeCount: 100, edgeCount: 200 },
      });
      await expect(
        draw.execute("failure", { nodes: [{ id: "start", label: "Start" }], edges: [{ from: "start", to: "missing" }] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/unknown node/iu);
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "canvas-draw-panel", data: { nodeCount: 100, edgeCount: 200 } }]);

      await context.fiber.dispose();

      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toEqual([]);
    } finally {
      await context.fiber.dispose();
    }
  });
});
