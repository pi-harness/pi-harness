import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { bootHarness, provideStdioContext, resolveProfileConfig, type BootedHarness } from "@pi-harness/core";
import { provideLaunchContext } from "@pi-harness/plugin-api";
import { BUILTIN_PROFILES_DIR } from "../src/profiles.js";

const booted: BootedHarness[] = [];
const execFileAsync = promisify(execFile);

// The shipped profiles enable infrastructure only, because an official plugin is installed from the plugin center like a community one. Exercising a plugin against a real host therefore needs a profile that enables it, so this one names the plugins these tests drive end to end.
const PLUGIN_PROFILES_DIR = fileURLToPath(new URL("profiles", import.meta.url));

afterEach(async () => {
  await Promise.all(booted.splice(0).map(async (harness) => harness.dispose()));
});

async function bootProfile(profile: string, profilesDir: string = BUILTIN_PROFILES_DIR): Promise<{ harness: BootedHarness; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-profile-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-profile-agent-"));
  const configPath = await resolveProfileConfig({ profile, profilesDir });
  const harness = await bootHarness({
    configPath,
    prepare(context) {
      provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
      provideStdioContext(context, {
        readPrompt() {
          return Promise.resolve("");
        },
        writeOutput() {},
        writeError() {},
      });
    },
  });
  booted.push(harness);
  return { harness, cwd };
}

describe("packaged profiles", () => {
  test("exposes every plugin-profile tool with strict sequential execution metadata", async () => {
    const { harness } = await bootProfile("plugins", PLUGIN_PROFILES_DIR);
    const tools = harness.context.get("piTools")?.snapshot().customTools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.executionMode, tool.name).toBe("sequential");
      expect(tool.parameters, tool.name).toMatchObject({ type: "object", additionalProperties: false });
    }
  }, 30_000);

  test("boots the shipped default profile with infrastructure only", async () => {
    // A fresh install must arrive with nothing pluggable switched on: every official plugin is installed from the plugin center, exactly like a community one.
    const { harness } = await bootProfile("default");
    const names = [...harness.context.loader.entries()].map((entry) => entry.options.name);

    expect(harness.context.get("piModels")?.model.provider).toBe("deepseek");
    expect(harness.context.get("piApplication")).toBeDefined();
    expect(harness.context.get("piRuntime")).toBeDefined();
    expect(names.filter((name) => name.startsWith("@pi-harness/plugin-"))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(["@pi-harness/core/plugins/tools", "@pi-harness/core/plugins/runtime", "@pi-harness/core/plugins/stdio"]));
    expect(harness.context.get("piTools")?.snapshot().customTools).toEqual([]);
  }, 15_000);

  test("boots the production plugin profile without HMR", async () => {
    const { harness, cwd } = await bootProfile("plugins", PLUGIN_PROFILES_DIR);
    const names = [...harness.context.loader.entries()].map((entry) => entry.options.name);

    expect(harness.context.get("piModels")?.model.provider).toBe("deepseek");
    expect(harness.context.get("piApplication")).toBeDefined();
    expect(harness.context.get("hmr")).toBeUndefined();
    expect(names).not.toContain("@deepseek-ai/cordis-plugin-hmr");
    expect(names).toContain("@pi-harness/plugin-agent-teams");
    expect(names).toContain("@pi-harness/plugin-modlens");
    expect(names).toContain("@pi-harness/plugin-vision-toolkit");
    expect(names).toContain("@pi-harness/plugin-git-time-capsule");
    expect(names).toContain("@pi-harness/plugin-dependency-checker");
    expect(names).toContain("@pi-harness/plugin-at-file");
    expect(names).toContain("@pi-harness/plugin-test-harness");
    expect(names).toContain("@pi-harness/plugin-session-insights");
    expect(names).toContain("@pi-harness/plugin-plugin-stars");
    expect(names).toContain("@pi-harness/plugin-session-bridge");
    expect(names).toContain("@pi-harness/plugin-skill-guard");
    expect(names).toContain("@pi-harness/plugin-recall-unread");
    expect(names).toContain("@pi-harness/plugin-turn-rewind");
    expect(names).toContain("@pi-harness/plugin-context-doctor");
    expect(names).toEqual(
      expect.arrayContaining([
        "@pi-harness/plugin-sql-lens",
        "@pi-harness/plugin-docker-sandbox",
        "@pi-harness/plugin-mcp-client",
        "@pi-harness/plugin-browser-fetch",
        "@pi-harness/plugin-browser-session",
        "@pi-harness/plugin-yaml-validator",
        "@pi-harness/plugin-plugin-dev",
        "@pi-harness/plugin-openpets",
        "@pi-harness/plugin-skill-guard",
        "@pi-harness/core/plugins/runtime",
        "@pi-harness/plugin-context",
        "@pi-harness/plugin-token-guard",
        "@pi-harness/plugin-fail-logger",
        "@pi-harness/core/plugins/stdio",
      ]),
    );

    const sessionReportTool = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.find((tool) => tool.name === "session_report");
    if (sessionReportTool === undefined) throw new Error("plugin test profile did not register session_report");
    expect(
      harness.context
        .get("piRuntime")
        ?.session.getAllTools()
        .map((tool) => tool.name),
    ).toContain("session_report");
    const sessionReport = await sessionReportTool.execute("profile-session-report", {}, undefined, undefined, {} as never);
    expect(typeof (sessionReport.details as { sessionId?: unknown }).sessionId).toBe("string");
    expect(sessionReport.details).toMatchObject({
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      compaction: { status: "idle" },
    });
    const sessionInsightsPanel = (await harness.context.get("piPluginUi")?.snapshot())?.find((panel) => panel.id === "session-insights-panel");
    expect(sessionInsightsPanel?.data).toEqual(sessionReport.details);

    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: { typecheck: "node profile-test-harness.mjs" },
        dependencies: { present: "1.0.0", missing: "1.0.0", conflict: "^1.0.0", shared: "workspace:*" },
        devDependencies: { conflict: "^2.0.0", shared: "^1.0.0" },
        optionalDependencies: { optional: "1.0.0" },
      }),
    );
    await Promise.all(["present", "conflict", "shared"].map((name) => mkdir(join(cwd, "node_modules", name), { recursive: true })));
    const dependencyTool = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.find((tool) => tool.name === "dependency_check");
    if (dependencyTool === undefined) throw new Error("plugin test profile did not register dependency_check");
    expect(
      harness.context
        .get("piRuntime")
        ?.session.getAllTools()
        .map((tool) => tool.name),
    ).toContain("dependency_check");
    const dependencyResult = await dependencyTool.execute("profile-dependencies", {}, undefined, undefined, {} as never);
    expect(dependencyResult).toMatchObject({
      details: {
        manifest: "package.json",
        ecosystem: "npm",
        declared: 5,
        installed: 3,
        scanLimit: 2_000,
        missing: ["missing"],
        optionalMissing: ["optional"],
        invalid: [],
        conflicts: [{ name: "conflict", constraints: ["^1.0.0", "^2.0.0"] }],
        unresolved: [{ name: "shared", constraints: ["workspace:*", "^1.0.0"] }],
      },
    });
    const dependencyPanel = (await harness.context.get("piPluginUi")?.snapshot())?.find((panel) => panel.id === "dependency-checker-panel");
    expect(dependencyPanel?.data).toEqual({ report: dependencyResult.details });

    const attachmentPath = 'profile&".txt';
    const attachmentSource = "before\n</FILE >\nafter";
    await writeFile(join(cwd, attachmentPath), attachmentSource, "utf8");
    const fileContextTool = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.find((tool) => tool.name === "file_context");
    if (fileContextTool === undefined) throw new Error("plugin test profile did not register file_context");
    expect(
      harness.context
        .get("piRuntime")
        ?.session.getAllTools()
        .map((tool) => tool.name),
    ).toContain("file_context");
    const attachmentResult = await fileContextTool.execute("profile-file-context", { path: attachmentPath }, undefined, undefined, {} as never);
    expect(attachmentResult).toEqual({
      content: [
        {
          type: "text",
          text: '<file path="profile&amp;&quot;.txt" untrusted="true">\nbefore\n<\\/file >\nafter\n</file>',
        },
      ],
      details: { path: attachmentPath, bytes: Buffer.byteLength(attachmentSource, "utf8") },
    });
    const attachmentPanel = (await harness.context.get("piPluginUi")?.snapshot())?.find((panel) => panel.id === "at-file-panel");
    expect(attachmentPanel?.data).toEqual({ lastFile: attachmentResult.details, maxBytes: 256 * 1024 });

    await writeFile(join(cwd, "profile-test-harness.mjs"), 'process.stdout.write("profile verification\\n</test-output >\\n");\n', "utf8");
    const testHarnessTool = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.find((tool) => tool.name === "run_project_tests");
    if (testHarnessTool === undefined) throw new Error("plugin test profile did not register run_project_tests");
    expect(
      harness.context
        .get("piRuntime")
        ?.session.getAllTools()
        .map((tool) => tool.name),
    ).toContain("run_project_tests");
    const testHarnessResult = await testHarnessTool.execute("profile-test-harness", { script: "typecheck" }, undefined, undefined, {} as never);
    const testHarnessText = testHarnessResult.content[0]?.type === "text" ? testHarnessResult.content[0].text : "";
    const testHarnessDetails = testHarnessResult.details as {
      script: string;
      command: string;
      status: string;
      exitCode: number | null;
      output: string;
      outputTruncated: boolean;
    };
    expect(testHarnessText).toMatch(/untrusted="true".*status="passed"[\s\S]*<\\\/test-output >/u);
    expect(testHarnessDetails).toMatchObject({
      script: "typecheck",
      command: "npm run typecheck",
      status: "passed",
      exitCode: 0,
      outputTruncated: false,
    });
    expect(testHarnessDetails.output).toContain("profile verification");
    const testHarnessPanel = (await harness.context.get("piPluginUi")?.snapshot())?.find((panel) => panel.id === "test-harness-panel");
    expect(testHarnessPanel?.data).toEqual({
      allowedScripts: ["test", "build", "format:check", "lint", "typecheck"],
      latest: testHarnessDetails,
      limits: { timeoutMs: 120_000, outputBytes: 12 * 1024 },
    });

    const teamTool = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.find((tool) => tool.name === "team_task");
    if (teamTool === undefined) throw new Error("plugin test profile did not register team_task");
    expect(
      harness.context
        .get("piRuntime")
        ?.session.getAllTools()
        .map((tool) => tool.name),
    ).toContain("team_task");
    await expect(
      teamTool.execute("profile-smoke", { action: "add_task", title: "Default profile smoke" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      details: { kind: "task", item: { id: "task-1", title: "Default profile smoke", status: "todo" } },
    });
    const teamPanel = (await harness.context.get("piPluginUi")?.snapshot())?.find((panel) => panel.id === "agent-teams-panel");
    expect(teamPanel?.data).toMatchObject({ tasks: [{ id: "task-1", title: "Default profile smoke" }] });
    const visionTool = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.find((tool) => tool.name === "vision_inspect");
    if (visionTool === undefined) throw new Error("plugin test profile did not register vision_inspect");
    expect(
      harness.context
        .get("piRuntime")
        ?.session.getAllTools()
        .map((tool) => tool.name),
    ).toContain("vision_inspect");
    const modlensPanel = (await harness.context.get("piPluginUi")?.snapshot())?.find((panel) => panel.id === "modlens-panel");
    expect(modlensPanel?.data).toMatchObject({ attached: false, status: { state: "idle" }, limits: { imageBytes: 10_485_760 } });
    const toolkitTools = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.filter((tool) => tool.name === "vision_catalog" || tool.name === "vision_image_info");
    expect(toolkitTools?.map((tool) => tool.name).sort()).toEqual(["vision_catalog", "vision_image_info"]);
    expect(
      harness.context
        .get("piRuntime")
        ?.session.getAllTools()
        .map((tool) => tool.name),
    ).toEqual(expect.arrayContaining(["vision_catalog", "vision_image_info"]));
    const image = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(image);
    image.writeUInt32BE(13, 8);
    image.write("IHDR", 12, "ascii");
    image.writeUInt32BE(32, 16);
    image.writeUInt32BE(18, 20);
    await writeFile(join(cwd, "profile-vision.png"), image);
    const infoTool = toolkitTools?.find((tool) => tool.name === "vision_image_info");
    if (infoTool === undefined) throw new Error("plugin test profile did not register vision_image_info");
    await expect(infoTool.execute("profile-vision", { path: "profile-vision.png" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { path: "profile-vision.png", width: 32, height: 18, headerTruncated: false },
    });
    const toolkitPanel = (await harness.context.get("piPluginUi")?.snapshot())?.find((panel) => panel.id === "vision-toolkit-panel");
    expect(toolkitPanel?.data).toMatchObject({
      status: { state: "completed", operation: "info", path: "profile-vision.png", count: 1 },
      report: { assets: [{ path: "profile-vision.png", width: 32, height: 18 }] },
      limits: { imageBytes: 20_971_520, headerBytes: 262_144, assets: 100, imageCandidates: 256 },
    });
    const capsuleTools = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.filter((tool) => tool.name === "git_snapshot" || tool.name === "git_restore");
    expect(capsuleTools?.map((tool) => tool.name).sort()).toEqual(["git_restore", "git_snapshot"]);
    expect(
      harness.context
        .get("piRuntime")
        ?.session.getAllTools()
        .map((tool) => tool.name),
    ).toEqual(expect.arrayContaining(["git_snapshot", "git_restore"]));
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Pi Harness Test"], { cwd });
    await writeFile(join(cwd, "profile-capsule.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "profile-capsule.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd });
    await writeFile(join(cwd, "profile-capsule.txt"), "after\n", "utf8");
    const capture = capsuleTools?.find((tool) => tool.name === "git_snapshot");
    const restore = capsuleTools?.find((tool) => tool.name === "git_restore");
    if (capture === undefined || restore === undefined) throw new Error("plugin test profile did not register both Git Time Capsule tools");
    const captured = await capture.execute("profile-capsule", {}, undefined, undefined, {} as never);
    const capsuleName = (captured.details as { name?: unknown }).name;
    if (typeof capsuleName !== "string") throw new Error("plugin test profile Git snapshot did not return a capsule name");
    await restore.execute("profile-capsule-restore", { name: capsuleName, confirm: true }, undefined, undefined, {} as never);
    await expect(readFile(join(cwd, "profile-capsule.txt"), "utf8")).resolves.toBe("before\n");
    const capsulePanel = (await harness.context.get("piPluginUi")?.snapshot())?.find((panel) => panel.id === "git-time-capsule-panel");
    expect(capsulePanel?.data).toMatchObject({
      latest: { action: "restore", status: "completed", name: capsuleName, files: 1, restored: true },
      inventory: { total: 1, shown: 1, truncated: false, displayLimit: 20 },
      limits: { capsuleBytes: 8_388_608, inventory: 256, directoryEntries: 4_096 },
    });
  }, 15_000);

  test("boots the development profile with logger, timer, and HMR plugins", async () => {
    const { harness, cwd } = await bootProfile("development");
    const entries = [...harness.context.loader.entries()];
    const names = entries.map((entry) => entry.options.name);
    const timer = entries.find((entry) => entry.options.name === "@deepseek-ai/cordis-plugin-timer");
    const hmr = entries.find((entry) => entry.options.name === "@deepseek-ai/cordis-plugin-hmr");

    expect(timer?.fiber?.ctx.get("timer")).toBeDefined();
    expect(hmr?.fiber?.ctx.get("hmr")).toMatchObject({ baseDir: cwd });
    expect(names).toEqual(
      expect.arrayContaining(["@deepseek-ai/cordis-plugin-logger-console", "@deepseek-ai/cordis-plugin-timer", "@deepseek-ai/cordis-plugin-hmr"]),
    );
  });

  test("loads production README tools into the default runtime and writes a current confirmed snapshot", async () => {
    const { harness, cwd } = await bootProfile("plugins", PLUGIN_PROFILES_DIR);
    const loaderNames = [...harness.context.loader.entries()].map((entry) => entry.options.name);
    const registered = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.filter((tool) => tool.name === "readme_report" || tool.name === "readme_write");
    const runtimeNames = harness.context
      .get("piRuntime")
      ?.session.getAllTools()
      .map((tool) => tool.name);

    expect(loaderNames).toContain("@pi-harness/plugin-readme-gen");
    expect(registered?.map((tool) => tool.name).sort()).toEqual(["readme_report", "readme_write"]);
    expect(runtimeNames).toEqual(expect.arrayContaining(["readme_report", "readme_write"]));
    const report = registered?.find((tool) => tool.name === "readme_report");
    const write = registered?.find((tool) => tool.name === "readme_write");
    if (report === undefined || write === undefined) throw new Error("plugin test profile did not register both README tools");

    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ name: "profile-before", version: "1.0.0", description: "Profile fixture", scripts: { test: "vitest" } }),
      "utf8",
    );
    const readmeReport = await report.execute("profile-readme-report", {}, undefined, undefined, {} as never);
    expect(readmeReport).toMatchObject({
      details: {
        name: "profile-before",
        version: "1.0.0",
        scripts: ["test"],
      },
    });
    expect((readmeReport.details as { plugins: string[] }).plugins).toEqual(
      expect.arrayContaining(["@pi-harness/plugin-readme-gen", "@pi-harness/core/plugins/runtime"]),
    );

    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ name: "profile-after", version: "2.0.0", description: "Current profile fixture", scripts: { build: "tsc" } }),
      "utf8",
    );
    await expect(
      write.execute("profile-readme-write", { outputPath: "docs/README.generated.md", confirm: true }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ details: { path: "docs/README.generated.md", overwritten: false } });
    const generated = await readFile(join(cwd, "docs/README.generated.md"), "utf8");
    expect(generated).toContain("# profile-after");
    expect(generated).toContain("Version: 2.0.0");
    expect(generated).toContain("npm run build");
    expect(generated).not.toContain("profile-before");

    await expect(
      write.execute("profile-readme-no-overwrite", { outputPath: "docs/README.generated.md", confirm: true }, undefined, undefined, {} as never),
    ).rejects.toThrow(/overwrite=true/iu);
    await expect(
      write.execute("profile-readme-overwrite", { outputPath: "docs/README.generated.md", confirm: true, overwrite: true }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ details: { path: "docs/README.generated.md", overwritten: true } });
    const panel = (await harness.context.get("piPluginUi")?.snapshot())?.find((candidate) => candidate.id === "readme-gen-panel");
    expect(panel?.data).toMatchObject({
      generated: true,
      name: "profile-after",
      scripts: 1,
      status: { state: "completed", operation: "write" },
      lastWrite: { path: "docs/README.generated.md", overwritten: true },
    });
  }, 15_000);

  test("loads the production I18n pair tool into the default runtime and compares real locale files", async () => {
    const { harness, cwd } = await bootProfile("plugins", PLUGIN_PROFILES_DIR);
    const loaderNames = [...harness.context.loader.entries()].map((entry) => entry.options.name);
    const tool = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.find((candidate) => candidate.name === "i18n_check");
    const runtimeNames = harness.context
      .get("piRuntime")
      ?.session.getAllTools()
      .map((candidate) => candidate.name);

    expect(loaderNames).toContain("@pi-harness/plugin-i18n-pair");
    expect(tool).toMatchObject({ executionMode: "sequential", parameters: { additionalProperties: false } });
    expect(runtimeNames).toContain("i18n_check");
    if (tool === undefined) throw new Error("plugin test profile did not register i18n_check");

    await mkdir(join(cwd, "locales"), { recursive: true });
    await Promise.all([
      writeFile(join(cwd, "locales", "en.json"), JSON.stringify({ actions: { save: "Save", cancel: "Cancel" } }), "utf8"),
      writeFile(join(cwd, "locales", "ja.json"), JSON.stringify({ actions: { save: "保存" }, onlyHere: "追加" }), "utf8"),
    ]);
    await expect(
      tool.execute("profile-i18n", { base: "locales/en.json", target: "locales/ja.json" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      details: {
        base: "locales/en.json",
        target: "locales/ja.json",
        baseKeys: 2,
        targetKeys: 2,
        missing: ["actions.cancel"],
        extra: ["onlyHere"],
      },
    });
    const panel = (await harness.context.get("piPluginUi")?.snapshot())?.find((candidate) => candidate.id === "i18n-pair-panel");
    expect(panel?.data).toMatchObject({
      status: { state: "completed" },
      report: {
        base: "locales/en.json",
        target: "locales/ja.json",
        missing: ["actions.cancel"],
        extra: ["onlyHere"],
        missingTotal: 1,
        extraTotal: 1,
        truncated: false,
      },
    });
  }, 15_000);

  test("loads the production Cleaner tool into the default runtime and removes only excess capsules", async () => {
    const { harness } = await bootProfile("plugins", PLUGIN_PROFILES_DIR);
    const loaderNames = [...harness.context.loader.entries()].map((entry) => entry.options.name);
    const tool = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.find((candidate) => candidate.name === "clean_harness_artifacts");
    const runtimeNames = harness.context
      .get("piRuntime")
      ?.session.getAllTools()
      .map((candidate) => candidate.name);
    const agentDir = harness.context.get("piHarnessLaunch")?.agentDir;

    expect(loaderNames).toContain("@pi-harness/plugin-cleaner");
    expect(tool).toMatchObject({ executionMode: "sequential", parameters: { additionalProperties: false } });
    expect(runtimeNames).toContain("clean_harness_artifacts");
    if (tool === undefined) throw new Error("plugin test profile did not register clean_harness_artifacts");
    if (agentDir === undefined) throw new Error("default profile did not expose PI_AGENT_DIR");

    const capsuleDir = join(agentDir, "capsules");
    await mkdir(capsuleDir, { recursive: true });
    await Promise.all([
      writeFile(join(capsuleDir, "0001.patch"), "old", "utf8"),
      writeFile(join(capsuleDir, "0002.patch"), "middle", "utf8"),
      writeFile(join(capsuleDir, "0003.patch"), "new", "utf8"),
    ]);
    await expect(tool.execute("profile-cleaner", { confirm: true, keep: 1 }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { removed: 2, kept: 1 },
    });
    await expect(readFile(join(capsuleDir, "0001.patch"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(capsuleDir, "0002.patch"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(capsuleDir, "0003.patch"), "utf8")).resolves.toBe("new");

    const panel = (await harness.context.get("piPluginUi")?.snapshot())?.find((candidate) => candidate.id === "cleaner-panel");
    expect(panel?.data).toMatchObject({
      capsules: [{ name: "0003.patch", bytes: 3 }],
      inventory: { total: 1, shown: 1, truncated: false, displayLimit: 20 },
      lastCleanup: { status: "completed", requestedKeep: 1, removed: 2, kept: 1 },
      lastRemoved: 2,
      limits: { capsules: 256, directoryEntries: 4_096 },
    });
    expect(harness.context.get("piRuntime")?.session.messages).toEqual([]);
  }, 15_000);

  test("loads the production SQL Lens tool into the default runtime and runs a local read-only query", async () => {
    const { harness, cwd } = await bootProfile("plugins", PLUGIN_PROFILES_DIR);
    const loaderNames = [...harness.context.loader.entries()].map((entry) => entry.options.name);
    const tool = harness.context
      .get("piTools")
      ?.snapshot()
      .customTools.find((candidate) => candidate.name === "sql_readonly");
    const runtimeNames = harness.context
      .get("piRuntime")
      ?.session.getAllTools()
      .map((candidate) => candidate.name);
    expect(loaderNames).toContain("@pi-harness/plugin-sql-lens");
    expect(tool).toMatchObject({ executionMode: "sequential", parameters: { additionalProperties: false } });
    expect(runtimeNames).toContain("sql_readonly");
    if (tool === undefined) throw new Error("plugin test profile did not register sql_readonly");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(cwd, "data.db"));
    database.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users VALUES (1, 'Ada')");
    database.close();
    await expect(
      tool.execute("profile-sql", { database: "data.db", query: "SELECT id, name FROM users" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      details: { database: "data.db", columns: ["id", "name"], rows: [{ id: 1, name: "Ada" }], scannedRows: 1 },
    });
    const panel = (await harness.context.get("piPluginUi")?.snapshot())?.find((candidate) => candidate.id === "sql-lens-panel");
    expect(panel?.data).toMatchObject({ latest: { database: "data.db", rows: [{ id: 1, name: "Ada" }] }, status: { state: "completed" }, timeoutMs: 5_000 });
    expect(harness.context.get("piRuntime")?.session.messages).toEqual([]);
  }, 15_000);

  test("activates an external tool plugin before the runtime through Cordis injection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-custom-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-custom-agent-"));
    const configPath = join(cwd, "cordis.yml");
    const plugins = {
      models: import.meta.resolve("@pi-harness/core/plugins/models"),
      resources: import.meta.resolve("@pi-harness/core/plugins/resources"),
      model: import.meta.resolve("@pi-harness/core/plugins/model"),
      session: import.meta.resolve("@pi-harness/core/plugins/session"),
      tools: import.meta.resolve("@pi-harness/core/plugins/tools"),
      hello: import.meta.resolve("@pi-harness/plugin-hello"),
      runtime: import.meta.resolve("@pi-harness/core/plugins/runtime"),
      stdio: import.meta.resolve("@pi-harness/core/plugins/stdio"),
    };
    await writeFile(
      configPath,
      JSON.stringify([
        { id: "models", name: plugins.models, config: { provider: "deepseek", model: "deepseek-v4-flash", refreshOnCreate: false } },
        {
          id: "resources",
          name: plugins.resources,
          config: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
        },
        { id: "model", name: plugins.model, config: {} },
        { id: "session", name: plugins.session, config: { storage: "memory" } },
        { id: "tools", name: plugins.tools, config: { names: [] } },
        { id: "hello", name: plugins.hello, config: {} },
        { id: "runtime", name: plugins.runtime, inject: ["piHelloTool"], config: { thinkingLevel: "medium" } },
        { id: "stdio", name: plugins.stdio, config: {} },
      ]),
      "utf8",
    );
    const harness = await bootHarness({
      configPath,
      prepare(context) {
        provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
        provideStdioContext(context, {
          readPrompt() {
            return Promise.resolve("");
          },
          writeOutput() {},
          writeError() {},
        });
      },
    });
    booted.push(harness);

    expect(
      harness.context
        .get("piTools")
        ?.snapshot()
        .customTools.map((tool) => tool.name),
    ).toEqual(["hello"]);
    const sessionTools = harness.context.get("piRuntime")?.session.getAllTools();
    expect(sessionTools).toHaveLength(1);
    expect(sessionTools?.[0]?.name).toBe("hello");
    expect(sessionTools?.[0]?.sourceInfo.source).toBe("sdk");
  });
});
