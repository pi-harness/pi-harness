import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, test } from "vitest";
import { createTestRuntimeContext } from "./runtime-fixture.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function createRuntimeContext(): Promise<{ context: Context; responseText: string[]; callCount: () => number }> {
  const { context, faux } = await createTestRuntimeContext([fauxAssistantMessage("deterministic response")]);
  contexts.push(context);
  const responseText: string[] = [];
  context.piRuntime.session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") responseText.push(event.assistantMessageEvent.delta);
  });
  return { context, responseText, callCount: () => faux.state.callCount };
}

describe("Pi runtime plugin", () => {
  test("completes a deterministic Pi agent run", async () => {
    const { context, responseText, callCount } = await createRuntimeContext();

    await context.piRuntime.prompt("respond once");

    expect(responseText.join("")).toBe("deterministic response");
    expect(callCount()).toBe(1);
  });

  test("disposes the Pi session with its Cordis fiber", async () => {
    const { context } = await createRuntimeContext();
    const runtime = context.piRuntime;

    await context.fiber.dispose();

    await expect(runtime.prompt("too late")).rejects.toThrow(/disposed/);
  });

  test("fails activation when configured core tools are unknown to Pi", async () => {
    await expect(createTestRuntimeContext([], ["not-a-pi-tool"])).rejects.toThrow(/not-a-pi-tool/);
  });

  test("fails activation when a Pi extension cannot be loaded instead of running without it", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-broken-extension-"));
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "broken.ts"), `throw new Error("deliberate extension load failure");`, "utf8");

    await expect(createTestRuntimeContext([], [], { noExtensions: false, agentDir })).rejects.toThrow(/deliberate extension load failure/);
  });

  test("accepts a tool an extension registers during session start", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-extension-tool-"));
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "greet.js"), `export default function (pi) { pi.on("session_start", () => { pi.registerTool({ name: "greet", label: "Greet", description: "Greet a person.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, async execute() { return { content: [{ type: "text", text: "hi" }], details: undefined }; } }); }); }`, "utf8");

    const { context } = await createTestRuntimeContext([], ["greet"], { noExtensions: false, agentDir });
    contexts.push(context);

    expect(context.piRuntime.session.getAllTools().map((tool) => tool.name)).toContain("greet");
  }, 30_000);

  test("runs Pi's session shutdown hook before disposing the session", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-shutdown-"));
    const marker = join(agentDir, "shutdown.txt");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "probe.js"), `import { writeFileSync } from "node:fs"; export default function (pi) { pi.on("session_shutdown", () => { writeFileSync(${JSON.stringify(marker)}, "shutdown"); }); }`, "utf8");
    const { context } = await createTestRuntimeContext([], [], { noExtensions: false, agentDir });

    await context.fiber.dispose();

    await expect(readFile(marker, "utf8")).resolves.toBe("shutdown");
  }, 30_000);

  test("disposes the Pi session even when the in-flight abort rejects", async () => {
    const { context } = await createRuntimeContext();
    const runtime = context.piRuntime;
    const session = runtime.session as unknown as { abort: () => Promise<void>; dispose: () => void };
    const realDispose = session.dispose.bind(session);
    let disposed = 0;
    Object.defineProperty(session, "isIdle", { value: false, configurable: true });
    session.abort = () => Promise.reject(new Error("abort failed"));
    session.dispose = () => { disposed += 1; realDispose(); };

    await expect(runtime.dispose()).rejects.toThrow(/abort failed/);

    expect(disposed).toBe(1);
    await expect(runtime.prompt("too late")).rejects.toThrow(/disposed/);
  });

  test("keeps the agent run alive when a pi/session-event listener throws", async () => {
    const { context, responseText, callCount } = await createRuntimeContext();
    const extensionErrors: string[] = [];
    context.on("pi/extension-error", (error) => { extensionErrors.push(error.error); });
    context.on("pi/session-event", () => { throw new Error("listener boom"); });

    await context.piRuntime.prompt("respond once");

    expect(responseText.join("")).toBe("deterministic response");
    expect(callCount()).toBe(1);
    expect(extensionErrors).toContain("listener boom");
  });
});
