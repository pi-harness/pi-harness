import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import toolsPlugin from "@pi-harness/core/plugins/tools";
import yamlValidatorPlugin from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createValidator() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-yaml-validator-"));
  temporaryDirectories.push(cwd);
  const context = new Context();
  provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
  await context.plugin(toolsPlugin, { names: [] });
  await context.plugin(yamlValidatorPlugin);
  const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "yaml_validate");
  if (tool === undefined) throw new Error("YAML validator tool was not registered");
  return { context, cwd, tool };
}

describe("YAML validator boundaries", () => {
  test("uses the native workspace and rejects a result after an in-place session change", async () => {
    const { context, cwd, tool } = await createValidator();
    const active = join(cwd, "active");
    await mkdir(active);
    await writeFile(join(active, "current.yml"), "name: current\n");
    const session = { sessionId: "first", sessionManager: { getCwd: () => active } };
    context.provide("piRuntime", { session } as never);
    try {
      await expect(tool.execute("current", { path: "current.yml" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { valid: true } });
      const pending = tool.execute("stale", { path: "current.yml" }, undefined, undefined, {} as never);
      session.sessionId = "second";
      await expect(pending).rejects.toThrow(/workspace changed/iu);
      await expect(context.piPluginUi.snapshot()).resolves.toMatchObject([{ data: { latest: null, status: { state: "idle" } } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("reports unresolved aliases without expanding valid recursive references", async () => {
    const { context, cwd, tool } = await createValidator();
    try {
      await writeFile(join(cwd, "missing.yml"), "value: *missing\n");
      await expect(tool.execute("missing", { path: "missing.yml" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { valid: false, errorCount: 1, errors: [{ code: "BAD_ALIAS", line: 1, column: 8 }] },
      });
      await writeFile(join(cwd, "recursive.yml"), "value: &value [*value]\n");
      await expect(tool.execute("recursive", { path: "recursive.yml" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { valid: true },
      });
      await writeFile(join(cwd, "stream.yml"), "value: &value one\n---\nvalue: *value\n");
      await expect(tool.execute("stream", { path: "stream.yml" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { valid: false, documents: 2, errors: [{ code: "BAD_ALIAS", line: 3 }] },
      });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("includes warning evidence in model-visible output", async () => {
    const { context, cwd, tool } = await createValidator();
    try {
      await writeFile(join(cwd, "warning.yml"), "name: !unknown value\n");
      const result = await tool.execute("warning", { path: "warning.yml" }, undefined, undefined, {} as never);
      const content = result.content[0];
      if (content?.type !== "text") throw new Error("Expected text");
      expect(content.text).toContain("TAG_RESOLVE_FAILED");
      expect(result.details).toMatchObject({ valid: true, warningCount: 1 });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects unknown plugin configuration before activation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-yaml-config-"));
    temporaryDirectories.push(cwd);
    const context = new Context();
    provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", new PiPluginUiRegistry());
    let error: unknown;
    try {
      await context.plugin(yamlValidatorPlugin, { unexpected: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/unknown config keys/iu);
    await context.fiber.dispose();
  });

  test("declares bounded path input and validates descriptor-only parameters", async () => {
    const { context, tool } = await createValidator();
    let accessed = false;
    const params = {} as { path?: string };
    Object.defineProperty(params, "path", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("YAML path getter executed");
      },
    });
    try {
      expect(tool.parameters).toMatchObject({ properties: { path: { type: "string", minLength: 1, maxLength: 4_096 } } });
      await expect(tool.execute("call-1", params, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(tool.execute("call-2", { path: "fixture.yml", unknown: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
      await expect(tool.execute("call-3", null, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*object/iu);
      await expect(tool.execute("call-4", { path: "x".repeat(4_097) }, undefined, undefined, {} as never)).rejects.toThrow(/path.*1-4096/iu);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("validates a regular UTF-8 YAML file", async () => {
    const { context, cwd, tool } = await createValidator();
    await writeFile(join(cwd, "valid.yml"), "name: pi-harness\nitems:\n  - one\n", "utf8");
    try {
      await expect(tool.execute("call-1", { path: "valid.yml" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { path: "valid.yml", valid: true, bytes: 32, documents: 1, rootType: "map", errors: [], warnings: [] },
      });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects YAML files that are not valid UTF-8", async () => {
    const { context, cwd, tool } = await createValidator();
    await writeFile(join(cwd, "invalid-utf8.yml"), Buffer.from([0xc3, 0x28]));
    try {
      await expect(tool.execute("call-1", { path: "invalid-utf8.yml" }, undefined, undefined, {} as never)).rejects.toThrow(/valid UTF-8/iu);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("does not read a YAML file when validation is already cancelled", async () => {
    const { context, cwd, tool } = await createValidator();
    await writeFile(join(cwd, "valid.yml"), "name: fixture\n", "utf8");
    const caller = new AbortController();
    caller.abort(new Error("cancel YAML validation"));
    try {
      await expect(tool.execute("call-1", { path: "valid.yml" }, caller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
      await expect(context.piPluginUi.snapshot()).resolves.toMatchObject([{ data: { latest: null } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("rejects YAML streams above the document limit", async () => {
    const { context, cwd, tool } = await createValidator();
    await writeFile(join(cwd, "many-documents.yml"), "---\nname: fixture\n".repeat(101), "utf8");
    try {
      await expect(tool.execute("call-1", { path: "many-documents.yml" }, undefined, undefined, {} as never)).rejects.toThrow(/cannot exceed 100 documents/iu);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("bounds retained diagnostics while reporting complete error counts", async () => {
    const { context, cwd, tool } = await createValidator();
    await writeFile(join(cwd, "many-errors.yml"), "duplicate: true\n".repeat(1_102), "utf8");
    try {
      const result = await tool.execute("call-1", { path: "many-errors.yml" }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ valid: false, errorCount: 1_101, warningCount: 0, diagnosticsTruncated: true });
      expect((result.details as { errors: unknown[] }).errors).toHaveLength(1_000);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      if (content?.type !== "text") throw new Error("Expected YAML validation text output");
      expect(content.text).toMatch(/1101 error/iu);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("publishes bounded panel diagnostics with explicit inventory metadata", async () => {
    const { context, cwd, tool } = await createValidator();
    await writeFile(join(cwd, "panel-errors.yml"), "duplicate: true\n".repeat(102), "utf8");
    try {
      await tool.execute("call-1", { path: "panel-errors.yml" }, undefined, undefined, {} as never);

      const panel = (await context.piPluginUi.snapshot())[0];
      expect((panel?.data as { latest: { errors: unknown[] } }).latest.errors).toHaveLength(50);
      expect(panel?.data).toMatchObject({
        inventory: {
          errors: { total: 101, shown: 50, truncated: true },
          warnings: { total: 0, shown: 0, truncated: false },
        },
        limits: {
          fileBytes: 512 * 1024,
          pathCharacters: 4_096,
          documents: 100,
          diagnostics: 1_000,
          panelDiagnostics: 50,
          toolDiagnostics: 50,
          diagnosticMessageCharacters: 2_000,
        },
      });
    } finally {
      await context.fiber.dispose();
    }
  });

  test("does not expose mutable validation state through tool results or panel snapshots", async () => {
    const { context, cwd, tool } = await createValidator();
    await writeFile(join(cwd, "invalid.yml"), "name: [broken\n", "utf8");
    try {
      const result = await tool.execute("call-1", { path: "invalid.yml" }, undefined, undefined, {} as never);
      (result.details as { path: string }).path = "mutated.yml";
      (result.details as { errors: Array<{ message: string }> }).errors[0]!.message = "mutated";

      const firstPanel = (await context.piPluginUi.snapshot())[0];
      expect(firstPanel?.data).toMatchObject({ latest: { path: "invalid.yml" } });
      expect((firstPanel?.data as { latest: { errors: Array<{ message: string }> } }).latest.errors[0]?.message).not.toBe("mutated");
      (firstPanel?.data as { latest: { path: string } }).latest.path = "panel-mutated.yml";

      await expect(context.piPluginUi.snapshot()).resolves.toMatchObject([{ data: { latest: { path: "invalid.yml" } } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("publishes bounded failure status without replacing the last successful report", async () => {
    const { context, cwd, tool } = await createValidator();
    await writeFile(join(cwd, "valid.yml"), "name: fixture\n", "utf8");
    try {
      await tool.execute("call-1", { path: "valid.yml" }, undefined, undefined, {} as never);
      await expect(tool.execute("call-2", { path: "missing.yml" }, undefined, undefined, {} as never)).rejects.toThrow();

      const panel = (await context.piPluginUi.snapshot())[0];
      expect(panel?.data).toMatchObject({ latest: { path: "valid.yml", valid: true }, status: { state: "failed" } });
      const error = (panel?.data as { status: { error: string } }).status.error;
      expect(error.length).toBeGreaterThan(0);
      expect(error.length).toBeLessThanOrEqual(2_000);
    } finally {
      await context.fiber.dispose();
    }
  });
});
