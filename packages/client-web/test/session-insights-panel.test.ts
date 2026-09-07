import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

function renderPanel(data: unknown): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "session-insights-panel",
        pluginId: "@pi-harness/plugin-session-insights",
        title: "Session Insights",
        data,
      },
    }),
  );
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionFile: null,
    sessionId: "session-1",
    userMessages: 2,
    assistantMessages: 2,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 5,
    tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, total: 35 },
    cost: 0.012_345,
    contextUsage: { tokens: 250, contextWindow: 1_000, percent: 25 },
    compaction: { status: "completed", requestedAt: "2026-09-06T00:00:00.000Z", startedAt: "2026-09-06T00:00:01.000Z", finishedAt: "2026-09-06T00:00:02.000Z" },
    ...overrides,
  };
}

describe("session-insights panel", () => {
  test("renders validated message, token, cost, context, and compaction details", () => {
    const html = renderPanel(report());

    for (const expected of ["session-1", "5", "1", "$0.0123", "35", "输入 10", "输出 20", "缓存读取 3", "缓存写入 2", "25.0%", "250 / 1,000", "压缩已完成"]) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain("会话统计数据无效");
    expect(html).not.toContain("压缩状态数据无效");
  });

  test("explains temporarily unknown context usage after compaction", () => {
    const html = renderPanel(
      report({
        contextUsage: { tokens: null, contextWindow: 1_000, percent: null },
        compaction: { status: "idle" },
      }),
    );

    expect(html).toContain("待下一次模型响应");
    expect(html).toContain("上下文窗口 1,000");
    expect(html).toContain("尚未请求压缩");
  });

  test("renders malformed reports as unavailable instead of zero-valued health", () => {
    const html = renderPanel(report({ cost: Number.NaN }));

    expect(html).toContain("会话统计数据无效");
    expect(html).not.toContain("$0.0000");
    expect(html).not.toContain("tracked tokens");
  });

  test("keeps valid metrics visible while flagging malformed compaction state", () => {
    const html = renderPanel(report({ compaction: { status: "completed" } }));

    expect(html).toContain("35");
    expect(html).toContain("$0.0123");
    expect(html).toContain("压缩状态数据无效");
    expect(html).not.toContain("压缩已完成");
  });

  test("wraps the maximum session id without horizontal truncation", () => {
    const sessionId = "s".repeat(512);
    const html = renderPanel(report({ sessionId }));

    expect(html).toContain(sessionId);
    expect(html).toMatch(/class="[^"]*break-all[^"]*"[^>]*>s{512}</u);
    expect(html).not.toMatch(/class="[^"]*truncate[^"]*"[^>]*>s{512}</u);
  });
});
