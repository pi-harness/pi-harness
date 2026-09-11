import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers/promises";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { PiToolRegistry, PiPluginUiRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import plugin from "../packages/plugins/reviewer-bot/dist/index.js";

assert.notEqual(process.platform, "win32");
const root = await mkdtemp(join(tmpdir(), "pih-reviewer-parallel-"));
const ready = join(root, "ready"), executable = join(root, "git");
const originalPath = process.env.PATH;
const context = new Context(), tools = new PiToolRegistry(), panels = new PiPluginUiRegistry();
let pid;
try {
  await writeFile(executable, `#!${process.execPath}\nconst fs=require("node:fs");if(process.argv.includes("--name-only")){setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){process.stderr.write("synthetic listing failure");process.exit(7)}},20)}else{process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid))}setTimeout(()=>process.exit(9),8000);\n`);
  await chmod(executable, 0o700);
  process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools); context.provide("piPluginUi", panels);
  await context.plugin(plugin, { timeoutMs: 15000 });
  const tool = tools.snapshot().customTools.find((item) => item.name === "review_changes");
  assert.ok(tool);
  await assert.rejects(tool.execute("parallel", {}), /synthetic listing failure/);
  pid = Number(await readFile(ready, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const started = Date.now();
  for (;;) {
    try { process.kill(pid, 0); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") break;
      throw error;
    }
    assert.ok(Date.now() - started < 3000, "Sibling Git process survived collection failure");
    await setTimeout(20);
  }
  const [panel] = await panels.snapshot();
  const data = /** @type {{latest: unknown, status: string, lastError: string}} */ (panel.data);
  assert.equal(data.latest, null); assert.equal(data.status, "failed");
  assert.match(data.lastError, /synthetic listing failure/);
  console.log("compiled_parallel_failure_reaps_sibling_and_preserves_error PASS", { elapsedMs: Date.now() - started });
} finally {
  if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* Owned fixture exited. */ } }
  await context.fiber.dispose();
  process.env.PATH = originalPath;
  await rm(root, { recursive: true, force: true });
}
