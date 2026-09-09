import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import autoModePlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const execFileAsync = promisify(execFile);
// Auto mode asks git for the effective configuration of the working directory before it runs an unconfirmed git command, so without this the developer's own ~/.gitconfig would decide whether these commands are risky. Empty global and system files make "a repository with no program-executing configuration" mean exactly that on every machine. The scope tests below override GIT_CONFIG_GLOBAL for their own duration, because the point of those tests is what a non-empty global configuration does.
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_SYSTEM = devNull;
const commitIdentity = ["-c", "user.email=pi@example.invalid", "-c", "user.name=pi"];
// Every hook name githooks(5) documents for git 2.50. core.hooksPath is only risky for the subcommands that can run one of these, so the list has to be the whole documented set rather than the one hook that was observed to run.
const documentedGitHooks = [
  "applypatch-msg",
  "commit-msg",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "p4-prepare-changelist",
  "post-applypatch",
  "post-checkout",
  "post-commit",
  "post-index-change",
  "post-merge",
  "post-receive",
  "post-rewrite",
  "post-update",
  "pre-applypatch",
  "pre-auto-gc",
  "pre-commit",
  "pre-merge-commit",
  "pre-push",
  "pre-rebase",
  "pre-receive",
  "prepare-commit-msg",
  "proc-receive",
  "push-to-checkout",
  "reference-transaction",
  "sendemail-validate",
  "update",
];

async function seedRepository(root: string, attributes: string, configKey: string, payload: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet", "."], { cwd: root });
  await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
  await writeFile(join(root, ".gitattributes"), attributes, "utf8");
  await writeFile(join(root, "payload.sh"), payload, "utf8");
  await chmod(join(root, "payload.sh"), 0o700);
  await execFileAsync("git", ["config", configKey, "./payload.sh"], { cwd: root });
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", [...commitIdentity, "commit", "--quiet", "-m", "seed"], { cwd: root });
  await rm(join(root, "pwned.txt"), { force: true });
}

// A commit object carrying a gpgsig header makes every %G placeholder in --format or --pretty verify a signature, which spawns the configured gpg program. Nothing in the argv names it, so only the configuration probe can see this coming.
async function seedSignedRepository(root: string, configKey: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet", "."], { cwd: root });
  await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
  await writeFile(join(root, "payload.sh"), "#!/bin/sh\nprintf owned > pwned.txt\nexit 0\n", "utf8");
  await chmod(join(root, "payload.sh"), 0o700);
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", [...commitIdentity, "commit", "--quiet", "-m", "seed"], { cwd: root });
  const original = (await execFileAsync("git", ["cat-file", "commit", "HEAD"], { cwd: root })).stdout;
  const [headers, ...body] = original.split("\n\n");
  const signature = "gpgsig -----BEGIN PGP SIGNATURE-----\n \n iHUEABYKAB0WIQTnotarealsignature\n -----END PGP SIGNATURE-----";
  await writeFile(join(root, "signed-commit"), `${headers}\n${signature}\n\n${body.join("\n\n")}`, "utf8");
  const rewritten = (await execFileAsync("git", ["hash-object", "-t", "commit", "-w", "signed-commit"], { cwd: root })).stdout.trim();
  await rm(join(root, "signed-commit"), { force: true });
  await execFileAsync("git", ["update-ref", "HEAD", rewritten], { cwd: root });
  await execFileAsync("git", ["config", configKey, "./payload.sh"], { cwd: root });
  await rm(join(root, "pwned.txt"), { force: true });
}

// The hostile configuration lives only in the submodule's own configuration file, which the superproject's probe never reads. The payload path is absolute because git runs the filter with the submodule as its working directory.
async function seedSubmoduleRepository(root: string): Promise<string> {
  const origin = join(root, "origin");
  await execFileAsync("git", ["init", "--quiet", origin]);
  await writeFile(join(origin, "a.txt"), "inner\n", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: origin });
  await execFileAsync("git", [...commitIdentity, "commit", "--quiet", "-m", "inner"], { cwd: origin });
  const superproject = join(root, "super");
  await execFileAsync("git", ["init", "--quiet", superproject]);
  // A sibling of the submodule, so that a test can put the agent's working directory somewhere the submodule is not underneath.
  await mkdir(join(superproject, "src"), { recursive: true });
  await writeFile(join(superproject, "src", "keep.txt"), "kept\n", "utf8");
  await execFileAsync("git", ["-c", "protocol.file.allow=always", "submodule", "--quiet", "add", origin, "sub"], { cwd: superproject });
  await execFileAsync("git", ["add", "-A"], { cwd: superproject });
  await execFileAsync("git", [...commitIdentity, "commit", "--quiet", "-m", "super"], { cwd: superproject });
  const payload = join(superproject, "payload.sh");
  await writeFile(payload, `#!/bin/sh\nprintf owned > ${join(superproject, "pwned.txt")}\ncat\n`, "utf8");
  await chmod(payload, 0o700);
  await execFileAsync("git", ["config", "filter.evil.clean", payload], { cwd: join(superproject, "sub") });
  await writeFile(join(superproject, "sub", ".gitattributes"), "*.txt filter=evil\n", "utf8");
  // Rewriting identical content leaves the file stat-dirty, so git has to run the clean filter to decide whether it changed.
  await writeFile(join(superproject, "sub", "a.txt"), "inner\n", "utf8");
  await rm(join(superproject, "pwned.txt"), { force: true });
  return superproject;
}

async function seedOrdinaryRepository(root: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet", "."], { cwd: root });
  await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", [...commitIdentity, "commit", "--quiet", "-m", "seed"], { cwd: root });
}

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

describe("auto-mode", () => {
  test("requires confirmation for file magic compilation while allowing ordinary inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    try {
      await writeFile(join(root, "sample.magic"), "0 string SAMPLE sample format\n");
      await writeFile(join(root, "sample.txt"), "SAMPLE payload\n");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      const tools = new PiToolRegistry();
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe" });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec")!;
      for (const option of ["-C", "-bC", "--compile", "--comp", "-z", "--uncompress"]) {
        await expect(tool.execute("compile", { command: ["file", option, "-m", "sample.magic"] }, undefined, undefined, {} as never)).rejects.toThrow(
          /confirm=true/iu,
        );
        await expect(access(join(root, "sample.magic.mgc"))).rejects.toThrow();
      }
      await expect(
        tool.execute("inspect", { command: ["file", "--brief", "--mime-type", "--", "sample.txt"] }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({ details: { exitCode: 0, confirmed: false } });
      await expect(
        tool.execute("confirmed", { command: ["file", "-C", "-m", "sample.magic"], confirm: true }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({ details: { exitCode: 0, confirmed: true } });
      await expect(access(join(root, "sample.magic.mgc"))).resolves.toBeUndefined();
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for unknown workspace executables", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      const executable = join(root, "write-marker");
      const marker = join(root, "marker.txt");
      await writeFile(executable, "#!/bin/sh\nprintf changed > marker.txt\n", "utf8");
      await chmod(executable, 0o700);
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      expect(tool.executionMode).toBe("sequential");
      expect(tool.parameters).toMatchObject({ additionalProperties: false });

      await expect(tool.execute("execute", { command: [executable] }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("declares command argument bounds in the tool schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");

      expect(tool?.parameters).toMatchObject({
        properties: { command: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 4096 } } },
      });
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed command arrays with stable validation errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      await expect(tool.execute("execute", { command: null }, undefined, undefined, {} as never)).rejects.toThrow(/array/iu);
      await expect(tool.execute("execute", { command: ["printf", 1] }, undefined, undefined, {} as never)).rejects.toThrow(/string/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to the default timeout for a non-finite configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", new PiToolRegistry());
      context.provide("piPluginUi", panels);
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: Number.NaN });

      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "auto-mode-panel", data: { timeoutMs: 30_000 } }]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not expose mutable execution state through tool results", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const result = await tool.execute("execute", { command: ["printf", "ok"] }, undefined, undefined, {} as never);

      const details = result.details as { command: string[]; stdout: string };
      details.command[0] = "mutated";
      details.stdout = "mutated";

      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "auto-mode-panel", data: { last: { command: ["printf", "ok"], stdout: "ok" } } }]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not expose mutable execution state through panel snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      await tool.execute("execute", { command: ["printf", "ok"] }, undefined, undefined, {} as never);
      const firstPanel = (await panels.snapshot())[0];
      if (firstPanel === undefined) throw new Error("auto-mode-panel was not registered");

      (firstPanel.data as { last: { command: string[] } }).last.command[0] = "mutated";

      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "auto-mode-panel", data: { last: { command: ["printf", "ok"], stdout: "ok" } } }]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records the argv snapshot that was actually executed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 10_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const ready = join(root, "ready");
      const release = join(root, "release");
      const script =
        "const fs=require('node:fs');fs.writeFileSync('ready','');const expiry=setTimeout(()=>process.exit(2),5000);const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);clearTimeout(expiry);process.stdout.write('done')}},10)";
      const params = { command: [process.execPath, "-e", script], confirm: true };

      const execution = tool.execute("execute", params, undefined, undefined, {} as never);
      await waitForFile(ready);
      params.command[0] = "mutated-after-start";
      await writeFile(release, "release", "utf8");

      await expect(execution).resolves.toMatchObject({ details: { command: [process.execPath, "-e", script], stdout: "done" } });
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("aborts an executing command when the tool call is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const ready = join(root, "ready");
      const terminated = join(root, "terminated");
      const script =
        "const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync('terminated','');process.exit(0)});fs.writeFileSync('ready','');setInterval(()=>{},100);setTimeout(()=>process.exit(2),1000)";
      const caller = new AbortController();
      const execution = tool.execute("execute", { command: [process.execPath, "-e", script], confirm: true }, caller.signal, undefined, {} as never);
      await waitForFile(ready);

      caller.abort(new Error("cancelled by test"));

      await expect(execution).rejects.toThrow(/cancelled by test/iu);
      await waitForFile(terminated);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("aborts executing commands when the plugin is disposed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const ready = join(root, "ready");
      const terminated = join(root, "terminated");
      const script =
        "const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync('terminated','');process.exit(0)});fs.writeFileSync('ready','');setInterval(()=>{},100);setTimeout(()=>process.exit(2),1000)";
      const execution = tool.execute("execute", { command: [process.execPath, "-e", script], confirm: true }, undefined, undefined, {} as never);
      await waitForFile(ready);

      await context.fiber.dispose();

      await expect(execution).rejects.toThrow(/disposed/iu);
      await waitForFile(terminated);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for every command in confirm mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(autoModePlugin, { mode: "confirm", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      await expect(tool.execute("blocked", { command: ["printf", "ok"] }, undefined, undefined, {} as never)).rejects.toThrow(/configured for confirmation/iu);
      await expect(tool.execute("allowed", { command: ["printf", "ok"], confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { confirmed: true, exitCode: 0, stdout: "ok" },
      });
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "auto-mode-panel", data: { mode: "confirm", blocked: 1 } }]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enforces argument count and UTF-8 byte limits during execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      await expect(tool.execute("too-many", { command: Array.from({ length: 33 }, () => "x") }, undefined, undefined, {} as never)).rejects.toThrow(
        /between 1 and 32 arguments/iu,
      );
      await expect(tool.execute("too-large", { command: ["printf", "界".repeat(1_366)] }, undefined, undefined, {} as never)).rejects.toThrow(
        /invalid argument/iu,
      );
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records the exit details of an allowed command failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      await expect(
        tool.execute(
          "failure",
          { command: [process.execPath, "-e", "process.stderr.write('failed');process.exit(7)"], confirm: true },
          undefined,
          undefined,
          {} as never,
        ),
      ).resolves.toMatchObject({ details: { allowed: true, confirmed: true, exitCode: 7, stdout: "", stderr: "failed" } });
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not start a command when the tool call is already cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const marker = join(root, "marker.txt");
      const caller = new AbortController();
      caller.abort(new Error("cancelled before execution"));

      await expect(
        tool.execute(
          "cancelled",
          { command: [process.execPath, "-e", "require('node:fs').writeFileSync('marker.txt','changed')"], confirm: true },
          caller.signal,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/cancelled before execution/iu);
      await expect(access(marker)).rejects.toThrow();
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "auto-mode-panel", data: { blocked: 0, last: null } }]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unregisters its tool and panel on disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(autoModePlugin);
      expect(tools.snapshot().customTools.map((tool) => tool.name)).toEqual(["auto_mode_exec"]);
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "auto-mode-panel", data: { mode: "safe", blocked: 0, last: null } }]);

      await context.fiber.dispose();

      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toEqual([]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not classify ordinary arguments as risky subcommands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      await expect(tool.execute("execute", { command: ["printf", "clean"] }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { allowed: true, exitCode: 0, stdout: "clean" },
      });
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects Windows shell wrapper paths before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      await expect(
        tool.execute("execute", { command: ["C:\\Windows\\System32\\cmd.exe", "/c", "echo unsafe"], confirm: true }, undefined, undefined, {} as never),
      ).rejects.toThrow(/shell wrapper/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects shell wrappers launched indirectly through env", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      await expect(
        tool.execute("execute", { command: ["env", "sh", "-c", "printf unsafe"], confirm: true }, undefined, undefined, {} as never),
      ).rejects.toThrow(/shell wrapper/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects process launchers that can hide shell wrappers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      for (const launcher of ["sudo", "su", "nice", "nohup", "time", "timeout", "stdbuf", "xargs"]) {
        await expect(
          tool.execute("execute", { command: [`C:\\tools\\${launcher}.exe`, "sh", "-c", "echo unsafe"], confirm: true }, undefined, undefined, {} as never),
        ).rejects.toThrow(/shell wrapper/iu);
      }
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation before executing code through Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const marker = join(root, "marker.txt");

      await expect(
        tool.execute(
          "execute",
          { command: [process.execPath, "-e", "require('node:fs').writeFileSync('marker.txt', 'changed')"] },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/confirm=true/iu);
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for common versioned code interpreters", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const interpreters = ["nodejs.exe", "python3.12.exe", "ruby3.3.exe", "perl.exe", "php8.3.exe", "lua5.4.exe", "deno.exe", "bun.exe"];

      for (const interpreter of interpreters) {
        await expect(tool.execute("execute", { command: [`C:\\tools\\${interpreter}`, "--version"] }, undefined, undefined, {} as never)).rejects.toThrow(
          /confirm=true/iu,
        );
      }
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for direct network and remote commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      for (const command of ["curl.exe", "wget.exe", "ssh.exe", "scp.exe"]) {
        await expect(tool.execute("execute", { command: [`C:\\tools\\${command}`, "example.invalid"] }, undefined, undefined, {} as never)).rejects.toThrow(
          /confirm=true/iu,
        );
      }
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("normalizes Windows script extensions before risk classification", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      for (const command of ["rm.cmd", "del.bat", "curl.com"]) {
        await expect(tool.execute("execute", { command: [`C:\\tools\\${command}`, "target"] }, undefined, undefined, {} as never)).rejects.toThrow(
          /confirm=true/iu,
        );
      }
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for Git commands that can mutate repository state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const mutating = [
        "add",
        "apply",
        "branch",
        "checkout",
        "cherry-pick",
        "clone",
        "commit",
        "config",
        "fetch",
        "init",
        "merge",
        "pull",
        "rebase",
        "remote",
        "restore",
        "revert",
        "rm",
        "stash",
        "submodule",
        "switch",
        "tag",
        "worktree",
      ];

      for (const subcommand of mutating) {
        await expect(tool.execute("execute", { command: ["C:\\tools\\git.exe", subcommand] }, undefined, undefined, {} as never)).rejects.toThrow(
          /confirm=true/iu,
        );
      }
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for Git options that run a program or overwrite a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const victim = join(root, "victim.txt");
      await writeFile(victim, "original", "utf8");
      const escapes = [
        ["git", "grep", "-O./payload.sh", "needle"],
        ["git", "grep", "--open-files-in-pager=./payload.sh", "needle"],
        ["git", "diff", "--output=victim.txt"],
        ["git", "log", "--output", "victim.txt"],
        ["git", "show", "--ext-diff", "HEAD"],
      ];

      for (const command of escapes) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
      }

      await expect(readFile(victim, "utf8")).resolves.toBe("original");
      await expect(tool.execute("execute", { command: ["git", "status", "--short"] }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { allowed: true, confirmed: false },
      });
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for stacked and abbreviated Git options", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await execFileAsync("git", ["init", "--quiet", "."], { cwd: root });
      await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
      await execFileAsync("git", ["add", "file.txt"], { cwd: root });
      const payload = join(root, "payload.sh");
      const marker = join(root, "pwned.txt");
      await writeFile(payload, "#!/bin/sh\nprintf owned > pwned.txt\n", "utf8");
      await chmod(payload, 0o700);
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const escapes = [
        ["git", "grep", "-iO./payload.sh", "needle"],
        ["git", "grep", "-nO./payload.sh", "needle"],
        ["git", "grep", "--open-files-in-pag=./payload.sh", "needle"],
        ["git", "grep", "--outp=./payload.sh", "needle"],
        ["git", "show", "--ext-dif", "HEAD"],
        ["git", "log", "--exec-pat=./payload.sh"],
        ["git", "grep", "--textconv", "needle"],
        ["git", "grep", "--text", "needle"],
      ];

      for (const command of escapes) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
        await expect(access(marker)).rejects.toThrow();
      }

      // The guard is the only thing stopping these: the same argv run directly executes the payload.
      await execFileAsync("git", ["grep", "-iO./payload.sh", "needle"], { cwd: root }).catch(() => undefined);
      await expect(readFile(marker, "utf8")).resolves.toBe("owned");
      await rm(marker, { force: true });

      // Arguments after the pathspec separator are never parsed as options, and ordinary read-only options stay allowed.
      const allowed = [
        ["git", "grep", "needle", "--", "-O./payload.sh"],
        ["git", "grep", "--ignore-case", "needle"],
        ["git", "status", "--short"],
        ["git", "log", "--oneline", "-n5"],
        ["git", "grep", "-n", "needle"],
      ];

      for (const command of allowed) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { allowed: true } });
        await expect(access(marker)).rejects.toThrow();
      }
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for Git options that prefix-resolve into a program-running option", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await execFileAsync("git", ["init", "--quiet", "."], { cwd: root });
      await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
      await writeFile(join(root, ".gitattributes"), "*.txt diff=evil\n", "utf8");
      const payload = join(root, "payload.sh");
      const marker = join(root, "pwned.txt");
      await writeFile(payload, '#!/bin/sh\nprintf owned > pwned.txt\ncat "$1"\n', "utf8");
      await chmod(payload, 0o700);
      await execFileAsync("git", ["config", "diff.evil.textconv", "./payload.sh"], { cwd: root });
      await execFileAsync("git", ["add", "file.txt", ".gitattributes"], { cwd: root });
      await execFileAsync("git", ["-c", "user.email=pi@example.invalid", "-c", "user.name=pi", "commit", "--quiet", "-m", "seed"], { cwd: root });
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      // git cat-file has no --text, so parse-options resolves it to --textconv and runs the configured textconv program; every other entry abbreviates one denylisted option.
      const escapes = [
        ["git", "cat-file", "--text", "HEAD:file.txt"],
        ["git", "cat-file", "--textconv", "HEAD:file.txt"],
        ["git", "cat-file", "--tex", "HEAD:file.txt"],
        ["git", "cat-file", "--filter", "HEAD:file.txt"],
        ["git", "grep", "--open-files-in-pag=./payload.sh", "needle"],
        ["git", "diff", "--outp=file.txt"],
        ["git", "show", "--ext-d", "HEAD"],
        ["git", "log", "--exe=./payload.sh"],
        ["git", "log", "--exec-pat=./payload.sh"],
        ["git", "ls-files", "--upload-pac=./payload.sh"],
        ["git", "ls-files", "--receive-pac=./payload.sh"],
      ];

      for (const command of escapes) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
        await expect(access(marker)).rejects.toThrow();
      }

      // The guard is the only thing stopping the first entry: the same argv run directly executes the payload.
      await execFileAsync("git", ["cat-file", "--text", "HEAD:file.txt"], { cwd: root });
      await expect(readFile(marker, "utf8")).resolves.toBe("owned");
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for read-only Git commands in a repository whose configuration runs a program", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await seedRepository(root, "*.txt diff=evil\n", "diff.evil.textconv", '#!/bin/sh\nprintf owned > pwned.txt\ncat "$1"\n');
      await writeFile(join(root, "file.txt"), "needle here\nmodified\n", "utf8");
      const marker = join(root, "pwned.txt");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      // None of these argvs names a program: the repository's own diff.evil.textconv supplies it.
      const repositoryBorne = [
        ["git", "show", "HEAD"],
        ["git", "diff"],
        ["git", "log", "-p"],
        ["git", "log", "--patch"],
        ["git", "blame", "file.txt"],
        ["git", "cat-file", "--text", "HEAD:file.txt"],
      ];

      for (const command of repositoryBorne) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
        await expect(access(marker)).rejects.toThrow();
      }

      // The guard is the only thing stopping these: the same argv run directly executes the payload.
      await execFileAsync("git", ["show", "HEAD"], { cwd: root });
      await expect(readFile(marker, "utf8")).resolves.toBe("owned");
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for read-only Git commands in a repository that configures a content filter", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await seedRepository(root, "*.txt filter=evil\n", "filter.evil.clean", "#!/bin/sh\nprintf owned > pwned.txt\ncat\n");
      // Rewriting the identical content leaves the file stat-dirty, so git has to re-run the clean filter to decide whether it changed.
      await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
      const marker = join(root, "pwned.txt");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      for (const command of [
        ["git", "status"],
        ["git", "ls-files", "--modified"],
      ]) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
        await expect(access(marker)).rejects.toThrow();
      }

      // The guard is the only thing stopping these: the same argv run directly executes the payload, and no diff option exists to disable a clean filter.
      await execFileAsync("git", ["status", "--short"], { cwd: root });
      await expect(readFile(marker, "utf8")).resolves.toBe("owned");
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs read-only Git commands unconfirmed in a repository with no program-executing configuration", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await execFileAsync("git", ["init", "--quiet", "."], { cwd: root });
      await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
      await execFileAsync("git", ["add", "-A"], { cwd: root });
      await execFileAsync("git", ["-c", "user.email=pi@example.invalid", "-c", "user.name=pi", "commit", "--quiet", "-m", "seed"], { cwd: root });
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      for (const command of [
        ["git", "status"],
        ["git", "log", "--oneline"],
        ["git", "diff"],
      ]) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).resolves.toMatchObject({
          details: { allowed: true, confirmed: false, exitCode: 0 },
        });
      }

      // The diff-family subcommands additionally run with the repository's diff drivers switched off, and the recorded argv is the one that ran.
      await expect(tool.execute("execute", { command: ["git", "log", "--oneline"] }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { command: ["git", "log", "--no-textconv", "--no-ext-diff", "--oneline"] },
      });
      await expect(tool.execute("execute", { command: ["git", "grep", "needle"] }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { command: ["git", "grep", "--no-textconv", "needle"], exitCode: 0 },
      });
      await expect(tool.execute("execute", { command: ["git", "status", "--short"] }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { command: ["git", "status", "--short"] },
      });
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for read-only Git commands in a repository that configures a gpg program", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await seedSignedRepository(root, "gpg.program");
      const marker = join(root, "pwned.txt");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      // --format and --pretty take an arbitrary value, so the argv screen has nothing to object to; the %G placeholders are what force verification.
      const signatureFormats = [
        ["git", "log", "--format=%G?"],
        ["git", "log", "--pretty=%GS"],
        ["git", "show", "--format=%GG", "HEAD"],
        ["git", "log", "--format=%GK"],
        ["git", "log", "--pretty=format:%G?"],
        ["git", "show", "--pretty=%GP", "HEAD"],
      ];

      for (const command of signatureFormats) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
        await expect(access(marker)).rejects.toThrow();
      }

      // The guard is the only thing stopping these: the same argv run directly executes the payload.
      await execFileAsync("git", ["log", "--format=%G?"], { cwd: root });
      await expect(readFile(marker, "utf8")).resolves.toBe("owned");
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for read-only Git commands in a repository that configures a per-format gpg program", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await seedSignedRepository(root, "gpg.openpgp.program");
      const marker = join(root, "pwned.txt");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      await expect(tool.execute("execute", { command: ["git", "log", "--format=%G?"] }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
      await expect(access(marker)).rejects.toThrow();

      // The guard is the only thing stopping this: the same argv run directly executes the payload.
      await execFileAsync("git", ["log", "--format=%G?"], { cwd: root });
      await expect(readFile(marker, "utf8")).resolves.toBe("owned");
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for read-only Git commands in a superproject whose submodule configures a content filter", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      const superproject = await seedSubmoduleRepository(root);
      const marker = join(superproject, "pwned.txt");
      // The superproject's own effective configuration holds no program-executing key at all; only the submodule's does.
      await expect(
        execFileAsync("git", ["config", "--get-regexp", "^(diff|filter)\\..*\\.(clean|command|process|smudge|textconv)$"], { cwd: superproject }),
      ).rejects.toMatchObject({ code: 1 });
      provideLaunchContext(context, { cwd: superproject, agentDir: superproject, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 10_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      for (const command of [
        ["git", "status"],
        ["git", "status", "--short"],
        ["git", "diff"],
      ]) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
        await expect(access(marker)).rejects.toThrow();
      }

      // The guard is the only thing stopping these: the same argv run directly executes the payload.
      await execFileAsync("git", ["status"], { cwd: superproject });
      await expect(readFile(marker, "utf8")).resolves.toBe("owned");
      await rm(marker, { force: true });

      // Deleting .gitmodules hides the submodule from every signal except the gitlink still staged in the superproject's index, and the attack keeps working.
      await rm(join(superproject, ".gitmodules"), { force: true });
      await expect(tool.execute("execute", { command: ["git", "status"] }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
      await expect(access(marker)).rejects.toThrow();
      // The direct run above refreshed the submodule's index, so the file has to be made stat-dirty again for git to consult the clean filter.
      await writeFile(join(superproject, "sub", "a.txt"), "inner\n", "utf8");
      await execFileAsync("git", ["status"], { cwd: superproject });
      await expect(readFile(marker, "utf8")).resolves.toBe("owned");
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("requires confirmation when the hostile submodule is beside the working directory rather than under it", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      const superproject = await seedSubmoduleRepository(root);
      const marker = join(superproject, "pwned.txt");
      // `git ls-files` lists only the part of the index below the current directory, so from here the submodule is invisible unless the probe asks for the whole index.
      const listing = await execFileAsync("git", ["ls-files", "--stage", "--abbrev=4"], { cwd: join(superproject, "src") });
      expect(listing.stdout).not.toContain("160000");
      provideLaunchContext(context, {
        cwd: join(superproject, "src"),
        agentDir: join(superproject, "src"),
        args: [],
        requestExit() {},
      });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 10_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      for (const command of [
        ["git", "status"],
        ["git", "status", "--short"],
        ["git", "diff"],
      ]) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
        await expect(access(marker)).rejects.toThrow();
      }

      // The guard is the only thing stopping this: git status covers the whole repository from any directory inside it, so the same argv run here executes the payload.
      await execFileAsync("git", ["status"], { cwd: join(superproject, "src") });
      await expect(readFile(marker, "utf8")).resolves.toBe("owned");
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("does not probe the repository for Git commands that only report a version", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      // A repository that is risky by every measure the probe applies: a textconv driver, a hooks directory and a submodule.
      const superproject = await seedSubmoduleRepository(root);
      await execFileAsync("git", ["config", "diff.evil.textconv", join(superproject, "payload.sh")], { cwd: superproject });
      provideLaunchContext(context, { cwd: superproject, agentDir: superproject, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 10_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      for (const command of [
        ["git", "--version"],
        ["git", "version"],
      ]) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).resolves.toMatchObject({
          details: { allowed: true, confirmed: false, exitCode: 0 },
        });
      }
      // Screening still applies to whatever follows the version subcommand.
      await expect(tool.execute("execute", { command: ["git", "--version", "--exec-path=./payload.sh"] }, undefined, undefined, {} as never)).rejects.toThrow(
        /confirm=true/iu,
      );
      await expect(tool.execute("execute", { command: ["git", "status"] }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("does not require confirmation for a program-executing key that belongs to the machine rather than the repository", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    try {
      // git-lfs writes exactly these three keys into the user's own ~/.gitconfig, and they are not the untrusted repository this probe exists for.
      const globalConfig = join(root, "gitconfig-global");
      await writeFile(globalConfig, "", "utf8");
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      await execFileAsync("git", ["config", "--global", "filter.lfs.clean", "git-lfs clean -- %f"], { cwd: root });
      await execFileAsync("git", ["config", "--global", "filter.lfs.smudge", "git-lfs smudge -- %f"], { cwd: root });
      await execFileAsync("git", ["config", "--global", "filter.lfs.process", "git-lfs filter-process"], { cwd: root });
      await execFileAsync("git", ["config", "--global", "diff.astextplain.textconv", "astextplain"], { cwd: root });
      const repository = join(root, "repository");
      await mkdir(repository, { recursive: true });
      await seedOrdinaryRepository(repository);
      provideLaunchContext(context, { cwd: repository, agentDir: repository, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      for (const command of [
        ["git", "--version"],
        ["git", "status", "--short"],
        ["git", "log", "--oneline"],
        ["git", "rev-parse", "HEAD"],
        ["git", "diff"],
      ]) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).resolves.toMatchObject({
          details: { allowed: true, confirmed: false, exitCode: 0 },
        });
      }

      // The same key written into the repository's own configuration is still risky, and so is one written into worktree scope.
      await execFileAsync("git", ["config", "filter.evil.clean", "./payload.sh"], { cwd: repository });
      await expect(tool.execute("execute", { command: ["git", "status", "--short"] }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
      await execFileAsync("git", ["config", "--unset", "filter.evil.clean"], { cwd: repository });
      await execFileAsync("git", ["config", "extensions.worktreeConfig", "true"], { cwd: repository });
      await execFileAsync("git", ["config", "--worktree", "diff.evil.textconv", "./payload.sh"], { cwd: repository });
      await expect(tool.execute("execute", { command: ["git", "status", "--short"] }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("treats an include in the repository configuration as repository scope", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await seedOrdinaryRepository(root);
      // An include is the obvious way to try to launder a repository key into another scope; git reports the included key as local all the same.
      await writeFile(join(root, "included.cfg"), '[diff "evil"]\n\ttextconv = ./payload.sh\n', "utf8");
      await execFileAsync("git", ["config", "include.path", "../included.cfg"], { cwd: root });
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      await expect(tool.execute("execute", { command: ["git", "show", "HEAD"] }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps running read-only Git commands in a repository that only sets a hooks directory", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      // What husky v9 writes into every repository it is installed in.
      await seedOrdinaryRepository(root);
      await mkdir(join(root, ".husky", "_"), { recursive: true });
      await execFileAsync("git", ["config", "core.hooksPath", ".husky/_"], { cwd: root });
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      // Every hook name githooks(5) documents, planted as an executable that records that it ran. Nothing in the allowed set below may reach any of them.
      const hooks = join(root, ".husky", "_");
      const fired = join(root, "fired");
      await mkdir(fired, { recursive: true });
      for (const hook of documentedGitHooks) {
        await writeFile(join(hooks, hook), `#!/bin/sh\n: > ${join(fired, hook)}\nexit 0\n`, "utf8");
        await chmod(join(hooks, hook), 0o700);
      }

      for (const command of [
        ["git", "--version"],
        ["git", "log", "--oneline"],
        ["git", "rev-parse", "HEAD"],
        ["git", "show", "HEAD"],
        ["git", "cat-file", "-p", "HEAD"],
        ["git", "cat-file", "-t", "HEAD"],
        ["git", "ls-tree", "HEAD"],
      ]) {
        // Stat-dirty again before each one, so a subcommand that would refresh and rewrite the index has the reason to do it.
        await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).resolves.toMatchObject({
          details: { allowed: true, confirmed: false, exitCode: 0 },
        });
        expect(await readdir(fired)).toStrictEqual([]);
      }

      // core.hooksPath stays on the probed list for the subcommands that read the worktree, because it is not unreachable from those: git status refreshes and rewrites the index, which runs the post-index-change hook out of that directory.
      for (const command of [
        ["git", "status"],
        ["git", "status", "--short"],
        ["git", "diff"],
        ["git", "blame", "file.txt"],
        ["git", "grep", "needle"],
        ["git", "ls-files", "--modified"],
      ]) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
        expect(await readdir(fired)).toStrictEqual([]);
      }

      // The confirmation `git status` costs here is a true positive: run directly, it executes a program out of the hooks directory.
      await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
      await execFileAsync("git", ["status", "--short"], { cwd: root });
      expect(await readdir(fired)).toStrictEqual(["post-index-change"]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation in a repository that ships an executable hook in the default hooks directory", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      // No core.hooksPath and no other configuration: the hook sits where git looks for it by default, so the configuration probe has nothing to report.
      await seedOrdinaryRepository(root);
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      const fired = join(root, "fired");
      await mkdir(fired, { recursive: true });
      for (const hook of documentedGitHooks) {
        await writeFile(join(root, ".git", "hooks", hook), `#!/bin/sh\n: > ${join(fired, hook)}\nexit 0\n`, "utf8");
        await chmod(join(root, ".git", "hooks", hook), 0o700);
      }

      for (const command of [
        ["git", "status"],
        ["git", "status", "--short"],
        ["git", "diff"],
        ["git", "blame", "file.txt"],
        ["git", "grep", "needle"],
        ["git", "ls-files", "--modified"],
      ]) {
        await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
        expect(await readdir(fired)).toStrictEqual([]);
      }

      // The same repository must not lose the subcommands that were measured never to reach a hook.
      for (const command of [
        ["git", "--version"],
        ["git", "log", "--oneline"],
        ["git", "rev-parse", "HEAD"],
        ["git", "show", "HEAD"],
        ["git", "ls-tree", "HEAD"],
      ]) {
        await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).resolves.toMatchObject({
          details: { allowed: true, confirmed: false, exitCode: 0 },
        });
        expect(await readdir(fired)).toStrictEqual([]);
      }

      // The confirmation is a true positive: run directly, `git status --short` executes the hook out of the default directory.
      await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
      await execFileAsync("git", ["status", "--short"], { cwd: root });
      expect(await readdir(fired)).toStrictEqual(["post-index-change"]);
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps running read-only Git commands in a repository whose default hooks directory holds only samples and a pre-commit hook", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      // What `git init` leaves behind plus the hook a linter installs. Neither is reachable from a read-only subcommand, so neither may cost a confirmation.
      await seedOrdinaryRepository(root);
      await writeFile(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(join(root, ".git", "hooks", "pre-commit"), 0o700);
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      for (const command of [
        ["git", "status", "--short"],
        ["git", "diff"],
        ["git", "grep", "needle"],
        ["git", "ls-files", "--modified"],
        ["git", "log", "--oneline"],
      ]) {
        await writeFile(join(root, "file.txt"), "needle here\n", "utf8");
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).resolves.toMatchObject({
          details: { allowed: true, confirmed: false, exitCode: 0 },
        });
      }
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not require confirmation for the keys no allowlisted subcommand was able to reach", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      await seedOrdinaryRepository(root);
      const payload = join(root, "payload.sh");
      const marker = join(root, "pwned.txt");
      await writeFile(payload, `#!/bin/sh\nprintf owned > ${marker}\ncat\nexit 0\n`, "utf8");
      await chmod(payload, 0o700);
      for (const key of ["core.sshCommand", "sequence.editor", "uploadpack.packObjectsHook"]) {
        await execFileAsync("git", ["config", key, payload], { cwd: root });
      }
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      for (const command of [
        ["git", "status"],
        ["git", "log", "-p"],
        ["git", "blame", "file.txt"],
        ["git", "show", "HEAD"],
        ["git", "ls-files", "--modified"],
        ["git", "rev-parse", "HEAD"],
      ]) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { allowed: true } });
      }
      // Dropping them is only safe while they stay unreachable, so this asserts the premise rather than the guard: running every allowlisted subcommand directly leaves no marker behind.
      for (const argv of [
        ["blame", "file.txt"],
        ["cat-file", "-p", "HEAD:file.txt"],
        ["describe", "--always"],
        ["diff", "HEAD"],
        ["grep", "needle"],
        ["log", "-p"],
        ["ls-files", "--modified"],
        ["ls-tree", "HEAD"],
        ["rev-parse", "HEAD"],
        ["show", "HEAD"],
        ["status"],
      ]) {
        await execFileAsync("git", argv, { cwd: root }).catch(() => undefined);
        await expect(access(marker)).rejects.toThrow();
      }
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs read-only Git commands unconfirmed outside a repository", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");

      // A directory that is not a repository holds no submodule and no repository configuration, so the index probe failing there must not turn every git command into a confirmation prompt.
      for (const command of [
        ["git", "status", "--short"],
        ["git", "log", "--oneline"],
      ]) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { allowed: true } });
      }
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  // The option allowlist above is exercised on the spellings that name a program directly; these three name a transport helper or a lookup path instead, and each one is a program git would run.
  test("requires confirmation for Git transport and exec-path options", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const escapes = [
        ["git", "rev-parse", "--exec-path=/tmp"],
        ["git", "ls-tree", "--upload-pack=sh", "HEAD"],
        ["git", "ls-files", "--receive-pack=sh"],
      ];

      for (const command of escapes) {
        await expect(tool.execute("execute", { command }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
      }

      await expect(tool.execute("execute", { command: ["git", "--version"] }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { allowed: true, confirmed: false },
      });
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires confirmation for direct filesystem mutation commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-auto-mode-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(autoModePlugin, { mode: "safe", timeoutMs: 5_000 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "auto_mode_exec");
      if (tool === undefined) throw new Error("auto_mode_exec was not registered");
      const mutating = ["cp", "mv", "install", "mkdir", "touch", "truncate", "tee", "ln", "unlink", "patch", "tar", "zip", "unzip", "rsync"];

      for (const command of mutating) {
        await expect(tool.execute("execute", { command: [`C:\\tools\\${command}.exe`, "target"] }, undefined, undefined, {} as never)).rejects.toThrow(
          /confirm=true/iu,
        );
      }
    } finally {
      await context.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("checks and executes in the current native workspace and rejects obsolete probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-native-")),
    active = join(root, "active");
  const context = new Context(),
    tools = new PiToolRegistry(),
    panels = new PiPluginUiRegistry();
  let id = "first";
  let session = { sessionId: id, sessionManager: { getCwd: () => root } };
  try {
    await mkdir(active);
    await execFileAsync("git", ["init", "-q"], { cwd: active });
    await execFileAsync("git", ["config", "filter.test.clean", "./filter.sh"], { cwd: active });
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    context.provide("piRuntime", {
      get session() {
        return session;
      },
    } as never);
    await context.plugin(autoModePlugin, {});
    const tool = tools.snapshot().customTools[0]!;
    await tool.execute("first", { command: ["pwd"] }, undefined, undefined, {} as never);
    session = {
      get sessionId() {
        return id;
      },
      sessionManager: { getCwd: () => active },
    };
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { last: null } }]);
    await expect(tool.execute("risky", { command: ["git", "status", "--short"] }, undefined, undefined, {} as never)).rejects.toThrow(/risky command/iu);
    const result = await tool.execute(
      "write",
      { command: [process.execPath, "-e", "require('node:fs').writeFileSync('marker', 'active')"], confirm: true },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toMatchObject({ exitCode: 0 });
    expect(await readFile(join(active, "marker"), "utf8")).toBe("active");
    await expect(access(join(root, "marker"))).rejects.toThrow(/ENOENT/u);
    const pending = tool.execute("pending", { command: ["git", "status", "--short"] }, undefined, undefined, {} as never);
    id = "replacement";
    await expect(pending).rejects.toThrow(/workspace changed/iu);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { last: null, blocked: 0 } }]);
    const changingParams = {
      get command() {
        id = "getter-replacement";
        return ["pwd"];
      },
      confirm: true,
    };
    await expect(tool.execute("getter", changingParams, undefined, undefined, {} as never)).rejects.toThrow(/workspace changed/iu);
    for (const exitCode of [0, 7]) {
      const running = tool.execute(
        "running",
        { command: [process.execPath, "-e", `process.exit(${exitCode})`], confirm: true },
        undefined,
        undefined,
        {} as never,
      );
      id = `replacement-${exitCode}`;
      await expect(running).rejects.toThrow(/workspace changed/iu);
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { last: null, blocked: 0 } }]);
    }
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
