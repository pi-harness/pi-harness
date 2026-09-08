import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PluginPanelCard } from "../src/react-room.js";

const allowedScripts = ["test", "build", "format:check", "lint", "typecheck"];

function renderPanel(data: unknown): string {
  return renderToStaticMarkup(
    createElement(PluginPanelCard, {
      panel: {
        id: "test-harness-panel",
        pluginId: "@pi-harness/plugin-test-harness",
        title: "Test Harness",
        data,
      },
    }),
  );
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowedScripts,
    latest: {
      cwd: "/workspace/验证项目",
      script: "test",
      command: "npm run test",
      status: "passed",
      exitCode: 0,
      signal: null,
      durationMs: 321,
      output: "2 tests passed\n",
      outputBytes: 15,
      outputTruncated: false,
      outputSanitized: false,
    },
    limits: { timeoutMs: 120_000, outputBytes: 12 * 1024 },
    ...overrides,
  };
}

describe("test-harness panel", () => {
  test("renders validated status, limits, scripts, and process output", () => {
    const html = renderPanel(report());

    expect(html).toContain("验证通过");
    expect(html).toContain("npm run test");
    expect(html).toContain("exit 0");
    expect(html).toContain("321 ms");
    expect(html).toContain("2 tests passed");
    expect(html).toContain("120000 ms");
    for (const script of allowedScripts) expect(html).toContain(script);
    expect(html).not.toContain("面板数据不完整");
  });

  test("renders failed, timed-out, and cancelled outcomes distinctly", () => {
    const failed = renderPanel(
      report({
        latest: {
          cwd: "/workspace/验证项目",
          script: "build",
          command: "npm run build",
          status: "failed",
          exitCode: 7,
          signal: null,
          durationMs: 400,
          output: "build failed",
          outputBytes: 12,
          outputTruncated: false,
          outputSanitized: false,
        },
      }),
    );
    const timedOut = renderPanel(
      report({
        latest: {
          cwd: "/workspace/验证项目",
          script: "lint",
          command: "npm run lint",
          status: "timed-out",
          exitCode: null,
          signal: "SIGTERM",
          durationMs: 120_010,
          output: "",
          outputBytes: 0,
          outputTruncated: false,
          outputSanitized: false,
        },
      }),
    );
    const cancelled = renderPanel(
      report({
        latest: {
          cwd: "/workspace/验证项目",
          script: "typecheck",
          command: "npm run typecheck",
          status: "cancelled",
          exitCode: null,
          signal: "SIGTERM",
          durationMs: 25,
          output: "",
          outputBytes: 0,
          outputTruncated: false,
          outputSanitized: false,
        },
      }),
    );

    expect(failed).toContain("验证失败");
    expect(failed).toContain("exit 7");
    expect(timedOut).toContain("验证超时");
    expect(cancelled).toContain("验证已取消");
  });

  test("fails closed without invoking nested accessors or revoked proxies", () => {
    let getterCalls = 0;
    const latestAccessor = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "passed";
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const scriptAccessors = [...allowedScripts];
    Object.defineProperty(scriptAccessors, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "test";
      },
    });
    const revokedScripts = Proxy.revocable([...allowedScripts], {});
    revokedScripts.revoke();

    for (const data of [
      report({ latest: latestAccessor }),
      report({ latest: revocable.proxy }),
      report({ allowedScripts: scriptAccessors }),
      report({ allowedScripts: revokedScripts.proxy }),
    ]) {
      expect(() => renderPanel(data)).not.toThrow();
      expect(renderPanel(data)).toContain("面板数据不完整");
    }
    expect(getterCalls).toBe(0);
  });

  test("rejects contradictory fields and safely bounds malformed output", () => {
    const contradiction = renderPanel(
      report({
        latest: {
          cwd: "/workspace/验证项目",
          script: "test",
          command: "npm run test",
          status: "passed",
          exitCode: 9,
          signal: null,
          durationMs: 1,
          output: "impossible",
          outputBytes: 10,
          outputTruncated: false,
          outputSanitized: false,
        },
      }),
    );
    const malformed = renderPanel(
      report({
        unexpected: true,
        latest: {
          cwd: "/workspace/验证项目",
          script: "test",
          command: "npm run test",
          status: "passed",
          exitCode: 0,
          signal: null,
          durationMs: 1,
          output: `safe\u0000\u202E${"x".repeat(20_000)}`,
          outputBytes: 20_008,
          outputTruncated: true,
          outputSanitized: true,
        },
      }),
    );
    const impossibleSignal = renderPanel(
      report({
        latest: {
          cwd: "/workspace/验证项目",
          script: "build",
          command: "npm run build",
          status: "failed",
          exitCode: 7,
          signal: "SIGTERM",
          durationMs: 1,
          output: "impossible signal",
          outputBytes: 17,
          outputTruncated: false,
          outputSanitized: false,
        },
      }),
    );

    expect(contradiction).toContain("面板数据不完整");
    expect(contradiction).not.toContain("impossible");
    expect(impossibleSignal).toContain("面板数据不完整");
    expect(impossibleSignal).not.toContain("impossible signal");
    expect(malformed).toContain("面板数据不完整");
    expect(malformed).not.toContain("\u0000");
    expect(malformed).not.toContain("\u202E");
    expect(malformed.length).toBeLessThan(16_000);
  });

  test("wraps long unbroken output instead of widening the panel", () => {
    const output = "x".repeat(1_000);
    const html = renderPanel(
      report({
        latest: {
          cwd: "/workspace/验证项目",
          script: "test",
          command: "npm run test",
          status: "passed",
          exitCode: 0,
          signal: null,
          durationMs: 1,
          output,
          outputBytes: output.length,
          outputTruncated: false,
          outputSanitized: false,
        },
      }),
    );

    expect(html).toMatch(/<pre class="[^"]*break-all[^"]*">/u);
    expect(html).toContain(output);
  });
});
