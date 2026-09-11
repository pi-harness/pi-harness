import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test, vi } from "vitest";
import cliNotifierPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

type PluginConfig = { enabled?: boolean; title?: string; timeoutMs?: number };

async function createNotifier(config: PluginConfig = { enabled: false }): Promise<{
  context: Context;
  panels: PiPluginUiRegistry;
  tool: ReturnType<PiToolRegistry["snapshot"]>["customTools"][number];
  tools: PiToolRegistry;
}> {
  const context = new Context();
  const panels = new PiPluginUiRegistry();
  const tools = new PiToolRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(cliNotifierPlugin, config);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "cli_notify");
  if (tool === undefined) throw new Error("cli_notify was not registered");
  return { context, panels, tool, tools };
}

async function waitForFile(path: string): Promise<void> {
  await vi.waitFor(
    async () => {
      await expect(access(path)).resolves.toBeUndefined();
    },
    { timeout: 5_000, interval: 10 },
  );
}

describe("cli-notifier", () => {
  test.skipIf(process.platform === "win32")("cancels queued notifications without waiting for the running notification", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-notifier-queued-"));
    const ready = join(root, "ready");
    const release = join(root, "release");
    const executable = join(root, process.platform === "darwin" ? "osascript" : "notify-send");
    const originalPath = process.env.PATH;
    const firstCaller = new AbortController(), queuedCaller = new AbortController();
    let fixture: Awaited<ReturnType<typeof createNotifier>> | undefined;
    let first: Promise<unknown> | undefined;
    try {
      await writeFile(executable, `#!${process.execPath}\nconst fs=require("node:fs");fs.appendFileSync(${JSON.stringify(ready)},"started\\n");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},20);setTimeout(()=>process.exit(9),8000);\n`);
      await chmod(executable, 0o700);
      process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
      fixture = await createNotifier({ enabled: true, timeoutMs: 6000 });
      first = fixture.tool.execute("first", { message: "running notification" }, firstCaller.signal, undefined, {} as never).catch((error: unknown) => error);
      await waitForFile(ready);
      let rejected = false;
      const queued = fixture.tool.execute("queued", { message: "cancelled queued notification" }, queuedCaller.signal, undefined, {} as never);
      const observed = queued.catch((error: unknown) => { rejected = true; return error; });
      queuedCaller.abort(new Error("cancelled while queued"));
      await vi.waitFor(() => expect(rejected).toBe(true), { timeout: 1000, interval: 20 });
      expect(await observed).toBe(queuedCaller.signal.reason);
      expect(await readFile(ready, "utf8")).toBe("started\n");
      await writeFile(release, "release");
      await expect(first).resolves.toMatchObject({ details: { delivered: true } });
      await fixture.tool.execute("after", { message: "queue recovered" }, undefined, undefined, {} as never);
      expect(await readFile(ready, "utf8")).toBe("started\nstarted\n");
      const panel = (await fixture.panels.snapshot())[0]?.data as { notifications: Array<{ message: string }> };
      expect(panel.notifications.map((entry) => entry.message)).toEqual(["queue recovered", "running notification"]);
    } finally {
      firstCaller.abort();
      queuedCaller.abort();
      await first;
      process.env.PATH = originalPath;
      await fixture?.context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 12000);

  test.skipIf(process.platform === "win32").each(["timeout-zero", "timeout-ignore", "timeout-tree", "cancel-tree"])(
    "%s never reports submission success or leaves an owned command running",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "pi-notifier-lifecycle-"));
      const executable = join(root, process.platform === "darwin" ? "osascript" : "notify-send");
      const ready = join(root, "ready");
      const marker = join(root, "called");
      const originalPath = process.env.PATH;
      const caller = new AbortController();
      let fixture: Awaited<ReturnType<typeof createNotifier>> | undefined;
      let pid: number | undefined;
      try {
        const worker = `process.on("SIGTERM",()=>{${mode === "timeout-zero" ? "process.exit(0)" : ""}});require("node:fs").writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>process.exit(9),8000)`;
        const action = mode.endsWith("tree") ? `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(worker)}],{stdio:"ignore"})` : worker;
        await writeFile(executable, `#!${process.execPath}\nconst fs=require("node:fs");if(fs.existsSync(${JSON.stringify(marker)}))process.exit(0);fs.writeFileSync(${JSON.stringify(marker)},"");${action}\n`);
        await chmod(executable, 0o700);
        process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
        fixture = await createNotifier({ enabled: true, timeoutMs: 2000 });
        let settled = false;
        const pending = fixture.tool.execute("lifecycle", { message: "inert notification fixture" }, caller.signal, undefined, {} as never);
        const observed = pending.then((result) => { settled = true; return result; }, (error: unknown) => { settled = true; return error; });
        await waitForFile(ready);
        pid = Number(await readFile(ready, "utf8"));
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        if (mode === "cancel-tree") caller.abort(new Error("cancelled by fixture"));
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 4500, interval: 20 });
        const result: unknown = await observed;
        if (mode === "cancel-tree") {
          expect(result).toBeInstanceOf(Error);
          await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { notifications: [] } }]);
        } else {
          expect(result).toMatchObject({ details: { delivered: false, reason: "Notification command timed out after 2000 ms" } });
        }
        await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 3000, interval: 20 });
        await expect(fixture.tool.execute("after", { message: "after failure" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { delivered: true } });
      } finally {
        caller.abort();
        if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, "SIGKILL"); } catch { /* Owned fixture exited. */ }
        }
        process.env.PATH = originalPath;
        await fixture?.context.fiber.dispose();
        await rm(root, { recursive: true, force: true });
      }
    }, 15000,
  );

  test("declares message and title bounds in the tool schema", async () => {
    const fixture = await createNotifier();
    try {
      expect(fixture.tool.parameters).toMatchObject({
        properties: {
          message: { type: "string", minLength: 1, maxLength: 2_048 },
          title: { type: "string", minLength: 1, maxLength: 256 },
        },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects malformed notification inputs before recording them", async () => {
    const fixture = await createNotifier();
    try {
      await expect(fixture.tool.execute("null", null, undefined, undefined, {} as never)).rejects.toThrow(/message must be a string/iu);
      for (const message of [7, "", "   ", "x".repeat(2_049), "contains\0null"]) {
        await expect(fixture.tool.execute("message", { message }, undefined, undefined, {} as never)).rejects.toThrow(/notification message/iu);
      }
      for (const title of [7, "", "   ", "x".repeat(257), "contains\0null"]) {
        await expect(fixture.tool.execute("title", { message: "valid", title }, undefined, undefined, {} as never)).rejects.toThrow(/notification title/iu);
      }
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { notifications: [] } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("accepts exact input boundaries and keeps only isolated recent history", async () => {
    const fixture = await createNotifier({ enabled: false });
    try {
      await expect(fixture.tool.execute("minimum", { message: "x", title: "y" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { delivered: false, reason: "disabled" },
      });
      for (let index = 0; index < 20; index += 1) {
        await fixture.tool.execute(
          String(index),
          { message: index === 19 ? "x".repeat(2_048) : `message-${index}`, title: "t".repeat(256) },
          undefined,
          undefined,
          {} as never,
        );
      }
      const [firstPanel] = await fixture.panels.snapshot();
      if (firstPanel === undefined) throw new Error("cli-notifier-panel was not registered");
      const data = firstPanel.data as { notifications: Array<{ message: string }>; timeoutMs: number };
      expect(data.timeoutMs).toBe(10_000);
      expect(data.notifications).toHaveLength(20);
      data.notifications[0]!.message = "mutated";

      const [secondPanel] = await fixture.panels.snapshot();
      expect((secondPanel?.data as { notifications: Array<{ message: string }> }).notifications[0]?.message).toBe("x".repeat(2_048));
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects non-finite notification timeouts at the config boundary", async () => {
    const context = new Context();
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await expect(context.plugin(cliNotifierPlugin, { enabled: false, timeoutMs: Number.NaN })).rejects.toThrow(/timeoutMs.*number|multiple/iu);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("labels aborted turns and ignores intermediate retry failures", async () => {
    const fixture = await createNotifier();
    try {
      fixture.context.emit("pi/session-event", {
        type: "agent_end",
        willRetry: true,
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "temporary" }],
      } as never);
      fixture.context.emit("pi/session-event", {
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "aborted" }],
      } as never);

      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { notifications: [{ message: "Agent turn aborted." }] } }]);
      const [panel] = await fixture.panels.snapshot();
      expect((panel?.data as { notifications: unknown[] }).notifications).toHaveLength(1);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("propagates caller cancellation to the desktop command", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-notifier-cancel-"));
    const bin = join(root, "bin");
    const started = join(root, "started");
    const executable = join(bin, process.platform === "darwin" ? "osascript" : "notify-send");
    const originalPath = process.env.PATH;
    const controller = new AbortController();
    let fixture: Awaited<ReturnType<typeof createNotifier>> | undefined;
    try {
      await mkdir(bin);
      await writeFile(executable, `#!/bin/sh\n: > ${JSON.stringify(started)}\nsleep 2\n`, "utf8");
      await chmod(executable, 0o700);
      process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
      fixture = await createNotifier({ enabled: true, timeoutMs: 5_000 });
      const execution = fixture.tool.execute("cancel", { message: "cancel me" }, controller.signal, undefined, {} as never);
      await waitForFile(started);

      controller.abort(new Error("caller cancelled notification"));

      await expect(execution).rejects.toThrow(/caller cancelled notification/iu);
    } finally {
      process.env.PATH = originalPath;
      await fixture?.context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes Windows notification text as data instead of PowerShell source", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-notifier-windows-"));
    const bin = join(root, "bin");
    const argumentsPath = join(root, "arguments");
    const messagePath = join(root, "message");
    const titlePath = join(root, "title");
    const executable = join(bin, "powershell.exe");
    const originalPath = process.env.PATH;
    const originalPlatform = process.platform;
    let fixture: Awaited<ReturnType<typeof createNotifier>> | undefined;
    try {
      await mkdir(bin);
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argumentsPath)}\nprintf '%s' "$PI_HARNESS_NOTIFICATION_MESSAGE" > ${JSON.stringify(messagePath)}\nprintf '%s' "$PI_HARNESS_NOTIFICATION_TITLE" > ${JSON.stringify(titlePath)}\n`,
        "utf8",
      );
      await chmod(executable, 0o700);
      process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
      fixture = await createNotifier({ enabled: true });
      const message = "message'; Write-Output INJECTED; #";
      const title = "title'; Write-Output INJECTED; #";

      await expect(fixture.tool.execute("windows", { message, title }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { delivered: true, platform: "win32" },
      });
      expect(await readFile(argumentsPath, "utf8")).not.toContain(message);
      expect(await readFile(argumentsPath, "utf8")).not.toContain(title);
      await expect(readFile(messagePath, "utf8")).resolves.toBe(message);
      await expect(readFile(titlePath, "utf8")).resolves.toBe(title);
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
      process.env.PATH = originalPath;
      await fixture?.context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("terminates Linux command options before user-controlled text", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-notifier-linux-"));
    const bin = join(root, "bin");
    const argumentsPath = join(root, "arguments");
    const executable = join(bin, "notify-send");
    const originalPath = process.env.PATH;
    const originalPlatform = process.platform;
    let fixture: Awaited<ReturnType<typeof createNotifier>> | undefined;
    try {
      await mkdir(bin);
      await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argumentsPath)}\n`, "utf8");
      await chmod(executable, 0o700);
      process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
      Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
      fixture = await createNotifier({ enabled: true });

      await expect(fixture.tool.execute("linux", { message: "--help", title: "-danger" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        content: [{ type: "text", text: "Desktop notification submitted to the system. Display and read status are not verified." }],
        details: { delivered: true, platform: "linux" },
      });
      await expect(readFile(argumentsPath, "utf8")).resolves.toBe("--\n-danger\n--help\n");
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
      process.env.PATH = originalPath;
      await fixture?.context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unregisters all surfaces and invalidates retained tool references on disposal", async () => {
    const fixture = await createNotifier();
    await fixture.context.fiber.dispose();

    expect(fixture.tools.snapshot().customTools).toEqual([]);
    await expect(fixture.panels.snapshot()).resolves.toEqual([]);
    await expect(fixture.tool.execute("stale", { message: "should not send" }, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
  });
});
