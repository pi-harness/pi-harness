import { describe, expect, test } from "vitest";
import { dependencyCheckerPanelView } from "../src/dependency-checker-view.js";

interface DependencyCheckerView {
  manifest: string;
  ecosystem: "npm" | "python";
  declared: number;
  installed: number;
  scanLimit: number;
  missingCount: number;
  optionalMissingCount: number;
  invalidCount: number;
  conflictCount: number;
  missing: string[];
  optionalMissing: string[];
  invalid: string[];
  conflicts: Array<{ name: string; constraints: string[] }>;
  truncated: boolean;
}

describe("dependency checker panel view", () => {
  function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      manifest: "package.json",
      ecosystem: "npm",
      declared: 0,
      installed: 0,
      scanLimit: 2_000,
      missing: [],
      optionalMissing: [],
      invalid: [],
      conflicts: [],
      unresolved: [],
      ...overrides,
    };
  }

  test("bounds report details while preserving issue totals and scan metadata", () => {
    const missing = Array.from({ length: 25 }, (_, index) => `missing-${index}`);
    const view: DependencyCheckerView = dependencyCheckerPanelView({
      report: {
        manifest: "apps/web/package.json",
        ecosystem: "npm",
        declared: 29,
        installed: 2,
        scanLimit: 2_000,
        missing,
        optionalMissing: ["optional"],
        invalid: ["../invalid"],
        conflicts: [{ name: "react", constraints: ["^18", ">=19"] }],
      },
    });

    expect(view).toEqual({
      manifest: "apps/web/package.json",
      ecosystem: "npm",
      declared: 29,
      installed: 2,
      scanLimit: 2_000,
      missingCount: 25,
      optionalMissingCount: 1,
      invalidCount: 1,
      conflictCount: 1,
      unresolvedCount: 0,
      missing: missing.slice(0, 20),
      optionalMissing: ["optional"],
      invalid: ["../invalid"],
      conflicts: [{ name: "react", constraints: ["^18", ">=19"] }],
      unresolved: [],
      truncated: true,
    });
  });

  test("marks conflict constraint details as truncated", () => {
    const constraints = Array.from({ length: 9 }, (_, index) => `>=${index}.0.0`);
    const view = dependencyCheckerPanelView({ report: { conflicts: [{ name: "package", constraints }] } });

    expect(view.conflicts).toEqual([{ name: "package", constraints: constraints.slice(0, 8) }]);
    expect(view.truncated).toBe(true);
  });

  test("marks oversized panel strings as truncated", () => {
    const constraint = ">=" + "1".repeat(300);
    const view = dependencyCheckerPanelView({ report: { conflicts: [{ name: "package", constraints: [constraint] }] } });

    expect(view.conflicts[0]?.constraints).toEqual([constraint.slice(0, 256)]);
    expect(view.truncated).toBe(true);
  });

  test("normalizes unresolved constraint groups independently from conflicts", () => {
    const view = dependencyCheckerPanelView({
      report: {
        manifest: "package.json",
        ecosystem: "npm",
        declared: 1,
        installed: 1,
        scanLimit: 2_000,
        missing: [],
        optionalMissing: [],
        invalid: [],
        conflicts: [],
        unresolved: [{ name: "shared", constraints: ["workspace:*", "^1.0.0"] }],
      },
    });

    expect(view as unknown).toMatchObject({
      conflictCount: 0,
      unresolvedCount: 1,
      unresolved: [{ name: "shared", constraints: ["workspace:*", "^1.0.0"] }],
      truncated: false,
    });
  });

  test("fails closed without invoking root or nested accessors and revoked proxies", () => {
    let getterCalls = 0;
    const rootAccessor = Object.defineProperty({}, "report", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      },
    });
    const listAccessor = Object.defineProperty([], "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "poison";
      },
    });
    Object.defineProperty(listAccessor, "length", { value: 1 });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    for (const input of [rootAccessor, revocable.proxy, { report: { missing: listAccessor } }]) {
      expect(() => dependencyCheckerPanelView(input)).not.toThrow();
      expect(dependencyCheckerPanelView(input)).toMatchObject({ declared: 0, installed: 0, missing: [], conflicts: [], truncated: true });
    }
    expect(getterCalls).toBe(0);
  });

  test("marks unknown root, report, and conflict fields as truncated", () => {
    expect(dependencyCheckerPanelView({ report: report(), unexpected: true }).truncated).toBe(true);
    expect(dependencyCheckerPanelView({ report: report({ unexpected: true }) }).truncated).toBe(true);
    expect(
      dependencyCheckerPanelView({
        report: report({
          declared: 1,
          installed: 1,
          conflicts: [{ name: "react", constraints: ["^18"], unexpected: true }],
        }),
      }).truncated,
    ).toBe(true);
  });

  test("removes control, bidi, and unpaired surrogate characters from visible text", () => {
    const view = dependencyCheckerPanelView({
      report: report({
        manifest: " apps/\u202Eweb/package.json\uD800 ",
        declared: 2,
        missing: ["left\u0000right"],
        unresolved: [{ name: "pkg\u202Ename", constraints: ["workspace:\uD800*"] }],
      }),
    });

    expect(view.manifest).toBe("apps/ web/package.json");
    expect(view.missing).toEqual(["left right"]);
    expect(view.unresolved).toEqual([{ name: "pkg name", constraints: ["workspace: *"] }]);
    expect(view.truncated).toBe(true);
  });

  test("does not create an unpaired surrogate when truncating visible text", () => {
    const name = `${"x".repeat(255)}😀tail`;
    const view = dependencyCheckerPanelView({
      report: report({ declared: 1, missing: [name] }),
    });

    expect(view.missing).toEqual([`${"x".repeat(255)}😀`]);
    expect(view.missing[0]).not.toMatch(/[\p{Cs}]/u);
    expect(view.truncated).toBe(true);
  });

  test("reads at most 2000 list entries without invoking later accessors", () => {
    let getterCalls = 0;
    const missing = Array.from({ length: 2_001 }, (_, index) => `missing-${index}`);
    Object.defineProperty(missing, "2000", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "poison";
      },
    });

    const view = dependencyCheckerPanelView({
      report: report({ declared: 2_000, missing }),
    });

    expect(getterCalls).toBe(0);
    expect(view.missingCount).toBe(2_000);
    expect(view.missing).toHaveLength(20);
    expect(view.truncated).toBe(true);
  });

  test("fails closed for contradictory declared, installed, and issue totals", () => {
    const installedBeyondDeclared = dependencyCheckerPanelView({
      report: report({ declared: 1, installed: 2 }),
    });
    const installedPlusIssuesBeyondDeclared = dependencyCheckerPanelView({
      report: report({ declared: 1, installed: 1, missing: ["missing"] }),
    });

    expect(installedBeyondDeclared).toMatchObject({ declared: 0, installed: 0, truncated: true });
    expect(installedPlusIssuesBeyondDeclared).toMatchObject({ declared: 1, installed: 0, missing: ["missing"], truncated: true });
  });

  test("accepts Python invalid lines outside the declared package total", () => {
    const view = dependencyCheckerPanelView({
      report: report({ ecosystem: "python", invalid: ["-r base.txt"] }),
    });

    expect(view).toMatchObject({
      ecosystem: "python",
      declared: 0,
      installed: 0,
      invalidCount: 1,
      invalid: ["-r base.txt"],
      truncated: false,
    });
  });

  test("fails closed when npm declaration classifications do not account for every package", () => {
    const view = dependencyCheckerPanelView({
      report: report({ declared: 1, installed: 0 }),
    });

    expect(view).toMatchObject({ declared: 0, installed: 0, truncated: true });
  });

  test("marks duplicate and cross-list dependency records as truncated", () => {
    const duplicate = dependencyCheckerPanelView({
      report: report({ declared: 2, optionalMissing: ["same", "same"] }),
    });
    const crossList = dependencyCheckerPanelView({
      report: report({ declared: 2, missing: ["same"], optionalMissing: ["same"] }),
    });

    expect(duplicate.truncated).toBe(true);
    expect(crossList.truncated).toBe(true);
  });

  test("returns an explicitly truncated empty view for missing or invalid reports", () => {
    for (const input of [undefined, null, {}, { report: null }, { report: [] }, { report: new Date() }]) {
      expect(dependencyCheckerPanelView(input)).toMatchObject({
        declared: 0,
        installed: 0,
        missing: [],
        optionalMissing: [],
        invalid: [],
        conflicts: [],
        unresolved: [],
        truncated: true,
      });
    }
  });
});
