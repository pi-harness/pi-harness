import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import autoModePlugin from "../src/plugins/auto-mode.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "../src/services.js";

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
