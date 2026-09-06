import { describe, expect, test } from "vitest";
import { readmeGenPanelView } from "../src/readme-gen-view.js";

function validPanel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generated: true,
    name: "@scope/demo",
    scripts: 4,
    plugins: 12,
    lastWrite: { path: "docs/README.generated.md", bytes: 4_096, overwritten: false },
    status: { state: "completed", operation: "write", at: "2026-09-06T00:00:00.000Z" },
    ...overrides,
  };
}

describe("README generator panel view", () => {
  test("normalizes a complete generated and written report", () => {
    expect(readmeGenPanelView(validPanel())).toEqual({
      generated: { name: "@scope/demo", scripts: 4, plugins: 12 },
      lastWrite: { path: "docs/README.generated.md", bytes: 4_096, overwritten: false },
      status: { state: "completed", operation: "write", at: "2026-09-06T00:00:00.000Z", error: null },
      malformed: false,
      limits: { nameCharacters: 256, pathCharacters: 512, scripts: 256, plugins: 256, errorCharacters: 2_000 },
    });
  });

  test("normalizes the untouched idle state without manufacturing counts", () => {
    expect(readmeGenPanelView({ generated: false, lastWrite: null, status: { state: "idle" } })).toEqual({
      generated: null,
      lastWrite: null,
      status: { state: "idle", operation: null, at: null, error: null },
      malformed: false,
      limits: { nameCharacters: 256, pathCharacters: 512, scripts: 256, plugins: 256, errorCharacters: 2_000 },
    });
  });

  test("fails closed for contradictory, unbounded, or malformed values", () => {
    const malformed = [
      null,
      [],
      validPanel({ name: "" }),
      validPanel({ name: "x".repeat(257) }),
      validPanel({ scripts: -1 }),
      validPanel({ plugins: 257 }),
      validPanel({ lastWrite: { path: "package.json", bytes: 0, overwritten: false } }),
      validPanel({ lastWrite: { path: "README.md", bytes: Number.NaN, overwritten: false } }),
      validPanel({ status: { state: "completed", operation: "write", at: "invalid" } }),
      validPanel({ status: { state: "failed", operation: "report", at: "2026-09-06T00:00:00.000Z" } }),
      { generated: false, lastWrite: { path: "README.md", bytes: 1, overwritten: false }, status: { state: "idle" } },
    ];

    for (const value of malformed) {
      const view = readmeGenPanelView(value);
      expect(view.generated).toBeNull();
      expect(view.lastWrite).toBeNull();
      expect(view.status.state).toBe("unknown");
      expect(view.malformed).toBe(true);
    }
  });

  test("does not invoke accessors or revoked proxies and returns detached data", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "generated", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    const nestedAccessor = Object.defineProperty({}, "path", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "README.md";
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    for (const value of [accessor, validPanel({ lastWrite: nestedAccessor }), revocable.proxy]) {
      expect(() => readmeGenPanelView(value)).not.toThrow();
      expect(readmeGenPanelView(value).malformed).toBe(true);
    }
    expect(getterCalls).toBe(0);

    const source = validPanel();
    const view = readmeGenPanelView(source);
    (source.lastWrite as { path: string }).path = "README.changed.md";
    expect(view.lastWrite?.path).toBe("docs/README.generated.md");
  });
});
