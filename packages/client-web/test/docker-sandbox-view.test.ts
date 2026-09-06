import { describe, expect, test } from "vitest";
import { dockerSandboxPanelView } from "../src/docker-sandbox-view.js";

const defaultSettings = {
  image: "alpine:3.20",
  pull: "never",
  network: "none",
  rootFilesystem: "read-only",
  workspace: "read-only",
  memory: "512m",
  cpus: 1,
  pids: 256,
  timeoutMs: 120_000,
} as const;

describe("Docker sandbox panel view", () => {
  test("normalizes run status and exposes the enforced sandbox defaults", () => {
    const view = dockerSandboxPanelView({
      latest: {
        image: "alpine:3.20",
        command: ["node", "--version"],
        write: false,
        exitCode: 0,
        status: "completed",
        output: "v22.0.0\n",
      },
      defaults: {
        image: "alpine:3.20",
        pull: "never",
        network: "none",
        rootFilesystem: "read-only",
        workspace: "read-only",
        memory: "512m",
        cpus: 1,
        pids: 256,
        timeoutMs: 120_000,
      },
    });

    expect(view).toEqual({
      malformed: false,
      latest: {
        image: "alpine:3.20",
        command: ["node", "--version"],
        commandCount: 2,
        write: false,
        exitCode: 0,
        status: "completed",
        output: "v22.0.0\n",
        truncated: false,
      },
      defaults: {
        image: "alpine:3.20",
        pull: "never",
        network: "none",
        rootFilesystem: "read-only",
        workspace: "read-only",
        memory: "512m",
        cpus: 1,
        pids: 256,
        timeoutMs: 120_000,
      },
    });
  });

  test("keeps arguments that carry tabs and line breaks", () => {
    const view = dockerSandboxPanelView({
      latest: {
        image: "alpine:3.20",
        command: ["python3", "-c", "import sys\nprint(1)"],
        write: false,
        exitCode: 0,
        status: "completed",
        output: "1\n",
      },
      defaults: { ...defaultSettings },
    });

    expect(view.malformed).toBe(false);
    expect(view.latest?.command).toEqual(["python3", "-c", "import sys\nprint(1)"]);
    expect(view.latest).toMatchObject({ commandCount: 3, exitCode: 0, status: "completed", truncated: false });
  });

  test("bounds hostile command and output details while preserving totals", () => {
    const command = Array.from({ length: 20 }, (_, index) => (index === 0 ? "x".repeat(300) : `arg-${index}`));
    const view = dockerSandboxPanelView({
      latest: { image: "i".repeat(800), command, write: true, exitCode: 7, status: "failed", output: "o".repeat(5_000) },
      defaults: { ...defaultSettings },
    });

    expect(view.latest).toMatchObject({
      image: "i".repeat(512),
      commandCount: 20,
      write: true,
      exitCode: 7,
      status: "failed",
      output: "o".repeat(4_000),
      truncated: true,
    });
    expect(view.latest?.command).toHaveLength(16);
    expect(view.latest?.command[0]).toBe("x".repeat(256));
    expect(view.defaults.timeoutMs).toBe(120_000);
    expect(view.defaults.cpus).toBe(1);
    expect(view.defaults.pids).toBe(256);
    expect(view.malformed).toBe(false);
  });

  test("rejects malformed latest values instead of presenting them as successful runs", () => {
    const view = dockerSandboxPanelView({ latest: { image: {}, command: "echo ok", exitCode: Number.NaN, status: "completed" } });

    expect(view).toEqual({
      malformed: true,
      latest: null,
      defaults: {
        image: "alpine:3.20",
        pull: "never",
        network: "none",
        rootFilesystem: "read-only",
        workspace: "read-only",
        memory: "512m",
        cpus: 1,
        pids: 256,
        timeoutMs: 120_000,
      },
    });
  });

  test("fails closed for accessors, revoked proxies, and contradictory inventories", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "defaults", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [accessor, revoked.proxy, { defaults: { ...defaultSettings, timeoutMs: 1 }, latest: null }]) {
      expect(() => dockerSandboxPanelView(value)).not.toThrow();
      expect(dockerSandboxPanelView(value).malformed).toBe(true);
    }
    expect(getterCalls).toBe(0);
  });
});
