import { describe, expect, test } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { provideLaunchContext } from "../src/services.js";
import { buildBridgePackage, parseBridgePackage } from "../src/plugins/session-bridge.js";
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

  test("rejects malformed bridge packages and oversized message lists", () => {
    expect(() => parseBridgePackage(JSON.stringify({ version: 2 }))).toThrow(/version/);
    const tooMany = {
      version: 1,
      source: { sessionId: "s", cwd: "/tmp" },
      messages: Array.from({ length: 101 }, () => ({ role: "user", text: "x", hasImages: false })),
    };
    expect(() => parseBridgePackage(JSON.stringify(tooMany))).toThrow(/100 messages/);
  });

  test("exports and imports through native Pi session entries", async () => {
    const context = new Context();
    provideLaunchContext(context, { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    await context.plugin(toolsPlugin, { names: [] });
    await context.plugin(sessionPlugin, { storage: "memory" });
    await context.plugin(sessionBridge, {});
    const tools = context.piTools.snapshot().customTools;
    const exporter = tools.find((tool) => tool.name === "session_bridge_export");
    const importer = tools.find((tool) => tool.name === "session_bridge_import");
    expect(exporter).toBeDefined();
    expect(importer).toBeDefined();
    const exported = await exporter!.execute("export", {});
    expect(exported.details).toMatchObject({ version: 1, messageCount: 0 });
    await importer!.execute("import", { package: JSON.stringify(exported.details) });
    expect(context.piSession.manager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "pi-harness/session-bridge")).toBe(
      true,
    );
    await context.fiber.dispose();
  });
});
