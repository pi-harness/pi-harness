import { describe, expect, test } from "vitest";
import { unreadUserMessage } from "../src/plugins/recall-unread.js";

describe("recall unread", () => {
  test("returns the latest user message only when no later assistant message exists", () => {
    expect(
      unreadUserMessage([
        { type: "message", message: { role: "user", content: [{ type: "text", text: "先前的问题" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "已回答" }] } },
      ]),
    ).toBeUndefined();
    expect(unreadUserMessage([{ type: "message", message: { role: "user", content: [{ type: "text", text: "请帮我找出未完成的任务" }] } }])).toBe(
      "请帮我找出未完成的任务",
    );
  });

  test("joins text parts and ignores non-message entries", () => {
    expect(
      unreadUserMessage([
        { type: "session_info", name: "demo" },
        {
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "第一段" },
              { type: "image", mimeType: "image/png" },
              { type: "text", text: "第二段" },
            ],
          },
        },
      ]),
    ).toBe("第一段\n第二段");
  });
});
