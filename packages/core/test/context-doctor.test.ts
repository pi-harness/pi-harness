import { describe, expect, test } from "vitest";
import { inspectMessages } from "../src/plugins/context-doctor.js";

describe("context doctor", () => {
  test("reports pressure, oversized messages, and tool errors", () => {
    const report = inspectMessages(
      [
        { role: "user", content: "ok" },
        { role: "user", content: "x".repeat(200) },
        { role: "toolResult", isError: true },
      ],
      { percent: 82, tokens: 820, contextWindow: 1000 },
      75,
      100,
    );
    expect(report).toMatchObject({
      status: "warning",
      usagePercent: 82,
      tokens: 820,
      contextWindow: 1000,
      messageCount: 3,
      oversizedMessages: 1,
      toolErrors: 1,
    });
    expect(report.recommendations).toHaveLength(3);
  });

  test("stays healthy when usage and messages are within limits", () => {
    const report = inspectMessages([{ role: "user", content: "short" }], { percent: 20, tokens: 20, contextWindow: 1000 }, 75, 1024);
    expect(report).toMatchObject({ status: "ok", usagePercent: 20, messageCount: 1, oversizedMessages: 0, toolErrors: 0, recommendations: [] });
  });
});
