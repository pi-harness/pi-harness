import { describe, expect, test } from "vitest";
import { costMeterPanelView } from "../src/cost-meter-view.js";

interface CostMeterPanelView {
  dayBasis: "UTC";
  entryLimit: number | null;
  lastError: string | null;
  entries: Array<{
    sessionId: string;
    utcDate: string;
    dailyCost: number;
    sessionCost: number;
    tokens: number;
    messages: number;
  }>;
}

describe("cost meter panel view", () => {
  test("labels bounded ledger entries as UTC daily increments and session snapshots", () => {
    const view: CostMeterPanelView = costMeterPanelView({
      dayBasis: "UTC",
      entryLimit: 2_000,
      lastError: "disk full",
      entries: [
        {
          sessionId: "session-a",
          cost: 1.25,
          sessionCost: 4.5,
          tokens: 100,
          messages: 5,
          recordedAt: "2026-01-02T03:04:05.000Z",
        },
        { sessionId: "invalid", cost: Number.NaN, sessionCost: 1, tokens: 1, messages: 1, recordedAt: "not-a-date" },
      ],
    });

    expect(view).toEqual({
      dayBasis: "UTC",
      entryLimit: 2_000,
      lastError: "disk full",
      entries: [
        {
          sessionId: "session-a",
          utcDate: "2026-01-02",
          dailyCost: 1.25,
          sessionCost: 4.5,
          tokens: 100,
          messages: 5,
        },
      ],
    });
  });
});
