import { describe, expect, test } from "vitest";
import { themeStudioView } from "../src/theme-studio-view.js";
import { themePresets } from "../../plugins/theme-studio/src/index.js";
function report(theme: keyof typeof themePresets = "midnight") {
  return { ...themePresets[theme], tokens: { ...themePresets[theme].tokens }, theme, sessionId: "session-1", changed: false, changedAt: null };
}
describe("theme studio boundary", () => {
  test("accepts all four complete presets with detached token maps", () => {
    for (const theme of Object.keys(themePresets) as Array<keyof typeof themePresets>) {
      const data = report(theme);
      const view = themeStudioView(data)!;
      expect(view.theme).toBe(theme);
      view.tokens["--color-ink"] = "red";
      expect(data.tokens["--color-ink"]).not.toBe("red");
    }
  });
  test("rejects a snapshot from a different active session", () => {
    expect(themeStudioView(report(), "session-2")).toBeUndefined();
    expect(themeStudioView(report(), "session-1")).toMatchObject({ theme: "midnight", sessionId: "session-1" });
  });
  test("rejects arbitrary variables, CSS payloads, malformed state and accessors", () => {
    const valid = report();
    let reads = 0;
    const getter = Object.defineProperty({}, "tokens", {
      get() {
        reads++;
        throw Error("getter");
      },
    });
    const proxy = Proxy.revocable({}, {});
    proxy.revoke();
    for (const data of [
      getter,
      proxy.proxy,
      { ...valid, theme: "unknown" },
      { ...valid, changed: true },
      { ...valid, tokens: { ...valid.tokens, "--arbitrary": "red" } },
      { ...valid, tokens: { ...valid.tokens, "--color-ink": "url(https://invalid.example)" } },
      { ...valid, tokens: { ...valid.tokens, "--color-line": "rgba(999,0,0,1)" } },
    ])
      expect(themeStudioView(data)).toBeUndefined();
    expect(reads).toBe(0);
  });
});
