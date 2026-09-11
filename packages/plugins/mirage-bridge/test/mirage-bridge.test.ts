import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import mirageBridgePlugin from "../src/index.js";

const temporaryDirectories: string[] = [];

async function waitForFile(path: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() - started > 5_000) throw new Error(`Timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

// A Mirage stub whose execute subcommand signals readiness, then idles until it is terminated or gives up after five seconds.
async function longRunningFixture(timeoutMs = 30_000) {
  const directory = await mkdtemp(join(tmpdir(), "pi-harness-mirage-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "mirage-stub.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import {writeFileSync } from "node:fs";
if (process.argv[2] === "--version") {
  console.log("mirage 0.9.0");
} else {
  process.on("SIGTERM", () => {
    writeFileSync("terminated", "");
    process.exit(0);
  });
  writeFileSync("ready", "");
  setInterval(() => {}, 100);
  setTimeout(() => process.exit(2), 5_000);
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piHarnessLaunch", { cwd: directory, agentDir: directory } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(mirageBridgePlugin, { executable, workspaceId: "review-sandbox", timeoutMs });
  const execute = tools.snapshot().customTools.find((tool) => tool.name === "mirage_execute");
  if (execute === undefined) throw new Error("mirage_execute was not registered");
  return { directory, context, panels, execute, tools };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("mirage bridge", () => {
  test.skipIf(process.platform === "win32").each([
    ["cancel", false], ["timeout", false], ["cancel", true], ["timeout", true],
  ] as const)("%s reaps SIGTERM-ignoring local CLI processes (tree=%s)", async (mode, tree) => {
    const { context, directory, execute, panels } = await longRunningFixture(mode === "timeout" ? 2000 : 30000);
    const caller = new AbortController();
    let pid: number | undefined;
    try {
      const worker = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("ready",String(process.pid));setTimeout(()=>process.exit(9),8000)';
      const script = tree ? `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(worker)}],{stdio:"ignore"})` : worker;
      await writeFile(join(directory, "mirage-stub.mjs"), `#!/usr/bin/env node\nimport {createRequire} from "node:module";const require=createRequire(import.meta.url);${script}\n`);
      let settled = false;
      const pending = execute.execute("reap", { command: "inert local fixture" }, caller.signal, undefined, {} as never);
      const observed = pending.then((result) => { settled = true; return result; }, (error: unknown) => { settled = true; return error; });
      await waitForFile(join(directory, "ready"));
      pid = Number(await readFile(join(directory, "ready"), "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      if (mode === "cancel") caller.abort(new Error("cancelled by fixture"));
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 4500, interval: 20 });
      expect(settled).toBe(true);
      const result: unknown = await observed;
      if (mode === "cancel") {
        expect(result).toBeInstanceOf(Error);
        expect(((await panels.snapshot())[0]?.data as { lastRun: unknown }).lastRun).toBeNull();
      } else {
        expect(result).toMatchObject({ details: { exitCode: null } });
      }
    } finally {
      caller.abort();
      if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Owned fixture already exited. */ }
      }
      await context.fiber.dispose();
    }
  }, 12000);

  test.each([131072, 131073])("handles the exact combined-output boundary of %i bytes", async (size) => {
    const { context, directory, execute } = await longRunningFixture();
    await writeFile(
      join(directory, "mirage-stub.mjs"),
      `#!/usr/bin/env node\nprocess.stdout.write("x".repeat(65536));process.stderr.write("y".repeat(${size - 65536}));\n`,
    );
    try {
      const result = await execute.execute("boundary", { command: "inert fixture" }, undefined, undefined, {} as never);
      const output = (result.details as { output: string }).output;
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(131072);
      expect(output.includes("output truncated")).toBe(size > 131072);
      if (size === 131072) expect(output).toBe("x".repeat(65536) + "y".repeat(65536));
    } finally {
      await context.fiber.dispose();
    }
  });

  test("bounds combined Unicode output in bytes and makes truncation explicit", async () => {
    const { context, directory, execute } = await longRunningFixture();
    await writeFile(
      join(directory, "mirage-stub.mjs"),
      '#!/usr/bin/env node\nprocess.stdout.write("中文😀".repeat(8000));process.stderr.write("中文😀".repeat(8000)+"FINAL_SENTINEL");\n',
    );
    try {
      const result = await execute.execute("unicode", { command: "inert fixture" }, undefined, undefined, {} as never);
      const output = (result.details as { output: string }).output;
      expect(result.details).toMatchObject({ exitCode: 0 });
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(128 * 1024);
      expect(output).toContain("output truncated");
      expect(output).toContain("FINAL_SENTINEL");
      expect(output).not.toContain("\uFFFD");
      const content = result.content[0];
      expect(content?.type).toBe("text");
      if (content?.type === "text") expect(content.text).toContain("output truncated");
    } finally {
      await context.fiber.dispose();
    }
  });

  test("keeps buffer-limit termination distinct from timeout and exposes its diagnostic", async () => {
    const { context, directory, execute, panels } = await longRunningFixture();
    await writeFile(join(directory, "mirage-stub.mjs"), '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(256 * 1024));\n');
    try {
      const result = await execute.execute("buffer", { command: "inert fixture" }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ exitCode: null });
      expect((result.details as { output: string }).output).toContain("output is incomplete");
      expect((result.details as { output: string }).output).not.toContain("timed out");
      expect(((await panels.snapshot())[0]?.data as { lastError: string }).lastError).toContain("output exceeded");
    } finally {
      await context.fiber.dispose();
    }
  });

  test("reports timeout even when the terminated child exits zero without stderr", async () => {
    const { context, execute, panels } = await longRunningFixture(1000);
    try {
      const result = await execute.execute("timeout", { command: "inert fixture" }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ exitCode: null });
      expect((result.details as { output: string }).output).toContain("timed out after 1000 ms");
      const content = result.content[0];
      expect(content?.type).toBe("text");
      if (content?.type === "text") expect(content.text).toContain("timed out after 1000 ms");
      const lastRun = ((await panels.snapshot())[0]?.data as { lastRun: { exitCode: number | null; output: string } }).lastRun;
      expect(lastRun.exitCode).toBeNull();
      expect(lastRun.output).toContain("timed out");
    } finally {
      await context.fiber.dispose();
    }
  });

  test("closes stdin for the CLI non-interactive execute contract", async () => {
    const { context, directory, execute } = await longRunningFixture(1000);
    await writeFile(
      join(directory, "mirage-stub.mjs"),
      '#!/usr/bin/env node\nimport {readFileSync} from "node:fs";\nreadFileSync(0);\nconsole.log("stdin ended");\n',
    );
    try {
      const result = await execute.execute("stdin", { command: "echo ready" }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ exitCode: 0, output: "stdin ended\n" });
      (result.details as { output: string }).output = "changed";
      const doctor = context.piTools.snapshot().customTools.find((tool) => tool.name === "mirage_doctor")!;
      const inspected = await doctor.execute("inspect", {}, undefined, undefined, {} as never);
      expect(inspected.details).toMatchObject({ lastRun: { output: "stdin ended\n" } });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("uses a finite timeout for non-finite configuration", async () => {
    const { context, tools, panels } = await longRunningFixture(Number.NaN);
    try {
      const doctor = tools.snapshot().customTools.find((tool) => tool.name === "mirage_doctor")!;
      await expect(doctor.execute("doctor", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { available: true } });
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { timeoutMs: 60_000 } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("keeps doctor results separate from the persisted panel state", async () => {
    const { context, tools, panels } = await longRunningFixture();
    try {
      const doctor = tools.snapshot().customTools.find((tool) => tool.name === "mirage_doctor")!;
      const result = await doctor.execute("doctor", {}, undefined, undefined, {} as never);
      (result.details as { available: boolean; workspaceId: string }).available = false;
      (result.details as { workspaceId: string }).workspaceId = "changed";
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { available: true, workspaceId: "review-sandbox" } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("checks the official CLI and executes inside the configured virtual workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-mirage-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "mirage-stub.mjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
if (process.argv[2] === "--version") console.log("mirage 0.9.0");
else console.log(JSON.stringify(process.argv.slice(2)));
`,
      "utf8",
    );
    await chmod(executable, 0o755);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piHarnessLaunch", { cwd: directory, agentDir: directory } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(mirageBridgePlugin, { executable, workspaceId: "review-sandbox" });
      const doctor = tools.snapshot().customTools.find((tool) => tool.name === "mirage_doctor");
      const execute = tools.snapshot().customTools.find((tool) => tool.name === "mirage_execute");
      expect(doctor).toBeDefined();
      expect(execute).toBeDefined();
      expect(doctor!.executionMode).toBe("sequential");
      expect(doctor!.parameters).toMatchObject({ additionalProperties: false });
      expect(execute!.executionMode).toBe("sequential");
      expect(execute!.parameters).toMatchObject({ additionalProperties: false });
      await expect(doctor!.execute("doctor-1", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { available: true, version: "mirage 0.9.0", workspaceId: "review-sandbox" },
      });
      await expect(execute!.execute("run-1", { command: "grep -r TODO /workspace" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { exitCode: 0, workspaceId: "review-sandbox", command: "grep -r TODO /workspace" },
      });
      await expect(panels.snapshot()).resolves.toMatchObject([
        { id: "mirage-bridge-panel", data: { available: true, workspaceId: "review-sandbox", lastRun: { exitCode: 0 } } },
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });
  test("kills the Mirage child and rejects when the tool call is cancelled", async () => {
    const { directory, context, panels, execute } = await longRunningFixture();
    try {
      const caller = new AbortController();
      const execution = execute.execute("run-cancel", { command: "sleep forever" }, caller.signal, undefined, {} as never);
      await waitForFile(join(directory, "ready"));

      caller.abort(new Error("cancelled by test"));

      await expect(execution).rejects.toThrow(/cancelled by test/iu);
      await waitForFile(join(directory, "terminated"));
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "mirage-bridge-panel", data: { lastRun: null } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("kills the Mirage child when the plugin is disposed", async () => {
    const { directory, context, execute } = await longRunningFixture();
    try {
      const execution = execute.execute("run-dispose", { command: "sleep forever" }, undefined, undefined, {} as never);
      await waitForFile(join(directory, "ready"));

      await context.fiber.dispose();

      await expect(execution).rejects.toThrow(/disposed/iu);
      await waitForFile(join(directory, "terminated"));
    } finally {
      await context.fiber.dispose();
    }
  });
});

test("uses the active native cwd for both tools and resets session state without changing the virtual workspace", async () => {
  const fixture = await longRunningFixture();
  await mkdir(join(fixture.directory, "active"));
  const active = await realpath(join(fixture.directory, "active"));
  await writeFile(join(fixture.directory, "mirage-stub.mjs"), "#!/usr/bin/env node\nconsole.log(process.cwd());\n");
  let session = { sessionId: "first", sessionManager: { getCwd: () => fixture.directory } };
  fixture.context.provide("piRuntime", {
    get session() {
      return session;
    },
  } as never);
  const doctor = fixture.tools.snapshot().customTools.find((tool) => tool.name === "mirage_doctor")!;
  try {
    await fixture.execute.execute("first", { command: "pwd" }, undefined, undefined, {} as never);
    session = { sessionId: "second", sessionManager: { getCwd: () => active } };
    await expect(fixture.panels.snapshot()).resolves.toMatchObject([
      { data: { available: null, version: null, lastError: null, lastRun: null, workspaceId: "review-sandbox" } },
    ]);
    await expect(doctor.execute("doctor", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { available: true, version: active } });
    await expect(fixture.execute.execute("active", { command: "pwd" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { output: active + "\n", workspaceId: "review-sandbox" },
    });
    session.sessionId = "third";
    await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { available: null, lastRun: null } }]);
  } finally {
    await fixture.context.fiber.dispose();
  }
});

test.each(["mirage_doctor", "mirage_execute"])("discards pending %s success and failure after a native session change", async (toolName) => {
  for (const exitCode of [0, 7]) {
    const fixture = await longRunningFixture();
    await writeFile(
      join(fixture.directory, "mirage-stub.mjs"),
      `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
writeFileSync("ready", "");
const timer = setInterval(() => { if (existsSync("release")) { clearInterval(timer); console.log("old result"); process.exit(${exitCode}); } }, 10);
setTimeout(() => process.exit(9), 5000).unref();
`,
    );
    const session = { sessionId: "first", sessionManager: { getCwd: () => fixture.directory } };
    fixture.context.provide("piRuntime", { session } as never);
    const tool = fixture.tools.snapshot().customTools.find((entry) => entry.name === toolName)!;
    try {
      const pending = tool.execute("pending", { command: "pwd" }, undefined, undefined, {} as never);
      const assertion = expect(pending).rejects.toThrow(/workspace changed/iu);
      await waitForFile(join(fixture.directory, "ready"));
      session.sessionId = "second";
      await writeFile(join(fixture.directory, "release"), "");
      await assertion;
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { available: null, lastError: null, lastRun: null } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  }
});

test("rejects a scope change during parameter access before spawning and guards retained tools after disposal", async () => {
  const fixture = await longRunningFixture();
  await writeFile(
    join(fixture.directory, "mirage-stub.mjs"),
    '#!/usr/bin/env node\nimport {writeFileSync} from "node:fs"; writeFileSync("ready", ""); console.log("launched");\n',
  );
  const retained = fixture.tools.snapshot().customTools;
  const session = { sessionId: "first", sessionManager: { getCwd: () => fixture.directory } };
  fixture.context.provide("piRuntime", { session } as never);
  try {
    await expect(
      fixture.execute.execute(
        "getter",
        {
          get command() {
            session.sessionId = "second";
            return "pwd";
          },
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/workspace changed/iu);
    await expect(access(join(fixture.directory, "ready"))).rejects.toMatchObject({ code: "ENOENT" });
    await fixture.context.fiber.dispose();
    expect(fixture.tools.snapshot().customTools).toHaveLength(0);
    for (const tool of retained) await expect(tool.execute("disposed", { command: "pwd" }, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
  } finally {
    await fixture.context.fiber.dispose();
  }
});
