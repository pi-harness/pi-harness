import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { parsePluginStarsPayload, searchPluginStars } from "../src/index.js";
import pluginStars from "../src/index.js";
import toolsPlugin from "@pi-harness/core/plugins/tools";

const validPlugin = {
  id: "1",
  name: "fixture",
  fullName: "owner/fixture",
  description: "Fixture",
  htmlUrl: "https://github.com/owner/fixture",
  homepage: "https://example.invalid/fixture",
  npmName: "@fixture/plugin",
  stars: 1,
  updatedAt: "2026-09-05T00:00:00Z",
  license: "MIT",
  topics: ["pi-harness-plugin"],
};

describe("plugin stars", () => {
  test("declares bounded configuration and tool inputs", async () => {
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
    try {
      expect(pluginStars.Config.dict?.sourceUrl?.meta).toMatchObject({ min: 1, max: 2_048 });
      expect(pluginStars.Config.dict?.limit?.meta).toMatchObject({ min: 1, max: 50 });
      expect(pluginStars.Config.dict?.timeoutMs?.meta).toMatchObject({ min: 1_000, max: 60_000 });
      expect(context.piTools.snapshot().customTools.find((tool) => tool.name === "plugin_stars_search")?.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string", maxLength: 120 } },
      });
      expect(context.piTools.snapshot().customTools.find((tool) => tool.name === "plugin_stars_search")?.executionMode).toBe("sequential");
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rolls back the search tool when panel registration fails", async () => {
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    panels.register({ id: "plugin-stars-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });
    try {
      await expect(context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" })).rejects.toThrow(
        /already registered.*plugin-stars-panel/iu,
      );
      expect(tools.snapshot().customTools).toEqual([]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("validates descriptor-only search parameters before fetching", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = () => {
      fetches += 1;
      return Promise.resolve(Response.json({ plugins: [] }));
    };
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
    const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");
    let accessed = false;
    const params = {} as { query?: string };
    Object.defineProperty(params, "query", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("query getter executed");
      },
    });
    try {
      await expect(tool!.execute("call-1", params, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(tool!.execute("call-2", { unexpected: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
      await expect(tool!.execute("call-3", null, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*object/iu);
      await expect(tool!.execute("call-4", { query: "x".repeat(121) }, undefined, undefined, {} as never)).rejects.toThrow(/0-120 characters/iu);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });

  test("rejects ranking sources outside raw.githubusercontent.com", async () => {
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    try {
      let activationError: unknown;
      try {
        await context.plugin(pluginStars, { sourceUrl: "https://example.com/plugins.json" });
      } catch (error) {
        activationError = error;
      }
      expect(activationError).toBeInstanceOf(Error);
      if (!(activationError instanceof Error)) throw new Error("Expected invalid source URL rejection");
      expect(activationError.message).toMatch(/raw\.githubusercontent\.com/iu);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("disables redirects while fetching the curated ranking", async () => {
    const originalFetch = globalThis.fetch;
    let redirect: RequestRedirect | undefined;
    globalThis.fetch = (_input, init) => {
      redirect = init?.redirect;
      return Promise.resolve(Response.json({ source: "fixture", generatedAt: "2026-09-05T00:00:00Z", plugins: [] }));
    };
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
    try {
      const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");
      await tool!.execute("call-1", {}, undefined, undefined, {} as never);
      expect(redirect).toBe("error");
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });

  test("normalizes curated ranking data and filters by query", () => {
    const report = parsePluginStarsPayload({
      generatedAt: "2026-09-02T12:00:00Z",
      source: "fixture-ranking",
      plugins: [
        {
          id: "1",
          name: "ModLens",
          fullName: "liustack/modlens",
          description: "Vision bridge",
          htmlUrl: "https://github.com/liustack/modlens",
          stars: 3835,
          updatedAt: "2026-09-02T12:00:00Z",
          topics: ["pi-harness-plugin", "vision"],
        },
        {
          id: "2",
          name: "Other",
          fullName: "owner/other",
          description: "Task board",
          htmlUrl: "https://github.com/owner/other",
          stars: 281,
          updatedAt: "2026-09-02T11:00:00Z",
          topics: ["taskboard"],
        },
      ],
    });

    expect(searchPluginStars(report, "vision")).toEqual([
      expect.objectContaining({ name: "ModLens", fullName: "liustack/modlens", stars: 3835, topics: ["pi-harness-plugin", "vision"] }),
    ]);
    expect(report).toMatchObject({ generatedAt: "2026-09-02T12:00:00Z", source: "fixture-ranking" });
  });

  test("keeps the public-transport ranking fixture valid", async () => {
    const payload = JSON.parse(await readFile(new URL("./fixtures/ranking.json", import.meta.url), "utf8")) as unknown;
    const report = parsePluginStarsPayload(payload);

    expect(searchPluginStars(report, "productivity")).toEqual([
      expect.objectContaining({ fullName: "pi-harness/workflow-engine-fixture", stars: 840, npmName: "@fixture/workflow-engine" }),
    ]);
  });

  test("rejects malformed entries instead of silently publishing a partial ranking", () => {
    expect(() =>
      parsePluginStarsPayload({
        source: "fixture",
        generatedAt: "2026-09-05T00:00:00Z",
        plugins: [{ id: "1", name: "bad", fullName: "bad", htmlUrl: "https://example.com", stars: -1 }, null],
      }),
    ).toThrow(/plugin 1 fullName/iu);
  });

  test("rejects curated inventories above 1000 plugins", () => {
    const plugin = {
      id: "1",
      name: "fixture",
      fullName: "owner/fixture",
      description: "Fixture",
      htmlUrl: "https://github.com/owner/fixture",
      stars: 1,
      updatedAt: "2026-09-05T00:00:00Z",
      topics: [],
    };
    expect(() =>
      parsePluginStarsPayload({ source: "fixture", generatedAt: "2026-09-05T00:00:00Z", plugins: Array.from({ length: 1_001 }, () => plugin) }),
    ).toThrow(/inventory cannot exceed 1000 plugins/iu);
  });

  test.each([null, [], {}, { plugins: null }])("rejects malformed curated ranking envelopes", (payload) => {
    expect(() => parsePluginStarsPayload(payload)).toThrow(/ranking.*object.*plugins array/iu);
  });

  test.each([
    [{ ...validPlugin, id: "x".repeat(65) }, /plugin 1 ID.*64/iu],
    [{ ...validPlugin, name: "x".repeat(257) }, /plugin 1 name.*256/iu],
    [{ ...validPlugin, description: "x".repeat(4_097) }, /plugin 1 description.*4096/iu],
    [{ ...validPlugin, htmlUrl: "https://github.com/owner/other" }, /plugin 1 repository URL.*fullName/iu],
    [{ ...validPlugin, homepage: "javascript:alert(1)" }, /plugin 1 homepage.*http/iu],
    [{ ...validPlugin, homepage: "https://user:secret@example.com/" }, /plugin 1 homepage.*credentials/iu],
    [{ ...validPlugin, stars: Number.MAX_SAFE_INTEGER + 1 }, /plugin 1 stars.*safe integer/iu],
    [{ ...validPlugin, updatedAt: "not-a-date" }, /plugin 1 updatedAt.*timestamp/iu],
    [{ ...validPlugin, updatedAt: "2026-02-30T00:00:00Z" }, /plugin 1 updatedAt.*timestamp/iu],
    [{ ...validPlugin, topics: Array.from({ length: 25 }, (_, index) => `topic-${index}`) }, /plugin 1 topics.*24/iu],
    [{ ...validPlugin, topics: ["x".repeat(65)] }, /plugin 1 topic 1.*64/iu],
  ])("rejects malformed or overlong curated plugin fields", (plugin, expected) => {
    expect(() => parsePluginStarsPayload({ source: "fixture", generatedAt: "2026-09-05T00:00:00Z", plugins: [plugin] })).toThrow(expected);
  });

  test.each([
    [{ generatedAt: "2026-09-05T00:00:00Z", plugins: [] }, /source.*string/iu],
    [{ source: "x".repeat(257), generatedAt: "2026-09-05T00:00:00Z", plugins: [] }, /source.*256/iu],
    [{ source: "fixture", generatedAt: "not-a-date", plugins: [] }, /generatedAt.*timestamp/iu],
    [{ source: "fixture", generatedAt: "2026-02-30T00:00:00Z", plugins: [] }, /generatedAt.*timestamp/iu],
  ])("rejects malformed curated ranking metadata", (payload, expected) => {
    expect(() => parsePluginStarsPayload(payload)).toThrow(expected);
  });

  test("rejects duplicate repository identities in curated data", () => {
    expect(() =>
      parsePluginStarsPayload({
        source: "fixture",
        generatedAt: "2026-09-05T00:00:00Z",
        plugins: [validPlugin, { ...validPlugin, id: "2" }],
      }),
    ).toThrow(/duplicate.*owner\/fixture/iu);
  });

  test("registers a read-only search tool and panel", async () => {
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
    expect(context.piTools.snapshot().customTools.map((tool) => tool.name)).toContain("plugin_stars_search");
    await expect(context.piPluginUi.snapshot()).resolves.toEqual([expect.objectContaining({ id: "plugin-stars-panel", title: "Plugin Stars" })]);
    await context.fiber.dispose();
  });

  test("publishes a bounded panel ranking with explicit inventory metadata", async () => {
    const originalFetch = globalThis.fetch;
    const plugins = Array.from({ length: 30 }, (_, index) => ({
      ...validPlugin,
      id: String(index + 1),
      name: `fixture-${index}`,
      fullName: `owner/fixture-${index}`,
      htmlUrl: `https://github.com/owner/fixture-${index}`,
      stars: 30 - index,
    }));
    globalThis.fetch = () => Promise.resolve(Response.json({ source: "fixture", generatedAt: "2026-09-05T00:00:00Z", plugins }));
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json", limit: 50 });
    try {
      const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");
      const result = await tool!.execute("call-1", {}, undefined, undefined, {} as never);
      expect((result.details as { results: unknown[] }).results).toHaveLength(30);

      const panel = (await context.piPluginUi.snapshot())[0];
      expect((panel?.data as { latest: { results: unknown[] } }).latest.results).toHaveLength(20);
      expect(panel?.data).toMatchObject({
        inventory: { total: 30, shown: 20, truncated: true },
        limits: { responseBytes: 2 * 1024 * 1024, sourceItems: 1_000, resultItems: 50, panelItems: 20, queryCharacters: 120, timeoutMs: 15_000 },
      });
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });

  test("does not expose mutable ranking state through tool results or panel snapshots", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(Response.json({ source: "fixture", generatedAt: "2026-09-05T00:00:00Z", plugins: [validPlugin] }));
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
    try {
      const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");
      const result = await tool!.execute("call-1", {}, undefined, undefined, {} as never);
      (result.details as { results: Array<{ name: string }> }).results[0]!.name = "mutated";

      const firstPanel = (await context.piPluginUi.snapshot())[0];
      expect(firstPanel?.data).toMatchObject({ latest: { results: [{ name: "fixture" }] } });
      (firstPanel?.data as { latest: { results: Array<{ name: string }> } }).latest.results[0]!.name = "panel-mutated";

      await expect(context.piPluginUi.snapshot()).resolves.toMatchObject([{ data: { latest: { results: [{ name: "fixture" }] } } }]);
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });

  test("reports the complete match count when the configured result limit truncates results", async () => {
    const originalFetch = globalThis.fetch;
    const plugins = Array.from({ length: 12 }, (_, index) => ({
      ...validPlugin,
      id: String(index + 1),
      name: `fixture-${index}`,
      fullName: `owner/fixture-${index}`,
      htmlUrl: `https://github.com/owner/fixture-${index}`,
    }));
    globalThis.fetch = () => Promise.resolve(Response.json({ source: "fixture", generatedAt: "2026-09-05T00:00:00Z", plugins }));
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json", limit: 5 });
    try {
      const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");
      const result = await tool!.execute("call-1", {}, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ total: 12, truncated: true });
      expect((result.details as { results: unknown[] }).results).toHaveLength(5);
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.details);
      const panelSnapshot = await context.piPluginUi.snapshot();
      expect(panelSnapshot).toMatchObject([{ data: { inventory: { total: 12, shown: 5, truncated: true }, latest: { total: 12 } } }]);
      expect(Object.keys((panelSnapshot[0]!.data as { latest: object }).latest)).not.toContain("truncated");
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });

  test("rejects an oversized ranking before reading its body", async () => {
    const originalFetch = globalThis.fetch;
    let bodyRead = false;
    let bodyCancelled = false;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(2 * 1024 * 1024 + 1) }),
        body: {
          cancel() {
            bodyCancelled = true;
            return Promise.resolve();
          },
          getReader() {
            bodyRead = true;
            throw new Error("oversized body was read");
          },
        },
        text() {
          bodyRead = true;
          return Promise.reject(new Error("oversized body was read"));
        },
      } as unknown as Response);
    const context = new Context();
    try {
      provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
      await context.plugin(toolsPlugin, { names: [] });
      await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
      const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");

      await expect(tool!.execute("call-1", {}, undefined, undefined, {} as never)).rejects.toThrow(/2 MiB limit/iu);
      expect(bodyRead).toBe(false);
      expect(bodyCancelled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });

  test("preserves the response-size error when oversized-body cleanup fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader() {
            return {
              read: () => Promise.resolve({ done: false, value: new Uint8Array(2 * 1024 * 1024 + 1) }),
              cancel: () => Promise.reject(new Error("cleanup failed")),
              releaseLock() {},
            };
          },
        },
      } as unknown as Response);
    const context = new Context();
    try {
      provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
      await context.plugin(toolsPlugin, { names: [] });
      await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
      const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");

      await expect(tool!.execute("oversized-cleanup", {}, undefined, undefined, {} as never)).rejects.toThrow(/source exceeded the 2 MiB limit/iu);
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });

  test("rejects ranking responses that are not valid UTF-8", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(new Uint8Array([0xc3, 0x28])));
    const context = new Context();
    try {
      provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
      await context.plugin(toolsPlugin, { names: [] });
      await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
      const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");

      await expect(tool!.execute("call-1", {}, undefined, undefined, {} as never)).rejects.toThrow(/valid UTF-8/iu);
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });

  test("cancels unsuccessful ranking response bodies", async () => {
    const originalFetch = globalThis.fetch;
    let bodyCancelled = false;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        body: {
          cancel() {
            bodyCancelled = true;
            return Promise.resolve();
          },
        },
      } as unknown as Response);
    const context = new Context();
    try {
      provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
      await context.plugin(toolsPlugin, { names: [] });
      await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
      const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");

      await expect(tool!.execute("call-1", {}, undefined, undefined, {} as never)).rejects.toThrow(/HTTP 503/iu);
      expect(bodyCancelled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });

  test("does not fetch when a plugin stars request is already cancelled", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = () => {
      fetches += 1;
      return Promise.resolve(new Response('{"plugins":[]}'));
    };
    const context = new Context();
    try {
      provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
      await context.plugin(toolsPlugin, { names: [] });
      await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
      const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");
      const caller = new AbortController();
      caller.abort(new Error("cancelled before execution"));

      await expect(tool!.execute("call-1", {}, caller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });

  test("cancels an in-flight ranking request when the plugin is disposed", async () => {
    const originalFetch = globalThis.fetch;
    let aborted = false;
    let rejectPending: ((reason: Error) => void) | undefined;
    globalThis.fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        rejectPending = reject;
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("ranking request aborted"));
          },
          { once: true },
        );
      });
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
    const tools = context.piTools;
    const panels = context.piPluginUi;
    const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const pending = tool!.execute("call-1", {}, undefined, undefined, {} as never);
    try {
      await context.fiber.dispose();
      const outcome = await Promise.race([
        pending.then(
          () => new Error("Ranking request unexpectedly succeeded"),
          (error: unknown) => error,
        ),
        new Promise<string>((resolve) => {
          fallback = setTimeout(() => resolve("Ranking request remained pending"), 500);
        }),
      ]);
      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome)).toMatch(/disposed|cancelled/iu);
      expect(aborted).toBe(true);
      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toEqual([]);
    } finally {
      if (fallback !== undefined) clearTimeout(fallback);
      rejectPending?.(new Error("test cleanup"));
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
      await pending.catch(() => undefined);
    }
  });
  test("does not publish a response cancelled while its JSON body is being read", async () => {
    const originalFetch = globalThis.fetch;
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
    const tool = tools.snapshot().customTools[0]!;
    try {
      globalThis.fetch = () => Promise.resolve(Response.json({ source: "fixture", generatedAt: "2026-09-05T00:00:00Z", plugins: [validPlugin] }));
      await tool.execute("before", { query: "before" }, undefined, undefined, {} as never);
      const controller = new AbortController();
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(new TextEncoder().encode(JSON.stringify({ source: "fixture", generatedAt: "2026-09-05T00:00:00Z", plugins: [validPlugin] })));
                controller.abort();
                stream.close();
              },
            }),
          ),
        );
      await expect(tool.execute("cancelled", { query: "after" }, controller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
      expect((await panels.snapshot())[0]?.data).toMatchObject({ latest: { query: "before" } });
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });

  test("cancels a ranking response body that stalls after headers arrive", async () => {
    const originalFetch = globalThis.fetch;
    let cancelCalled = false;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let releaseRead!: () => void;
    const pendingRead = new Promise<{ done: true; value?: undefined }>((resolve) => {
      releaseRead = () => resolve({ done: true });
    });
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader() {
            return {
              read() {
                markReadStarted();
                return pendingRead;
              },
              cancel() {
                cancelCalled = true;
                releaseRead();
                return Promise.resolve();
              },
              releaseLock() {},
            };
          },
        },
      } as unknown as Response);
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(pluginStars, { sourceUrl: "https://raw.githubusercontent.com/fixture/ranking/main/plugins.json" });
    const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_stars_search");
    if (tool === undefined) throw new Error("plugin_stars_search was not registered");
    const caller = new AbortController();
    let execution: Promise<unknown> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      execution = tool.execute("stalled-body", {}, caller.signal, undefined, {} as never);
      await Promise.race([
        readStarted,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error("timed out waiting for ranking read to start")), 5_000);
        }),
      ]);
      if (watchdog !== undefined) clearTimeout(watchdog);
      caller.abort(new Error("cancel stalled ranking body"));
      const outcome = await Promise.race([
        execution.then(
          () => new Error("Plugin stars search unexpectedly succeeded"),
          (error: unknown) => error,
        ),
        new Promise<string>((resolve) => {
          watchdog = setTimeout(() => resolve("Plugin stars search remained pending"), 500);
        }),
      ]);

      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome)).toMatch(/cancelled/iu);
      expect(cancelCalled).toBe(true);
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      releaseRead();
      await execution?.catch(() => undefined);
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });
  test("requires an explicit ranking source and never fetches the old DSH default", async () => {
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(pluginStars, {});
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = () => {
      fetches++;
      throw new Error("unexpected fetch");
    };
    try {
      await expect(tools.snapshot().customTools[0]!.execute("unconfigured", {}, undefined, undefined, {} as never)).rejects.toThrow(/sourceUrl/iu);
      expect(fetches).toBe(0);
      expect((await panels.snapshot())[0]?.data).toMatchObject({ source: "", latest: null });
    } finally {
      globalThis.fetch = originalFetch;
      await context.fiber.dispose();
    }
  });
});
