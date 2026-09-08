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
      { role: "user", text: "修复问题", thinking: "", tools: [], stopped: false },
      { role: "assistant", text: "已修复", thinking: "先检查再确认", tools: [], stopped: false },
    ]);
  });

  test("marks the turn the user interrupted, including when the runtime closed it with an empty message", () => {
    expect(
      projectChatTurns([
        { role: "user", content: [{ type: "text", text: "跑测试" }] },
        { role: "assistant", content: [{ type: "text", text: "正在读取" }], stopReason: "aborted" },
      ]).at(-1),
    ).toEqual({ role: "assistant", text: "正在读取", thinking: "", tools: [], stopped: true });

    expect(
      projectChatTurns([
        { role: "assistant", content: [{ type: "text", text: "正在读取" }], stopReason: "stop" },
        { role: "assistant", content: [], stopReason: "aborted" },
      ]),
    ).toEqual([{ role: "assistant", text: "正在读取", thinking: "", tools: [], stopped: true }]);
  });

  test("keeps the mark when the interrupted message is merged with a later one", () => {
    expect(
      projectChatTurns([
        { role: "assistant", content: [{ type: "text", text: "正在读取" }], stopReason: "aborted" },
        { role: "assistant", content: [{ type: "text", text: "（已停止）" }], stopReason: "stop" },
      ]),
    ).toEqual([{ role: "assistant", text: "正在读取（已停止）", thinking: "", tools: [], stopped: true }]);
  });

  test("gives an interrupt that landed before any output a turn of its own", () => {
    expect(
      projectChatTurns([
        { role: "user", content: [{ type: "text", text: "跑测试" }] },
        { role: "assistant", content: [], stopReason: "aborted" },
      ]),
    ).toEqual([
      { role: "user", text: "跑测试", thinking: "", tools: [], stopped: false },
      { role: "assistant", text: "", thinking: "", tools: [], stopped: true },
    ]);
  });

  test("keeps the tool calls a turn made, joined to the results that came back", () => {
    const turns = projectChatTurns([
      { role: "user", content: [{ type: "text", text: "读 package.json" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先读文件" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } },
        ],
      },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: '{ "name": "pi-harness" }' }] },
      { role: "assistant", content: [{ type: "text", text: "名字是 pi-harness。" }] },
    ]);

    // Without the call in the turn the transcript jumped from the prompt to an answer the model had no way to know.
    expect(turns).toEqual([
      { role: "user", text: "读 package.json", thinking: "", tools: [], stopped: false },
      {
        role: "assistant",
        text: "名字是 pi-harness。",
        thinking: "先读文件",
        tools: [{ id: "call-1", name: "read", arguments: { path: "package.json" }, result: '{ "name": "pi-harness" }', failed: false }],
        stopped: false,
      },
    ]);
  });

  test("marks a failed call and keeps a call whose result has not arrived", () => {
    const turns = projectChatTurns([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "false" } },
          { type: "toolCall", id: "call-2", name: "read", arguments: { path: "a.txt" } },
        ],
      },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: true, content: [{ type: "text", text: "exit 1" }] },
    ]);

    expect(turns.at(-1)?.tools).toEqual([
      { id: "call-1", name: "bash", arguments: { command: "false" }, result: "exit 1", failed: true },
      // A call still running has no result at all, which is what tells the transcript to say 执行中 rather than 完成.
      { id: "call-2", name: "read", arguments: { path: "a.txt" }, failed: false },
    ]);
  });

  test("leaves a turn that finished on its own unmarked", () => {
    expect(projectChatTurns([{ role: "assistant", content: [{ type: "text", text: "已完成" }], stopReason: "stop" }])).toEqual([
      { role: "assistant", text: "已完成", thinking: "", tools: [], stopped: false },
    ]);
  });
});
