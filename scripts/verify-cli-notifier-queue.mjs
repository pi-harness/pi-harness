import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import plugin from "../packages/plugins/cli-notifier/dist/index.js";

assert.ok(process.platform === "darwin" || process.platform === "linux");
const root = await mkdtemp(join(tmpdir(), "pih-notifier-queue-"));
const ready = join(root, "ready"), release = join(root, "release");
const executable = join(root, process.platform === "darwin" ? "osascript" : "notify-send");
const originalPath = process.env.PATH;
const context = new Context(), tools = new PiToolRegistry(), panels = new PiPluginUiRegistry();
const firstCaller = new AbortController(), queuedCaller = new AbortController();
let first;
try {
  await writeFile(executable, `#!${process.execPath}\nconst fs=require("node:fs");fs.appendFileSync(${JSON.stringify(ready)},"started\\n");setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},20);setTimeout(()=>process.exit(9),8000);\n`);
  await chmod(executable, 0o700);
  process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(plugin, { enabled: true, timeoutMs: 6000 });
  const tool = tools.snapshot().customTools.find((item) => item.name === "cli_notify");
  assert.ok(tool);
  first = tool.execute("first", { message: "running notification" }, firstCaller.signal);
  void first.catch(() => undefined);
  const deadline = Date.now() + 4000;
  for (;;) {
    try { await access(ready); break; } catch {
      assert.ok(Date.now() < deadline, "First notification never started");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const queued = tool.execute("queued", { message: "cancelled queued notification" }, queuedCaller.signal);
  let timer;
  const started = performance.now();
  const rejected = assert.rejects(queued, /cancelled while queued/);
  queuedCaller.abort(new Error("cancelled while queued"));
  try {
    await Promise.race([rejected, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Queued cancellation waited for the running command")), 1000);
    })]);
  } finally { clearTimeout(timer); }
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(await readFile(ready, "utf8"), "started\n");
  // Queue later work before releasing the first command: cancellation must not
  // let it bypass the original queue chain.
  const after = tool.execute("after", { message: "queue recovered" });
  await writeFile(release, "release");
  assert.deepEqual(/** @type {{delivered: boolean}} */ ((await first).details).delivered, true);
  assert.deepEqual(/** @type {{delivered: boolean}} */ ((await after).details).delivered, true);
  assert.equal(await readFile(ready, "utf8"), "started\nstarted\n");
  const [panel] = await panels.snapshot();
  const data = /** @type {{notifications: Array<{message: string}>}} */ (panel.data);
  assert.deepEqual(data.notifications.map((item) => item.message), ["queue recovered", "running notification"]);
  console.log("compiled_queued_cancel_no_execution_no_receipt_recovery PASS", { elapsedMs });
} finally {
  firstCaller.abort();
  queuedCaller.abort();
  await first?.catch(() => undefined);
  await context.fiber.dispose();
  process.env.PATH = originalPath;
  await rm(root, { recursive: true, force: true });
}
