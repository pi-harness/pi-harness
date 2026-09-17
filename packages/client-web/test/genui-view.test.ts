import { describe, expect, test } from "vitest";
import { genUiPanelView } from "../src/genui-view.js";

describe("GenUI panel view", () => {
  test("normalizes a valid structured card and its enforced limits", () => {
    const view = genUiPanelView({
      rendered: 3,
      latest: {
        title: "Deploy",
        renderedAt: "2026-09-05T01:02:03.000Z",
        blocks: [
          { type: "text", label: "Detail", value: "Plain text", tone: "neutral" },
          { type: "badge", label: "State", value: "Ready", tone: "success" },
          { type: "progress", label: "Coverage", value: 87.5, tone: "info" },
        ],
      },
      limits: { blocks: 12, title: 256, label: 256, value: 4_000, totalText: 16_384 },
    });

    expect(view).toEqual({
      rendered: 3,
      latest: {
        title: "Deploy",
        renderedAt: "2026-09-05T01:02:03.000Z",
        blocks: [
          { type: "text", label: "Detail", value: "Plain text", tone: "neutral" },
          { type: "badge", label: "State", value: "Ready", tone: "success" },
          { type: "progress", label: "Coverage", value: 87.5, tone: "info" },
        ],
        truncated: false,
      },
      limits: { blocks: 12, title: 256, label: 256, value: 4_000, totalText: 16_384 },
    });
  });

  test("drops malformed blocks and bounds hostile card details", () => {
    const blocks = [
      { type: "text", label: "l".repeat(500), value: "v".repeat(5_000), tone: "neutral" },
      { type: "progress", label: "bad", value: 200, tone: "danger" },
      ...Array.from({ length: 15 }, (_, index) => ({ type: "badge", label: `label-${index}`, value: `value-${index}`, tone: "rainbow" })),
    ];
    const view = genUiPanelView({
      rendered: Number.NaN,
      latest: { title: "t".repeat(500), renderedAt: "invalid", blocks },
      limits: {},
    });

    expect(view.rendered).toBe(0);
    expect(view.latest?.title).toBe("t".repeat(256));
    expect(view.latest?.renderedAt).toBeNull();
    expect(view.latest?.blocks).toEqual([{ type: "text", label: "l".repeat(256), value: "v".repeat(2_000), tone: "neutral" }]);
    expect(view.latest?.truncated).toBe(true);
    expect(view.limits).toEqual({ blocks: 12, title: 256, label: 256, value: 4_000, totalText: 16_384 });
  });
});

describe("GenUI panel view text limits", () => {
  test("cuts a value at the limit by code point, so an emoji at the boundary survives or goes whole", () => {
    // 1999 plain characters then one emoji: the visible limit is 2000 code points, so the emoji is the last
    // thing that fits. Cutting by UTF-16 unit would take only the high surrogate and leave a lone half.
    const value = "a".repeat(1_999) + "😀";
    const view = genUiPanelView({
      rendered: 1,
      latest: { title: "Boundary", renderedAt: null, blocks: [{ type: "text", label: "Detail", value, tone: "neutral" }] },
      limits: { blocks: 12, title: 256, label: 256, value: 4_000, totalText: 16_384 },
    });
    const rendered = String(view?.latest?.blocks[0]?.value ?? "");
    expect([...rendered]).toHaveLength(2_000);
    expect(rendered.endsWith("😀")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(rendered)).toBe(false);
  });

  test("a title and a label are cut the same way", () => {
    const view = genUiPanelView({
      rendered: 1,
      latest: {
        title: "😀".repeat(300),
        renderedAt: null,
        blocks: [{ type: "text", label: "😀".repeat(300), value: "ok", tone: "neutral" }],
      },
      limits: { blocks: 12, title: 256, label: 256, value: 4_000, totalText: 16_384 },
    });
    const title = String(view?.latest?.title ?? "");
    const label = String(view?.latest?.blocks[0]?.label ?? "");
    expect([...title]).toHaveLength(256);
    expect([...label]).toHaveLength(256);
    for (const text of [title, label]) expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
  });
});
