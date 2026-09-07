import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import runtimePlugin from "../src/plugins/runtime.js";
import { PiRuntime } from "../src/runtime.js";
import { PiToolRegistry } from "@pi-harness/plugin-api";
import { createTestRuntimeContext, createTestRuntimeServices } from "../src/test-harness.js";

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

  test("replaces the active session through the Pi session runtime", async () => {
    const { context } = await createRuntimeContext();
    const before = context.piRuntime.session.sessionId;

    await context.piRuntime.sessionRuntime.newSession();

    expect(context.piRuntime.session.sessionId).not.toBe(before);
    expect(context.piRuntime.session.messages).toEqual([]);
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
    await writeFile(
      join(agentDir, "extensions", "greet.js"),
      `export default function (pi) { pi.on("session_start", () => { pi.registerTool({ name: "greet", label: "Greet", description: "Greet a person.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, async execute() { return { content: [{ type: "text", text: "hi" }], details: undefined }; } }); }); }`,
      "utf8",
    );

    const { context } = await createTestRuntimeContext([], ["greet"], { noExtensions: false, agentDir });
    contexts.push(context);

    expect(context.piRuntime.session.getAllTools().map((tool) => tool.name)).toContain("greet");
  }, 30_000);

  test("runs Pi's session shutdown hook before disposing the session", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-shutdown-"));
    const marker = join(agentDir, "shutdown.txt");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "probe.js"),
      `import { writeFileSync } from "node:fs"; export default function (pi) { pi.on("session_shutdown", () => { writeFileSync(${JSON.stringify(marker)}, "shutdown"); }); }`,
      "utf8",
    );
    const { context } = await createTestRuntimeContext([], [], { noExtensions: false, agentDir });

    await context.fiber.dispose();

    await expect(readFile(marker, "utf8")).resolves.toBe("shutdown");
  }, 30_000);

  test("does not build a second session over a SessionManager while the first is tearing down", async () => {
    const { context } = await createRuntimeContext();
    const order: string[] = [];
    const sessionRuntime = context.piRuntime.sessionRuntime as unknown as { dispose: () => Promise<void> };
    const realDispose = sessionRuntime.dispose.bind(sessionRuntime);
    sessionRuntime.dispose = async () => {
      order.push("teardown:start");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await realDispose();
      order.push("teardown:end");
    };
    // A replacement fiber sharing the same SessionManager, which is what an HMR reload produces.
    const replacementContext = new Context();
    contexts.push(replacementContext);
    for (const service of ["piHarnessLaunch", "piModelRuntime", "piModels", "piResources", "piSession", "piTools"] as const) {
      replacementContext.provide(service, context.get(service) as never);
    }

    const teardown = context.fiber.dispose();
    const replacement = replacementContext.plugin(runtimePlugin, { thinkingLevel: "off" }).then(() => {
      order.push("second-session:created");
    });
    await Promise.all([teardown, replacement]);

    expect(order).toEqual(["teardown:start", "teardown:end", "second-session:created"]);
  }, 20_000);

  test("releases the SessionManager gate when initial runtime creation fails", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-gate-recovery-"));
    const { context } = await createTestRuntimeServices([], [], { noExtensions: false, agentDir });
    contexts.push(context);
    context.piResources.resourceLoader.getExtensions().errors.push({ path: "reload-broken.js", error: "gate creation failure" });

    await expect(context.plugin(runtimePlugin, { thinkingLevel: "off" })).rejects.toThrow(/gate creation failure/iu);
    const unregisterProbe = context.piTools.register({ name: "gate-recovery-probe" } as never);
    unregisterProbe();
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    let recoveryError: unknown;
    const activation = context.plugin(runtimePlugin, { thinkingLevel: "off" }).then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = "rejected";
        recoveryError = error;
      },
    );

    await vi.waitFor(() => expect(outcome).not.toBe("pending"), { timeout: 1_000, interval: 10 });
    expect(recoveryError).toBeInstanceOf(Error);
    expect((recoveryError as Error).message).toMatch(/gate creation failure/iu);
    expect(outcome).toBe("rejected");
    await activation;
  });

  test("releases the SessionManager gate when runtime binding fails", async () => {
    const { context } = await createRuntimeContext();
    const shared = {
      piHarnessLaunch: context.get("piHarnessLaunch"),
      piModelRuntime: context.get("piModelRuntime"),
      piModels: context.get("piModels"),
      piResources: context.get("piResources"),
      piSession: context.get("piSession"),
    };
    await context.fiber.dispose();

    const failing = new Context();
    contexts.push(failing);
    for (const [service, value] of Object.entries(shared)) failing.provide(service as keyof typeof shared, value as never);
    failing.provide("piTools", new PiToolRegistry(["not-a-pi-tool"]));
    await expect(failing.plugin(runtimePlugin, { thinkingLevel: "off" })).rejects.toThrow(/not-a-pi-tool/iu);

    const recovery = new Context();
    contexts.push(recovery);
    for (const [service, value] of Object.entries(shared)) recovery.provide(service as keyof typeof shared, value as never);
    recovery.provide("piTools", new PiToolRegistry());
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    let recoveryError: unknown;
    const activation = recovery.plugin(runtimePlugin, { thinkingLevel: "off" }).then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = "rejected";
        recoveryError = error;
      },
    );

    await vi.waitFor(() => expect(outcome).not.toBe("pending"), { timeout: 1_000, interval: 10 });
    expect(recoveryError).toBeUndefined();
    expect(outcome).toBe("resolved");
    await activation;
  });

  test("disposes the Pi session even when the in-flight abort rejects", async () => {
    const { context } = await createRuntimeContext();
    const runtime = context.piRuntime;
    const session = runtime.session as unknown as { abort: () => Promise<void>; dispose: () => void };
    const realDispose = session.dispose.bind(session);
    let disposed = 0;
    Object.defineProperty(session, "isIdle", { value: false, configurable: true });
    session.abort = () => Promise.reject(new Error("abort failed"));
    session.dispose = () => {
      disposed += 1;
      realDispose();
    };

    await expect(runtime.dispose()).rejects.toThrow(/abort failed/);

    expect(disposed).toBe(1);
    await expect(runtime.prompt("too late")).rejects.toThrow(/disposed/);
  });

  test("makes concurrent disposal callers wait for the same teardown", async () => {
    let resolveAbort: (() => void) | undefined;
    let runtimeDisposals = 0;
    const runtime = new PiRuntime({
      session: {
        isIdle: false,
        abort: () =>
          new Promise<void>((resolve) => {
            resolveAbort = resolve;
          }),
      },
      dispose: () => {
        runtimeDisposals += 1;
        return Promise.resolve();
      },
    } as never);

    const first = runtime.dispose();
    await vi.waitFor(() => expect(resolveAbort).toBeDefined());
    let secondSettled = false;
    const second = runtime.dispose().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    resolveAbort?.();
    await Promise.all([first, second]);
    expect(runtimeDisposals).toBe(1);
  });

  test("keeps the agent run alive when a pi/session-event listener throws", async () => {
    const { context, responseText, callCount } = await createRuntimeContext();
    const extensionErrors: string[] = [];
    context.on("pi/extension-error", (error) => {
      extensionErrors.push(error.error);
    });
    context.on("pi/session-event", () => {
      throw new Error("listener boom");
    });

    await context.piRuntime.prompt("respond once");

    expect(responseText.join("")).toBe("deterministic response");
    expect(callCount()).toBe(1);
    expect(extensionErrors).toContain("listener boom");
  });

  test("bounds listener failures without executing hostile error accessors", async () => {
    const { context, responseText, callCount } = await createRuntimeContext();
    const extensionErrors: string[] = [];
    let accessed = false;
    let events = 0;
    const hostile = new Error();
    Object.defineProperty(hostile, "message", {
      get() {
        accessed = true;
        throw new Error("hostile error getter executed");
      },
    });
    context.on("pi/extension-error", (error) => {
      extensionErrors.push(error.error);
    });
    context.on("pi/session-event", () => {
      events += 1;
      throw events === 1 ? new Error("x".repeat(3_000)) : hostile;
    });

    await context.piRuntime.prompt("respond once");

    expect(responseText.join("")).toBe("deterministic response");
    expect(callCount()).toBe(1);
    expect(events).toBeGreaterThan(1);
    expect(extensionErrors[0]).toHaveLength(2_000);
    expect(extensionErrors).toContain("Unknown pi/session-event listener error");
    expect(accessed).toBe(false);
  });

  test("keeps extension-error observers from interrupting the agent run", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-extension-error-observer-"));
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "probe.js"),
      `export default function (pi) { pi.on("turn_start", () => { throw new Error("extension turn failure"); }); }`,
      "utf8",
    );
    const { context, faux } = await createTestRuntimeContext([fauxAssistantMessage("response survived")], [], { noExtensions: false, agentDir });
    contexts.push(context);
    let observed = 0;
    context.on("pi/extension-error", () => {
      observed += 1;
      throw new Error("extension error observer failed");
    });

    await context.piRuntime.prompt("respond once");

    expect(observed).toBeGreaterThan(0);
    expect(faux.state.callCount).toBe(1);
    expect(context.piRuntime.session.messages.some((message) => message.role === "assistant")).toBe(true);
  });
});
