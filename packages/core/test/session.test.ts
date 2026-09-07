import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import sessionPlugin, { Config as SessionConfig } from "../src/plugins/session.js";
import { provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

async function createContext(): Promise<{ context: Context; cwd: string; agentDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-session-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-session-agent-"));
  temporaryDirectories.push(cwd, agentDir);
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  return { context, cwd, agentDir };
}

describe("session plugin", () => {
  test.each([42, "jsonl", []])("rejects a non-object configuration: %j", async (config) => {
    const { context } = await createContext();

    await expect(context.plugin(sessionPlugin, config as never)).rejects.toBeInstanceOf(Error);
    expect(context.get("piSession")).toBeUndefined();
  });

  test.each(["   ", "sessions\0hidden", "sessions\nhidden", "sessions\u001bhidden", "x".repeat(4_097)])(
    "rejects an unsafe or unbounded session directory: %j",
    (directory) => {
      expect(() => SessionConfig({ storage: "jsonl", directory })).toThrow(/directory/u);
    },
  );

  test.each([{ storage: "disk" }, { storage: 1 }, { directory: 42 }])("rejects an invalid session option type: %j", (config) => {
    expect(() => SessionConfig(config as never)).toThrow();
  });

  test("rejects a directory option that memory storage would silently ignore", async () => {
    const { context } = await createContext();
    let activationError: unknown;
    try {
      await context.plugin(sessionPlugin, { storage: "memory", directory: "sessions" });
    } catch (error) {
      activationError = error;
    }

    expect(activationError).toBeInstanceOf(Error);
    expect((activationError as Error).message).toMatch(/directory.*memory/iu);
    expect(context.get("piSession")).toBeUndefined();
  });

  test("creates the default JSONL manager under the configured agent directory", async () => {
    const { context, cwd, agentDir } = await createContext();

    await context.plugin(sessionPlugin);

    expect(context.piSession.manager.isPersisted()).toBe(true);
    expect(context.piSession.manager.getCwd()).toBe(cwd);
    expect(context.piSession.manager.getSessionDir()).toBe(join(agentDir, "sessions"));
  });

  test.each(["relative", "absolute"])("resolves a %s custom JSONL directory deterministically", async (kind) => {
    const { context, cwd } = await createContext();
    const external = await mkdtemp(join(tmpdir(), "pi-harness-session-external-"));
    temporaryDirectories.push(external);
    const configured = kind === "relative" ? join("var", "sessions") : external;

    await context.plugin(sessionPlugin, { storage: "jsonl", directory: configured });

    expect(context.piSession.manager.getSessionDir()).toBe(kind === "relative" ? join(cwd, configured) : external);
  });

  test("rejects an existing file as the JSONL session directory during activation", async () => {
    const { context, cwd } = await createContext();
    const file = join(cwd, "sessions-file");
    await writeFile(file, "not a directory", "utf8");
    let activationError: unknown;
    try {
      await context.plugin(sessionPlugin, { storage: "jsonl", directory: file });
    } catch (error) {
      activationError = error;
    }

    expect(activationError).toBeInstanceOf(Error);
    expect((activationError as Error).message).toMatch(/session directory.*directory/iu);
    expect(context.get("piSession")).toBeUndefined();
  });

  test("persists a complete JSONL transcript and reopens it through the upstream manager", async () => {
    const { context, cwd } = await createContext();
    const directory = join(cwd, "sessions");
    await context.plugin(sessionPlugin, { storage: "jsonl", directory });
    const manager = context.piSession.manager;
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeDefined();

    manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    await expect(access(sessionFile ?? "")).rejects.toMatchObject({ code: "ENOENT" });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "world" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 2,
    });

    const lines = (await readFile(sessionFile ?? "", "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(lines.map((line) => line.type)).toEqual(["session", "message", "message"]);
    const reopened = SessionManager.open(sessionFile ?? "");
    expect(reopened.getSessionId()).toBe(manager.getSessionId());
    expect(reopened.getCwd()).toBe(cwd);
    expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("keeps memory sessions entirely in process", async () => {
    const { context, cwd } = await createContext();
    await context.plugin(sessionPlugin, { storage: "memory" });
    const manager = context.piSession.manager;

    manager.appendMessage({ role: "user", content: "ephemeral", timestamp: 1 });

    expect(manager.isPersisted()).toBe(false);
    expect(manager.getCwd()).toBe(cwd);
    expect(manager.getSessionDir()).toBe("");
    expect(manager.getSessionFile()).toBeUndefined();
    expect(manager.buildSessionContext().messages).toEqual([{ role: "user", content: "ephemeral", timestamp: 1 }]);
  });

  test("removes the session service on disposal", async () => {
    const { context } = await createContext();
    await context.plugin(sessionPlugin, { storage: "memory" });
    expect(context.get("piSession")).toBeDefined();

    await context.fiber.dispose();

    expect(context.get("piSession")).toBeUndefined();
  });
});
