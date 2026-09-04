import { describe, expect, it } from "vitest";
import { browserSessionTabs } from "../src/browser-session-view.js";

describe("browser session view", () => {
  it("keeps valid tabs bounded and preserves browser order", () => {
    expect(
      browserSessionTabs(
        [
          { targetId: "one", title: "Pi Harness", url: "http://127.0.0.1:3081" },
          { targetId: "", title: "invalid", url: "http://invalid" },
          { targetId: "two", title: "Docs", url: "https://example.com" },
        ],
        1,
      ),
    ).toEqual([{ targetId: "one", title: "Pi Harness", url: "http://127.0.0.1:3081" }]);
  });
});
