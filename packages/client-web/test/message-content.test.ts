import { describe, expect, test } from "vitest";
import { messageThinking, messageText, projectChatTurns } from "../src/message-content.js";

describe("message content projection", () => {
  test("keeps assistant text separate from thinking and tool calls", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先检查项目结构" },
        { type: "toolCall", name: "read" },
        { type: "text", text: "项目使用 Cordis。" },
      ],
    };

    expect(messageThinking(message)).toBe("先检查项目结构");
    expect(messageText(message)).toBe("项目使用 Cordis。");
  });

  test("does not leak tool result text into the assistant transcript", () => {
    expect(messageText({ role: "toolResult", content: [{ type: "text", text: "secret command output" }] })).toBe("secret command output");
    expect(messageText({ role: "assistant", content: [{ type: "toolResult", text: "not assistant prose" }] })).toBe("");
  });

  test("merges contiguous assistant messages into one thinking block", () => {
    expect(
      projectChatTurns([
        { role: "user", content: [{ type: "text", text: "修复问题" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "先检查" }] },
        { role: "toolResult", content: [{ type: "text", text: "命令输出" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "再确认" },
            { type: "text", text: "已修复" },
          ],
        },
      ]),
    ).toEqual([
      { role: "user", text: "修复问题", thinking: "" },
      { role: "assistant", text: "已修复", thinking: "先检查再确认" },
    ]);
  });
});
