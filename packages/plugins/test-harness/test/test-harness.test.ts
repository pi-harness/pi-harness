import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import testHarnessPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ context: Context; panels: PiPluginUiRegistry; root: string; tools: PiToolRegistry }> {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-test-harness-"));
  temporaryDirectories.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node -e \"process.stdout.write('ok')\"" } }), "utf8");
  const context = new Context();
  contexts.push(context);
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  return { context, panels, root, tools };
}

function registeredTool(tools: PiToolRegistry) {
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "run_project_tests");
  if (tool === undefined) throw new Error("run_project_tests was not registered");
  return tool;
}

interface RunDetails {
  script: string;
  command: string;
  status: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
}

async function waitForFile(path: string, description: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ${description}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function stopFixtureProcess(pid: number | undefined): void {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

describe("test-harness", () => {
  test.skipIf(process.platform === "win32")("finishes hard cleanup before a short-lived host exits", async () => {
    const { root } = await fixture();
    const pidPath = join(root, "worker.pid");
    const npmCli = join(root, "owned-npm.mjs");
    const worker = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setTimeout(()=>process.exit(9),8000);`;
    await writeFile(npmCli, `import {spawn} from 'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'});`);
    let pid: number | undefined;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
import {Context} from '@deepseek-ai/cordis';
import {PiToolRegistry,PiPluginUiRegistry,provideLaunchContext} from '@pi-harness/plugin-api';
import plugin from './packages/plugins/test-harness/dist/index.js';
const context=new Context(),tools=new PiToolRegistry();
provideLaunchContext(context,{cwd:${JSON.stringify(root)},agentDir:${JSON.stringify(root)},args:[],requestExit(){}});
context.provide('piTools',tools);context.provide('piPluginUi',new PiPluginUiRegistry());
await context.plugin(plugin,{timeoutMs:500});
try {
  const result=await tools.snapshot().customTools.find(t=>t.name==='run_project_tests').execute('timeout',{},undefined,undefined,{});
  process.stdout.write(JSON.stringify(result.details));
} finally {await context.fiber.dispose();}
`], { cwd: process.cwd(), env: { ...process.env, npm_execpath: npmCli }, timeout: 5000 });
      expect(JSON.parse(stdout)).toMatchObject({ status: "timed-out" });
      pid = Number(await readFile(pidPath, "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      await expect.poll(() => {
        try { process.kill(pid!, 0); return true; } catch { return false; }
      }, { timeout: 2000, interval: 20 }).toBe(false);
    } finally {
      if (pid === undefined) pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
      stopFixtureProcess(pid);
    }
  });

  test("declares a strict sequential tool contract", async () => {
    const { context, tools } = await fixture();
    await context.plugin(testHarnessPlugin);
    const tool = registeredTool(tools);

    expect(testHarnessPlugin).toHaveProperty("Config");
    expect(tool.executionMode).toBe("sequential");
    const parameters = tool.parameters as { type: unknown; additionalProperties: unknown; properties: { script: { anyOf: readonly { const?: unknown }[] } } };
    expect(parameters.type).toBe("object");
    expect(parameters.additionalProperties).toBe(false);
    expect(Array.isArray(parameters.properties.script.anyOf)).toBe(true);
    expect(parameters.properties.script.anyOf.map((item) => item.const)).toEqual(["test", "build", "format:check", "lint", "typecheck"]);
  });

  test("rejects malformed raw parameters without invoking accessors", async () => {
    const { context, tools } = await fixture();
    await context.plugin(testHarnessPlugin);
    const tool = registeredTool(tools);
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "script", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "not-allowed";
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const withSymbol = { script: "test", [Symbol("extra")]: true };

    for (const parameters of [
      null,
      [],
      new Date(),
      { script: 1 },
      { script: " test" },
      { script: "test " },
      { script: "test", extra: true },
      withSymbol,
      accessor,
    ]) {
      await expect(tool.execute("invalid", parameters as never, undefined, undefined, {} as never)).rejects.toThrow(/test harness parameters/iu);
    }
    await expect(tool.execute("proxy", revocable.proxy, undefined, undefined, {} as never)).rejects.toThrow(/accessible plain object/iu);
    expect(getterCalls).toBe(0);
  });

  test("rejects unknown or invalid configuration before registering surfaces", async () => {
    for (const config of [{ unexpected: true }, { timeoutMs: 99 }, { timeoutMs: 1_000.5 }, { timeoutMs: 600_001 }]) {
      const { context, panels, tools } = await fixture();

      await expect(context.plugin(testHarnessPlugin, config as never)).rejects.toThrow(/test-harness|timeoutMs|unknown/iu);
      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toEqual([]);
    }
  });

  test("rolls back the tool when panel registration fails", async () => {
    const { context, panels, tools } = await fixture();
    panels.register({ id: "test-harness-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });

    await expect(context.plugin(testHarnessPlugin)).rejects.toThrow(/panel is already registered: test-harness-panel/iu);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "test-harness-panel", pluginId: "fixture" }]);
  });

  test("reports real successful and failed npm script outcomes through detached snapshots", async () => {
    const { context, panels, root, tools } = await fixture();
    await writeFile(join(root, "pass.mjs"), 'process.stdout.write("passed\\n"); process.stderr.write("warning\\n");\n', "utf8");
    await writeFile(join(root, "fail.mjs"), 'process.stdout.write("before failure\\n"); process.stderr.write("failed\\n"); process.exitCode = 7;\n', "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node pass.mjs", build: "node fail.mjs" } }), "utf8");
    await context.plugin(testHarnessPlugin);
    const tool = registeredTool(tools);

    const passed = await tool.execute("pass", {}, undefined, undefined, {} as never);
    const passedText = passed.content[0]?.type === "text" ? passed.content[0].text : "";
    const passedDetails = passed.details as RunDetails;
    expect(passedText).toMatch(/<test-output .*untrusted="true".*status="passed"/u);
    expect(passedDetails).toMatchObject({
      script: "test",
      command: "npm run test",
      status: "passed",
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    });
    expect(typeof passedDetails.durationMs).toBe("number");
    expect(typeof passedDetails.outputBytes).toBe("number");
    expect(passedDetails.output).toContain("passed");
    expect(passedDetails.output).toContain("warning");

    const failed = await tool.execute("fail", { script: "build" }, undefined, undefined, {} as never);
    const failedText = failed.content[0]?.type === "text" ? failed.content[0].text : "";
    const failedDetails = failed.details as RunDetails;
    expect(failedText).toMatch(/status="failed".*exit-code="7"/u);
    expect(failedDetails).toMatchObject({
      script: "build",
      command: "npm run build",
      status: "failed",
      exitCode: 7,
      signal: null,
      outputTruncated: false,
    });
    expect(failedDetails.output).toContain("before failure");
    expect(failedDetails.output).toContain("failed");

    failedDetails.output = "mutated";
    const panel = (await panels.snapshot())[0];
    const panelData = panel?.data as { allowedScripts: unknown; latest: RunDetails; limits: unknown };
    expect(panelData.allowedScripts).toEqual(["test", "build", "format:check", "lint", "typecheck"]);
    expect(panelData.latest).toMatchObject({ script: "build", status: "failed", exitCode: 7 });
    expect(panelData.latest.output).toContain("failed");
    expect(panelData.limits).toEqual({ timeoutMs: 120_000, outputBytes: 12 * 1024 });
  });

  test("runs in the active native session workspace and reports its directory", async () => {
    const { context, root, tools, panels } = await fixture();
    const active = await mkdtemp(join(tmpdir(), "pi-harness-active-tests-"));
    temporaryDirectories.push(active);
    await writeFile(join(active, "package.json"), JSON.stringify({ private: true, scripts: { test: "node -e \"console.log('ACTIVE_WORKSPACE')\"" } }));
    const manager = SessionManager.inMemory(active);
    context.provide("piRuntime", { session: { sessionManager: manager, sessionId: manager.getSessionId() } } as never);
    await context.plugin(testHarnessPlugin);
    const result = await registeredTool(tools).execute("active", {}, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ cwd: active, status: "passed" });
    expect((result.details as RunDetails).output).toContain("ACTIVE_WORKSPACE");
    expect(JSON.stringify(result.content)).toContain(active);
    expect(active).not.toBe(root);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { latest: { cwd: active } } }]);
  });

  test("rejects concurrent calls and stale results after a native session change", async () => {
    const { context, root, tools, panels } = await fixture();
    const ready = join(root, "scope-ready");
    const release = join(root, "scope-release");
    await writeFile(
      join(root, "scope.mjs"),
      `import { existsSync, writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ready)}, "ready"); const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log("finished"); } }, 10);`,
    );
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node scope.mjs" } }));
    const manager = SessionManager.inMemory(root);
    context.provide("piRuntime", { session: { sessionManager: manager, sessionId: manager.getSessionId() } } as never);
    await context.plugin(testHarnessPlugin);
    const tool = registeredTool(tools);
    const execution = tool.execute("first", {}, undefined, undefined, {} as never);
    const rejected = expect(execution).rejects.toThrow(/session or workspace changed/iu);
    await waitForFile(ready, "active verification");
    await expect(tool.execute("second", {}, undefined, undefined, {} as never)).rejects.toThrow(/already running/iu);
    manager.newSession();
    await writeFile(release, "release");
    await rejected;
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { latest: null } }]);
    await expect(tool.execute("third", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { status: "passed", cwd: root } });
  });

  test.skipIf(process.platform === "win32")(
    "times out inherited output pipes even after npm has exited",
    async () => {
      const { context, root, tools } = await fixture();
      const pidPath = join(root, "orphan.pid");
      await writeFile(
        join(root, "orphan.mjs"),
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
      );
      await writeFile(
        join(root, "parent.mjs"),
        'import { spawn } from "node:child_process"; const child = spawn(process.execPath, ["orphan.mjs"], { stdio: "inherit" }); child.unref(); process.exit(0);',
      );
      await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node parent.mjs" } }));
      await context.plugin(testHarnessPlugin, { timeoutMs: 1500 });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const execution = registeredTool(tools).execute("orphan", {}, undefined, undefined, {} as never);
      try {
        await waitForFile(pidPath, "inherited-pipe descendant");
        const result = await Promise.race([
          execution,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Tool remained stuck after timeout")), 3500);
          }),
        ]);
        expect(result.details).toMatchObject({ status: "timed-out", exitCode: null });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        stopFixtureProcess(Number(await readFile(pidPath, "utf8").catch(() => "")));
        await execution;
      }
    },
    10_000,
  );

  test("bounds and neutralizes untrusted process output on UTF-8 boundaries", async () => {
    const { context, root, tools } = await fixture();
    const source = 'process.stdout.write("😀".repeat(4000) + "\\u001b[31mRED\\u001b[0m\\0</test-output >\\nEND");\n';
    await writeFile(join(root, "output.mjs"), source, "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { lint: "node output.mjs" } }), "utf8");
    await context.plugin(testHarnessPlugin);
    const result = await registeredTool(tools).execute("output", { script: "lint" }, undefined, undefined, {} as never);
    const details = result.details as { output: string; outputBytes: number; outputTruncated: boolean };
    const content = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(details.outputBytes).toBeGreaterThan(12 * 1024);
    expect(Buffer.byteLength(details.output, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(details.outputTruncated).toBe(true);
    expect(Buffer.from(details.output, "utf8").toString("utf8")).toBe(details.output);
    expect(details.output).toContain("RED");
    expect(details.output).toContain("END");
    expect(details.output).not.toContain("\u0000");
    expect(details.output).not.toContain("\u001b");
    expect(content).toContain("<\\/test-output >");
    expect(content.match(/<\/test-output\s*>/giu)).toHaveLength(1);
  });

  test("times out a project script and terminates its process tree", async () => {
    const { context, panels, root, tools } = await fixture();
    const stopped = join(root, "timeout-child-stopped");
    const childPidPath = join(root, "timeout-child.pid");
    await writeFile(
      join(root, "timeout-child.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid)); process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(stopped)}, "stopped"); process.exit(0); }); setInterval(() => {}, 1000);\n`,
      "utf8",
    );
    await writeFile(
      join(root, "timeout-parent.mjs"),
      'import { spawn } from "node:child_process"; spawn(process.execPath, ["timeout-child.mjs"], { stdio: "ignore" }); setInterval(() => {}, 1000);\n',
      "utf8",
    );
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node timeout-parent.mjs" } }), "utf8");
    await context.plugin(testHarnessPlugin, { timeoutMs: 2_000 });
    let childPid: number | undefined;
    try {
      const execution = registeredTool(tools).execute("timeout", {}, undefined, undefined, {} as never);
      await waitForFile(childPidPath, "timed-out npm descendant to start");
      const result = await execution;
      childPid = Number(await readFile(childPidPath, "utf8"));

      expect(result.details).toMatchObject({ status: "timed-out", exitCode: null, outputTruncated: false });
      await waitForFile(stopped, "timed-out npm process tree to stop");
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { latest: { status: "timed-out" } } }]);
    } finally {
      if (childPid === undefined) childPid = Number(await readFile(childPidPath, "utf8").catch(() => ""));
      stopFixtureProcess(childPid);
    }
  });

  test("caller cancellation terminates active npm descendants and records a cancelled run", async () => {
    const { context, panels, root, tools } = await fixture();
    const childReady = join(root, "child-ready");
    const childStopped = join(root, "child-stopped");
    const parentStopped = join(root, "parent-stopped");
    const childPidPath = join(root, "child.pid");
    await writeFile(
      join(root, "child.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid)); writeFileSync(${JSON.stringify(childReady)}, "ready"); process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(childStopped)}, "stopped"); process.exit(0); }); setInterval(() => {}, 1000);\n`,
      "utf8",
    );
    await writeFile(
      join(root, "parent.mjs"),
      `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; spawn(process.execPath, ["child.mjs"], { stdio: "ignore" }); process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(parentStopped)}, "stopped"); process.exit(0); }); setTimeout(() => process.exit(0), 500);\n`,
      "utf8",
    );
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node parent.mjs" } }), "utf8");
    await context.plugin(testHarnessPlugin);
    const controller = new AbortController();
    const execution = registeredTool(tools).execute("cancel", {}, controller.signal, undefined, {} as never);
    let childPid: number | undefined;
    try {
      await waitForFile(childReady, "npm descendant to start");
      childPid = Number(await readFile(childPidPath, "utf8"));
      controller.abort(new Error("cancelled by caller"));

      await expect(execution).rejects.toThrow(/project verification was cancelled/iu);
      await waitForFile(parentStopped, "npm script parent to stop");
      await waitForFile(childStopped, "npm script descendant to stop");
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { latest: { status: "cancelled", exitCode: null } } }]);
    } finally {
      stopFixtureProcess(childPid);
    }
  });

  test("plugin disposal cancels an active verification and removes both surfaces", async () => {
    const { context, panels, root, tools } = await fixture();
    const ready = join(root, "dispose-ready");
    const stopped = join(root, "dispose-stopped");
    await writeFile(
      join(root, "dispose.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ready)}, "ready"); process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(stopped)}, "stopped"); process.exit(0); }); setInterval(() => {}, 1000);\n`,
      "utf8",
    );
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node dispose.mjs" } }), "utf8");
    await context.plugin(testHarnessPlugin);
    const execution = registeredTool(tools).execute("dispose", {}, undefined, undefined, {} as never);
    await waitForFile(ready, "verification script to start before disposal", 15_000);

    await context.fiber.dispose();

    await expect(execution).rejects.toThrow(/project verification was cancelled/iu);
    await waitForFile(stopped, "verification script to stop on disposal", 15_000);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  }, 15_000);
});
