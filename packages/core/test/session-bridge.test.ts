import { describe, expect, test } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { buildBridgePackage, buildHandoffPreview, parseBridgePackage } from "../src/plugins/session-bridge.js";
import sessionBridge from "../src/plugins/session-bridge.js";
import sessionPlugin from "../src/plugins/session.js";
import toolsPlugin from "../src/plugins/tools.js";

describe("session bridge", () => {
  test("exports a bounded handoff package with model intent and attachment markers", () => {
    const result = buildBridgePackage(
      {
        sessionId: "session-123",
        cwd: "/workspace/app",
        model: { provider: "everyapi", modelId: "deepseek-v4-flash" },
      },
      [
        { role: "user", content: "Inspect the dashboard" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I need the screenshot." },
            { type: "image", data: "base64", mimeType: "image/png" },
          ],
        },
      ],
    );

    expect(result).toMatchObject({ version: 1, source: { sessionId: "session-123", cwd: "/workspace/app", model: { provider: "everyapi" } }, messageCount: 2 });
    expect(result.messages).toEqual([
      { role: "user", text: "Inspect the dashboard", hasImages: false },
      { role: "assistant", text: "I need the screenshot.", hasImages: true },
    ]);
    expect(result.unresolvedAttachments).toEqual(["message-2:image/png"]);
  });

  test("builds packages without invoking message accessors or retaining unbounded content parts", () => {
    let messageAccessed = false;
    let partAccessed = false;
    const hostileMessage = { role: "user" } as { role: string; content?: unknown };
    Object.defineProperty(hostileMessage, "content", {
      enumerable: true,
      get() {
        messageAccessed = true;
        throw new Error("session message content getter executed");
      },
    });
    const hostilePart = {} as Record<string, unknown>;
    Object.defineProperty(hostilePart, "type", {
      enumerable: true,
      get() {
        partAccessed = true;
        throw new Error("session content part getter executed");
      },
    });
    const packageValue = buildBridgePackage(
      {
        sessionId: "s".repeat(1_000),
        cwd: "/" + "w".repeat(10_000),
        model: { provider: "p".repeat(1_000), modelId: "m".repeat(1_000) },
      },
      [
        hostileMessage,
        {
          role: "assistant",
          content: [hostilePart, ...Array.from({ length: 1_100 }, (_, index) => ({ type: "image", mimeType: `image/type-${index}` }))],
        },
      ],
    );

    expect(messageAccessed).toBe(false);
    expect(partAccessed).toBe(false);
    expect(packageValue.source.sessionId).toHaveLength(256);
    expect(packageValue.source.cwd).toHaveLength(4_096);
    expect(packageValue.source.model?.provider).toHaveLength(256);
    expect(packageValue.source.model?.modelId).toHaveLength(256);
    expect(packageValue.messages).toHaveLength(2);
    expect(packageValue.unresolvedAttachments).toHaveLength(100);
  });

  test("rejects unsafe source metadata without invoking accessors", () => {
    let sourceAccessed = false;
    let modelAccessed = false;
    const source = { cwd: "/workspace" } as { sessionId?: string; cwd: string; model?: { provider: string; modelId: string } };
    Object.defineProperty(source, "sessionId", {
      enumerable: true,
      get() {
        sourceAccessed = true;
        throw new Error("source session id getter executed");
      },
    });
    expect(() => buildBridgePackage(source as never, [])).toThrow(/source.*data properties/iu);
    expect(sourceAccessed).toBe(false);

    const model = { modelId: "model" } as { provider?: string; modelId: string };
    Object.defineProperty(model, "provider", {
      enumerable: true,
      get() {
        modelAccessed = true;
        throw new Error("source model provider getter executed");
      },
    });
    expect(() => buildBridgePackage({ sessionId: "session", cwd: "/workspace", model: model as never }, [])).toThrow(/model.*data properties/iu);
    expect(modelAccessed).toBe(false);
  });

  test("emits a self-parseable package within the serialized byte limit", () => {
    const packageValue = buildBridgePackage(
      { sessionId: "session", cwd: `/${"\ud800".repeat(4_095)}` },
      Array.from({ length: 10 }, () => ({ role: "user", content: "\ud800".repeat(16_000) })),
    );
    const serialized = JSON.stringify(packageValue);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(256 * 1_024);
    expect(parseBridgePackage(serialized)).toEqual(packageValue);
  });

  test("rejects malformed bridge packages and oversized message lists", () => {
    expect(() => parseBridgePackage(JSON.stringify({ version: 2 }))).toThrow(/version/);
    const tooMany = {
      version: 1,
      source: { sessionId: "s", cwd: "/tmp" },
      createdAt: "2026-09-05T00:00:00.000Z",
      messageCount: 101,
      messages: Array.from({ length: 101 }, () => ({ role: "user", text: "x", hasImages: false })),
      unresolvedAttachments: [],
    };
    expect(() => parseBridgePackage(JSON.stringify(tooMany))).toThrow(/100 messages/);
  });

  test("strictly validates package, source, model, message, and attachment metadata", () => {
    const valid = buildBridgePackage({ sessionId: "source-session", cwd: "/source", model: { provider: "fixture", modelId: "model" } }, [
      { role: "user", content: "handoff" },
    ]);
    const invalid: Array<{ label: string; value: unknown }> = [
      { label: "unknown root field", value: { ...valid, unknown: true } },
      { label: "message count", value: { ...valid, messageCount: 0 } },
      { label: "created timestamp", value: { ...valid, createdAt: "yesterday" } },
      { label: "empty session id", value: { ...valid, source: { ...valid.source, sessionId: "" } } },
      { label: "long cwd", value: { ...valid, source: { ...valid.source, cwd: "x".repeat(4_097) } } },
      { label: "NUL source", value: { ...valid, source: { ...valid.source, cwd: "/tmp\0hidden" } } },
      { label: "unknown source field", value: { ...valid, source: { ...valid.source, unknown: true } } },
      { label: "partial model", value: { ...valid, source: { ...valid.source, model: { provider: "fixture" } } } },
      { label: "unknown message field", value: { ...valid, messages: [{ ...valid.messages[0], unknown: true }] } },
      {
        label: "too many attachments",
        value: {
          ...valid,
          messages: [{ ...valid.messages[0], hasImages: true }],
          unresolvedAttachments: Array.from({ length: 101 }, (_, index) => `message-1:image/type-${index}`),
        },
      },
      {
        label: "duplicate attachment",
        value: { ...valid, messages: [{ ...valid.messages[0], hasImages: true }], unresolvedAttachments: ["message-1:image/png", "message-1:image/png"] },
      },
      { label: "invalid attachment target", value: { ...valid, unresolvedAttachments: ["message-2:image/png"] } },
    ];

    for (const fixture of invalid) expect(() => parseBridgePackage(JSON.stringify(fixture.value)), fixture.label).toThrow();
  });

  test("builds a bounded five-part preview without changing the source package", () => {
    const packageValue = buildBridgePackage({ sessionId: "session-123", cwd: "/workspace/app" }, [
      { role: "user", content: "Fix src/app.ts and keep the API stable." },
      { role: "assistant", content: "I changed src/app.ts and added tests. The next step is to run npm test." },
      { role: "user", content: "Run the tests and inspect package.json." },
    ]);
    const preview = buildHandoffPreview(packageValue);
    expect(preview).toEqual({
      goal: "Fix src/app.ts and keep the API stable.",
      currentState: "I changed src/app.ts and added tests. The next step is to run npm test.",
      decisions: ["Fix src/app.ts and keep the API stable."],
      keyFiles: ["src/app.ts", "package.json"],
      nextStep: "Run the tests and inspect package.json.",
    });
    expect(packageValue.messages).toHaveLength(3);
  });

  test("declares bounded schemas and validates tool parameters before export or import side effects", async () => {
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(sessionPlugin, { storage: "memory" });
    await context.plugin(sessionBridge);
    const exporter = context.piTools.snapshot().customTools.find((tool) => tool.name === "session_bridge_export");
    const importer = context.piTools.snapshot().customTools.find((tool) => tool.name === "session_bridge_import");
    const previewer = context.piTools.snapshot().customTools.find((tool) => tool.name === "session_bridge_preview");
    if (exporter === undefined || importer === undefined || previewer === undefined) throw new Error("Session Bridge tools were not registered");
    let accessed = false;
    const accessor = { confirm: true } as { package?: string; confirm: boolean };
    Object.defineProperty(accessor, "package", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("Session Bridge package getter executed");
      },
    });
    try {
      expect(previewer.parameters).toMatchObject({ properties: { package: { type: "string", maxLength: 262_144 } } });
      expect(importer.parameters).toMatchObject({
        required: ["package", "confirm"],
        properties: { package: { type: "string", maxLength: 262_144 }, confirm: { type: "boolean" } },
      });
      await expect(importer.execute("accessor", accessor, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(exporter.execute("unknown", { unknown: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
      await expect(exporter.execute("null", null, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*object/iu);
      await expect(previewer.execute("long", { package: "x".repeat(262_145) }, undefined, undefined, {} as never)).rejects.toThrow(/package.*limit/iu);

      const packageValue = buildBridgePackage({ sessionId: "source", cwd: "/source" }, []);
      const before = context.piSession.manager.getEntries().length;
      await expect(
        importer.execute("unconfirmed", { package: JSON.stringify(packageValue), confirm: false }, undefined, undefined, {} as never),
      ).rejects.toThrow(/confirm=true/iu);
      expect(context.piSession.manager.getEntries()).toHaveLength(before);

      const caller = new AbortController();
      caller.abort(new Error("cancel bridge operation"));
      await expect(exporter.execute("cancelled", {}, caller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
      expect(context.piSession.manager.getEntries()).toHaveLength(before);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("exports and imports through native Pi session entries", async () => {
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(sessionPlugin, { storage: "memory" });
    await context.plugin(sessionBridge);
    const tools = context.piTools.snapshot().customTools;
    const exporter = tools.find((tool) => tool.name === "session_bridge_export");
    const importer = tools.find((tool) => tool.name === "session_bridge_import");
    const previewer = tools.find((tool) => tool.name === "session_bridge_preview");
    expect(exporter).toBeDefined();
    expect(importer).toBeDefined();
    expect(previewer).toBeDefined();
    const exported = await exporter!.execute("export", {}, undefined, undefined, {} as never);
    expect(exported.details).toMatchObject({ version: 1, messageCount: 0 });
    await importer!.execute("import", { package: JSON.stringify(exported.details), confirm: true }, undefined, undefined, {} as never);
    expect(context.piSession.manager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "pi-harness/session-bridge")).toBe(
      true,
    );
    await context.fiber.dispose();
  });

  test("reads the active runtime manager after a session replacement", async () => {
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(sessionPlugin, { storage: "memory" });
    context.piSession.manager.appendMessage({ role: "user", content: [{ type: "text", text: "stale session" }], timestamp: Date.now() });
    const activeManager = SessionManager.inMemory("/active");
    activeManager.appendMessage({ role: "user", content: [{ type: "text", text: "active session" }], timestamp: Date.now() });
    context.provide("piRuntime", { session: { sessionManager: activeManager } } as never);
    await context.plugin(sessionBridge);
    const previewer = context.piTools.snapshot().customTools.find((tool) => tool.name === "session_bridge_preview");
    const importer = context.piTools.snapshot().customTools.find((tool) => tool.name === "session_bridge_import");
    expect(previewer).toBeDefined();
    expect(importer).toBeDefined();
    const result = await previewer!.execute("preview", {}, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ source: { cwd: "/active" }, preview: { goal: "active session" } });
    const packageValue = buildBridgePackage({ sessionId: "source", cwd: "/source" }, [{ role: "user", content: "handoff" }]);
    await importer!.execute("import", { package: JSON.stringify(packageValue), confirm: true }, undefined, undefined, {} as never);
    expect(activeManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "pi-harness/session-bridge")).toBe(true);
    expect(context.piSession.manager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "pi-harness/session-bridge")).toBe(
      false,
    );
    await context.fiber.dispose();
  });

  test("rejects a duplicate handoff before appending another context message", async () => {
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(sessionPlugin, { storage: "memory" });
    await context.plugin(sessionBridge);
    const importer = context.piTools.snapshot().customTools.find((tool) => tool.name === "session_bridge_import");
    if (importer === undefined) throw new Error("Session Bridge import tool was not registered");
    const packageValue = buildBridgePackage({ sessionId: "source", cwd: "/source" }, [{ role: "user", content: "handoff" }]);
    const parameters = { package: JSON.stringify(packageValue), confirm: true };
    try {
      await importer.execute("first", parameters, undefined, undefined, {} as never);
      await expect(importer.execute("duplicate", parameters, undefined, undefined, {} as never)).rejects.toThrow(/handoff.*already imported/iu);
      expect(
        context.piSession.manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-harness/session-bridge"),
      ).toHaveLength(1);
      await expect(context.piPluginUi.snapshot()).resolves.toMatchObject([{ data: { limits: { duplicateScanEntries: 10_000 } } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("does not expose mutable preview or panel state", async () => {
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(sessionPlugin, { storage: "memory" });
    await context.plugin(sessionBridge);
    const previewer = context.piTools.snapshot().customTools.find((tool) => tool.name === "session_bridge_preview");
    if (previewer === undefined) throw new Error("Session Bridge preview tool was not registered");
    const packageValue = buildBridgePackage({ sessionId: "source", cwd: "/source", model: { provider: "fixture", modelId: "model" } }, [
      { role: "user", content: "Keep src/index.ts stable." },
    ]);
    try {
      const result = await previewer.execute("preview", { package: JSON.stringify(packageValue) }, undefined, undefined, {} as never);
      (result.details as { source: { model: { provider: string } }; preview: { goal: string } }).source.model.provider = "mutated";
      (result.details as { source: { model: { provider: string } }; preview: { goal: string } }).preview.goal = "mutated";

      const firstPanel = (await context.piPluginUi.snapshot())[0];
      expect(firstPanel?.data).toMatchObject({
        latestPreview: { source: { model: { provider: "fixture" } }, preview: { goal: "Keep src/index.ts stable." } },
        limits: { packageBytes: 262_144, messages: 100, contentParts: 1_000, attachments: 100, previewTextCharacters: 1_000, previewListItems: 8 },
      });
      (firstPanel?.data as { latestPreview: { preview: { goal: string } } }).latestPreview.preview.goal = "mutated panel";
      await expect(context.piPluginUi.snapshot()).resolves.toMatchObject([
        { data: { latestPreview: { source: { model: { provider: "fixture" } }, preview: { goal: "Keep src/index.ts stable." } } } },
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("publishes bounded operation failures without replacing the last success or invoking error accessors", async () => {
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(sessionPlugin, { storage: "memory" });
    await context.plugin(sessionBridge);
    const exporter = context.piTools.snapshot().customTools.find((tool) => tool.name === "session_bridge_export");
    if (exporter === undefined) throw new Error("Session Bridge export tool was not registered");
    await exporter.execute("successful", {}, undefined, undefined, {} as never);

    let failure: Error | undefined;
    const manager = {
      buildSessionContext() {
        if (failure !== undefined) {
          const current = failure;
          failure = undefined;
          throw current;
        }
        return { model: null, messages: [] };
      },
      getSessionId: () => "active-session",
      getCwd: () => "/workspace",
    };
    context.provide("piRuntime", { session: { sessionManager: manager } } as never);
    try {
      failure = new Error("x".repeat(3_000));
      await expect(exporter.execute("long-error", {}, undefined, undefined, {} as never)).rejects.toThrow();
      const failedPanel = (await context.piPluginUi.snapshot())[0];
      expect(failedPanel?.data).toMatchObject({
        latest: { direction: "export" },
        status: { state: "failed", operation: "export" },
        limits: { operationErrorCharacters: 2_000 },
      });
      expect((failedPanel?.data as { status: { error: string } }).status.error).toHaveLength(2_000);

      let accessed = false;
      const hostileError = new Error();
      delete (hostileError as { message?: string }).message;
      Object.defineProperty(hostileError, "message", {
        get() {
          accessed = true;
          throw new Error("error getter executed");
        },
      });
      failure = hostileError;
      await expect(exporter.execute("hostile-error", {}, undefined, undefined, {} as never)).rejects.toBe(hostileError);
      await expect(context.piPluginUi.snapshot()).resolves.toMatchObject([
        { data: { latest: { direction: "export" }, status: { state: "failed", operation: "export", error: "Unknown Session Bridge error" } } },
      ]);
      expect(accessed).toBe(false);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("caches the current preview until a session event invalidates it", async () => {
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    let contextBuilds = 0;
    const manager = {
      buildSessionContext() {
        contextBuilds += 1;
        return { model: null, messages: [] };
      },
      getSessionId: () => "session",
      getCwd: () => "/workspace",
    };
    context.provide("piSession", { manager } as never);
    context.provide("piPluginUi", panels);
    context.provide("piTools", tools);
    await context.plugin(sessionBridge);
    try {
      await panels.snapshot();
      await panels.snapshot();
      expect(contextBuilds).toBe(1);
      context.emit("pi/session-event", { type: "message_end" } as never);
      await panels.snapshot();
      expect(contextBuilds).toBe(2);
    } finally {
      await context.fiber.dispose();
    }
  });
});
