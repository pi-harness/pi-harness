import { mkdtemp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import themeStudioPlugin, { themePresets } from "../src/index.js";

describe("theme studio", () => {
  test("exposes bounded presets and persists the selected theme", async () => {
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    const manager = SessionManager.inMemory();
    context.provide("piSession", { manager });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(themeStudioPlugin, {});
      expect(Object.keys(themePresets)).toEqual(["light", "midnight", "paper", "high-contrast"]);
      const set = tools.snapshot().customTools.find((tool) => tool.name === "theme_set");
      const status = tools.snapshot().customTools.find((tool) => tool.name === "theme_status");
      expect(set).toBeDefined();
      expect(status).toBeDefined();
      await expect(set!.execute("set-1", { theme: "midnight" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { theme: "midnight", tokens: { "--color-ink": "#f8fafc" } },
      });
      await expect(status!.execute("status-1", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { theme: "midnight", tokens: { "--color-blue": "#8ab4ff" } },
      });
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "theme-studio-panel", data: { theme: "midnight", changed: true } }]);
      expect(manager.getEntries()).toHaveLength(1);
    } finally {
      await context.fiber.dispose();
    }
  });
});

async function fixture() {
  const context = new Context(),
    tools = new PiToolRegistry(),
    panels = new PiPluginUiRegistry();
  const service = { manager: SessionManager.inMemory() };
  context.provide("piSession", service);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(themeStudioPlugin, {});
  const call = (name: string, params: unknown = {}, signal?: AbortSignal) =>
    tools
      .snapshot()
      .customTools.find((tool) => tool.name === name)!
      .execute("test", params, signal, undefined, {} as never);
  return { context, tools, panels, service, call };
}

test("re-reads native session state and returns detached tokens", async () => {
  const { context, service, call } = await fixture();
  try {
    const first = service.manager;
    const result = await call("theme_set", { theme: "midnight" });
    (result.details as { tokens: Record<string, string> }).tokens["--color-ink"] = "red";
    expect((await call("theme_status")).details).toMatchObject({ theme: "midnight", tokens: { "--color-ink": "#f8fafc" } });
    service.manager = SessionManager.inMemory();
    expect((await call("theme_status")).details).toMatchObject({ theme: "light", changed: false });
    service.manager = first;
    expect((await call("theme_status")).details).toMatchObject({ theme: "midnight", changed: true });
  } finally {
    await context.fiber.dispose();
  }
});

test("rejects raw invalid input, cancellation, session changes and disposed handles", async () => {
  const { context, service, call, tools } = await fixture();
  const set = tools.snapshot().customTools.find((tool) => tool.name === "theme_set")!;
  try {
    for (const params of [
      null,
      [],
      { theme: "invalid" },
      { theme: "light", extra: true },
      Object.defineProperty({}, "theme", {
        get() {
          throw Error("getter invoked");
        },
      }),
    ])
      await expect(call("theme_set", params)).rejects.toThrow(/parameters/iu);
    await expect(call("theme_status", { extra: true })).rejects.toThrow(/parameters/iu);
    const abort = new AbortController();
    const pending = call("theme_set", { theme: "paper" }, abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow(/cancelled/iu);
    const stale = call("theme_set", { theme: "paper" });
    service.manager.newSession();
    await expect(stale).rejects.toThrow(/session changed/iu);
    expect(service.manager.getEntries()).toHaveLength(0);
    await context.fiber.dispose();
    await expect(set.execute("disposed", { theme: "paper" }, undefined, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
  } finally {
    await context.fiber.dispose();
  }
});

test("persists across disk reopen and quarantines native write failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-theme-test-"));
  const { context, service, call, panels } = await fixture();
  try {
    const manager = SessionManager.create(root, join(root, "sessions"));
    service.manager = manager;
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Initialize journal" }],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    await call("theme_set", { theme: "paper" });
    const file = manager.getSessionFile()!;
    manager.setSessionFile(file);
    const before = (await call("theme_status")).details;
    expect(before).toMatchObject({ theme: "paper", changed: true });
    const disk = await readFile(file, "utf8");
    await rename(file, file + ".backup");
    await mkdir(file);
    await expect(call("theme_set", { theme: "midnight" })).rejects.toThrow(/write failed/iu);
    await expect(call("theme_status")).rejects.toThrow(/reopen/iu);
    expect((await panels.snapshot())[0]?.error).toMatch(/reopen/iu);
    await rm(file, { recursive: true });
    await rename(file + ".backup", file);
    manager.setSessionFile(file);
    expect((await call("theme_status")).details).toEqual(before);
    expect(await readFile(file, "utf8")).toBe(disk);
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unknown configuration and rolls back registrations on panel conflict", async () => {
  const context = new Context(),
    tools = new PiToolRegistry(),
    panels = new PiPluginUiRegistry();
  context.provide("piSession", { manager: SessionManager.inMemory() });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  try {
    await expect(context.plugin(themeStudioPlugin, { extra: true } as never)).rejects.toThrow(/unknown/iu);
    panels.register({ id: "theme-studio-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });
    await expect(context.plugin(themeStudioPlugin, {})).rejects.toThrow(/already registered/iu);
    expect(tools.snapshot().customTools).toHaveLength(0);
  } finally {
    await context.fiber.dispose();
  }
});

test("uses the replacement native runtime manager instead of the launch service", async () => {
  const { context, service, call } = await fixture();
  const active = SessionManager.inMemory();
  context.provide("piRuntime", { session: { sessionManager: active } } as never);
  try {
    await call("theme_set", { theme: "high-contrast" });
    expect(active.getEntries()).toHaveLength(1);
    expect(service.manager.getEntries()).toHaveLength(0);
    expect((await call("theme_status")).details).toMatchObject({ theme: "high-contrast", sessionId: active.getSessionId() });
  } finally {
    await context.fiber.dispose();
  }
});

test("keeps primary and status text readable against matching preset surfaces", () => {
  const luminance = (hex: string) => {
    const rgb = hex
      .slice(1)
      .match(/../gu)!
      .map((c) => Number.parseInt(c, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  };
  const pairs = [["ink", "surface"], ["muted", "soft"], ["faint", "soft"], ...["blue", "green", "red", "amber"].map((key) => [key, key + "-soft"])];
  for (const preset of Object.values(themePresets))
    for (const [fg, bg] of pairs) {
      const a = luminance(preset.tokens["--color-" + fg]!),
        b = luminance(preset.tokens["--color-" + bg]!);
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), preset.label + " " + fg + "/" + bg).toBeGreaterThanOrEqual(4.5);
    }
});
