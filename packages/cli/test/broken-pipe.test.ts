import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

describe("broken output pipe", () => {
  test("finishes the run and disposes the tree when the reader closes the pipe mid-stream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-epipe-"));
    const markerPath = join(directory, "marker.txt");
    const pluginPath = join(directory, "application.mjs");
    const configPath = join(directory, "cordis.yml");
    await writeFile(pluginPath, `import { appendFileSync } from "node:fs"; export default { inject: ["piHarnessStdio"], apply(ctx, config) { ctx.effect(() => () => appendFileSync(config.markerPath, "disposed\\n")); ctx.provide("piApplication", { async run() { for (let i = 0; i < 200; i += 1) { ctx.piHarnessStdio.writeOutput("line " + i + " " + "-".repeat(200) + "\\n"); await new Promise((resolve) => setTimeout(resolve, 5)); } appendFileSync(config.markerPath, "completed\\n"); return 0; } }); } };`, "utf8");
    await writeFile(configPath, JSON.stringify([{ name: pathToFileURL(pluginPath).href, config: { markerPath } }]), "utf8");

    const producer = spawn(process.execPath, [BIN, "--config", configPath, "--prompt", "hi"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_AGENT_DIR: directory } });
    let stderr = "";
    producer.stderr.setEncoding("utf8");
    producer.stderr.on("data", (chunk: string) => { stderr += chunk; });
    producer.stdout.once("data", () => { producer.stdout.destroy(); });

    const code = await new Promise<number | null>((resolve) => producer.once("exit", resolve));

    expect(stderr).not.toContain("EPIPE");
    expect(code).toBe(0);
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(markerPath, "utf8")).resolves.toBe("completed\ndisposed\n");
  }, 30_000);
});
