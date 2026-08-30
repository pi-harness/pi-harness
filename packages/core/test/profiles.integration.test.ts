import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { bootHarness, type BootedHarness } from "../src/boot.js";
import { resolveProfileConfig } from "../src/profile.js";
import { provideLaunchContext } from "../src/services.js";
import { provideStdioContext } from "../src/stdio.js";

const booted: BootedHarness[] = [];

afterEach(async () => {
  await Promise.all(booted.splice(0).map(async (harness) => harness.dispose()));
});

async function bootProfile(profile: string): Promise<BootedHarness> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-profile-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-profile-agent-"));
  const configPath = await resolveProfileConfig({ profile });
  const harness = await bootHarness({
    configPath,
    prepare(context) {
      provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
      provideStdioContext(context, { async readPrompt() { return ""; }, writeOutput() {}, writeError() {} });
    },
  });
  booted.push(harness);
  return harness;
}

describe("packaged profiles", () => {
  test("boots the default production profile without HMR", async () => {
    const harness = await bootProfile("default");
    const names = [...harness.context.loader.entries()].map((entry) => entry.options.name);

    expect(harness.context.get("piModels")?.model.provider).toBe("deepseek");
    expect(harness.context.get("piApplication")).toBeDefined();
    expect(harness.context.get("hmr")).toBeUndefined();
    expect(names).not.toContain("@deepseek-ai/cordis-plugin-hmr");
  });

  test("boots the development profile with logger, timer, and HMR plugins", async () => {
    const harness = await bootProfile("development");
    const entries = [...harness.context.loader.entries()];
    const names = entries.map((entry) => entry.options.name);
    const timer = entries.find((entry) => entry.options.name === "@deepseek-ai/cordis-plugin-timer");
    const hmr = entries.find((entry) => entry.options.name === "@deepseek-ai/cordis-plugin-hmr");

    expect(timer?.fiber?.ctx.get("timer")).toBeDefined();
    expect(hmr?.fiber?.ctx.get("hmr")).toBeDefined();
    expect(names).toEqual(expect.arrayContaining(["@deepseek-ai/cordis-plugin-logger-console", "@deepseek-ai/cordis-plugin-timer", "@deepseek-ai/cordis-plugin-hmr"]));
  });
});
