import { describe, expect, it } from "vitest";
import { recallUnreadPanelView } from "../src/recall-unread-view.js";

describe("Recall Unread view", () => {
  it("normalizes session inventory, status, and items", () => {
    expect(
      recallUnreadPanelView({
        scans: 2,
        total: 1,
        items: [
          {
            id: "session-1",
            path: "/sessions/session-1.jsonl",
            cwd: "/workspace",
            name: "Needs reply",
            modified: "2026-09-05T12:00:00.000Z",
            messageCount: 3,
            message: "Please finish the task",
          },
        ],
        status: { state: "completed", at: "2026-09-05T12:01:00.000Z" },
        inventory: {
          available: 2,
          candidates: 2,
          scanned: 2,
          unread: 1,
          shown: 1,
          truncated: false,
          discoveryTruncated: false,
          scanTruncated: false,
          displayTruncated: false,
        },
        limits: { sessions: 100 },
      }),
    ).toMatchObject({
      scans: 2,
      total: 1,
      items: [
        {
          id: "session-1",
          path: "/sessions/session-1.jsonl",
          cwd: "/workspace",
          name: "Needs reply",
          modified: "2026-09-05T12:00:00.000Z",
          messageCount: 3,
          message: "Please finish the task",
        },
      ],
      status: { state: "completed", at: "2026-09-05T12:01:00.000Z", error: null },
      inventory: { available: 2, candidates: 2, scanned: 2, unread: 1, shown: 1, truncated: false },
      limits: { sessions: 100, allowedSessions: 500, panelItems: 50, previewCharacters: 500 },
    });
  });

  it("enforces fixed browser caps on hostile nested data", () => {
    const long = `unsafe\0${"x".repeat(20_000)}`;
    const item = {
      id: long,
      path: long,
      cwd: long,
      name: long,
      modified: long,
      messageCount: Number.MAX_SAFE_INTEGER,
      message: long,
    };
    const view = recallUnreadPanelView({
      scans: Number.MAX_SAFE_INTEGER + 1,
      total: 999_999,
      items: Array.from({ length: 100 }, () => item),
      status: { state: "failed", at: "2026-09-05T12:02:00.000Z", error: long },
      inventory: {
        available: 999_999,
        candidates: 999_999,
        scanned: 999_999,
        unread: 999_999,
        shown: 999_999,
        truncated: true,
        discoveryTruncated: true,
        scanTruncated: true,
        displayTruncated: true,
      },
      limits: Object.fromEntries(
        [
          "directoryEntries",
          "sessionBytes",
          "sessions",
          "allowedSessions",
          "readConcurrency",
          "contentParts",
          "previewCharacters",
          "panelItems",
          "toolItems",
          "queryCharacters",
          "sessionIdCharacters",
          "sessionNameCharacters",
          "sessionPathCharacters",
          "statusErrorCharacters",
        ].map((key) => [key, 99_999_999]),
      ),
    });

    expect(view.scans).toBe(0);
    expect(view.total).toBe(0);
    expect(view.items).toHaveLength(50);
    expect(view.items[0]?.id).toHaveLength(256);
    expect(view.items[0]?.name).toHaveLength(256);
    expect(view.items[0]?.path).toHaveLength(4_096);
    expect(view.items[0]?.cwd).toHaveLength(4_096);
    expect(view.items[0]?.message).toHaveLength(500);
    expect(view.items[0]?.modified).toBeNull();
    expect(view.items[0]?.messageCount).toBe(0);
    expect(view.status.error).toHaveLength(2_000);
    expect(view.inventory).toMatchObject({
      available: 0,
      candidates: 0,
      scanned: 0,
      unread: 0,
      shown: 0,
      truncated: true,
      discoveryTruncated: true,
      scanTruncated: true,
      displayTruncated: true,
    });
    expect(view.limits).toMatchObject({
      directoryEntries: 4_096,
      sessionBytes: 4_194_304,
      sessions: 100,
      allowedSessions: 500,
      readConcurrency: 8,
      contentParts: 1_000,
      previewCharacters: 500,
      panelItems: 50,
      toolItems: 100,
      queryCharacters: 120,
      sessionIdCharacters: 256,
      sessionNameCharacters: 256,
      sessionPathCharacters: 4_096,
      statusErrorCharacters: 2_000,
    });
  });

  it("preserves a safe configured scan limit above the default", () => {
    const view = recallUnreadPanelView({
      total: 250,
      inventory: { available: 300, candidates: 300, scanned: 250, unread: 250, shown: 50 },
      limits: { sessions: 250, allowedSessions: 500 },
    });

    expect(view.total).toBe(250);
    expect(view.inventory).toMatchObject({ available: 300, candidates: 300, scanned: 250, unread: 250, shown: 50 });
    expect(view.limits.sessions).toBe(250);
  });
});
