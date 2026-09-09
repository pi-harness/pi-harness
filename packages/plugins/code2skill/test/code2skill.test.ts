import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { parse } from "yaml";
import { describe, expect, test, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import code2SkillPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

// Hold the real manifest write after it completes so interruption before directory publication is deterministic.
const fsHooks = vi.hoisted(() => ({ afterManifest: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const writeFile: typeof actual.writeFile = async (...args) => {
    await actual.writeFile(...args);
    if (typeof args[0] === "string" && args[0].endsWith("/SKILL.md")) await fsHooks.afterManifest?.();
  };
  return { ...actual, writeFile };
});

async function createCode2Skill(): Promise<{
  context: Context;
  cwd: string;
  panels: PiPluginUiRegistry;
  root: string;
  tool: ReturnType<PiToolRegistry["snapshot"]>["customTools"][number];
  tools: PiToolRegistry;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-code2skill-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const context = new Context();
  const panels = new PiPluginUiRegistry();
  const tools = new PiToolRegistry();
  provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(code2SkillPlugin);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "skill_pack_create");
  if (tool === undefined) throw new Error("skill_pack_create was not registered");
  return { context, cwd, panels, root, tool, tools };
}

async function dispose(fixture: Awaited<ReturnType<typeof createCode2Skill>>): Promise<void> {
  await fixture.context.fiber.dispose();
  await rm(fixture.root, { recursive: true, force: true });
}

describe("code2skill", () => {
  test("declares complete skill input bounds", async () => {
    const fixture = await createCode2Skill();
    try {
      expect(fixture.tool.parameters).toMatchObject({
        properties: {
          name: { type: "string", minLength: 1, maxLength: 128 },
          description: { type: "string", minLength: 1, maxLength: 1_024 },
          files: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 4_096 } },
        },
      });
    } finally {
      await dispose(fixture);
    }
  });

  test("rejects accessor parameters without invoking them", async () => {
    const fixture = await createCode2Skill();
    let accessed = false;
    const params = { description: "Safe description", files: ["source.ts"] } as { name?: string; description: string; files: string[] };
    Object.defineProperty(params, "name", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("skill name getter executed");
      },
    });
    try {
      await expect(fixture.tool.execute("accessor", params, undefined, undefined, {} as never)).rejects.toThrow(/data properties/iu);
      expect(accessed).toBe(false);
    } finally {
      await dispose(fixture);
    }
  });

  test("rejects unknown parameter keys before creating a skill", async () => {
    const fixture = await createCode2Skill();
    try {
      await writeFile(join(fixture.cwd, "source.ts"), "export {};\n", "utf8");

      await expect(
        fixture.tool.execute(
          "unknown",
          { name: "Unknown", description: "Must be rejected", files: ["source.ts"], unexpected: true },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/unknown property/iu);
      await expect(access(join(fixture.cwd, ".pi"))).rejects.toThrow();
    } finally {
      await dispose(fixture);
    }
  });

  test("rejects malformed parameters before creating an output directory", async () => {
    const fixture = await createCode2Skill();
    try {
      await writeFile(join(fixture.cwd, "source.ts"), "export {};\n", "utf8");
      const invalid: unknown[] = [
        null,
        { name: 7, description: "valid", files: ["source.ts"] },
        { name: " ", description: "valid", files: ["source.ts"] },
        { name: "x".repeat(129), description: "valid", files: ["source.ts"] },
        { name: "valid", description: 7, files: ["source.ts"] },
        { name: "valid", description: " ", files: ["source.ts"] },
        { name: "valid", description: "x".repeat(1_025), files: ["source.ts"] },
        { name: "valid", description: "valid", files: null },
        { name: "valid", description: "valid", files: [] },
        { name: "valid", description: "valid", files: Array.from({ length: 33 }, () => "source.ts") },
        { name: "valid", description: "valid", files: [7] },
        { name: "valid", description: "valid", files: ["x".repeat(4_097)] },
        { name: "valid", description: "valid", files: ["source\n.ts"] },
      ];
      for (const params of invalid) {
        await expect(fixture.tool.execute("invalid", params, undefined, undefined, {} as never)).rejects.toThrow(/skill|source|file|description|name/iu);
      }
      await expect(access(join(fixture.cwd, ".pi"))).rejects.toThrow();
    } finally {
      await dispose(fixture);
    }
  });

  test("writes valid YAML and safe Markdown for adversarial metadata and file names", async () => {
    const fixture = await createCode2Skill();
    try {
      const source = "docs/a](evil).ts";
      await mkdir(join(fixture.cwd, "docs"));
      await writeFile(join(fixture.cwd, source), "export {};\n", "utf8");
      const result = await fixture.tool.execute(
        "create",
        { name: "Parser\n# injected", description: "parse: safely\n---\n# not frontmatter", files: [source] },
        undefined,
        undefined,
        {} as never,
      );
      const details = result.details as { directory: string; slug: string };
      expect(details.directory).toBe(join(".pi", "skills", details.slug));
      const manifest = await readFile(join(fixture.cwd, details.directory, "SKILL.md"), "utf8");
      const frontmatter = manifest.match(/^---\n([\s\S]*?)\n---\n/u)?.[1];
      expect(frontmatter).toBeDefined();
      expect(parse(frontmatter!)).toEqual({ name: details.slug, description: "parse: safely --- # not frontmatter" });
      expect(manifest).toContain("- [docs/a\\](evil).ts](references/docs/a%5D%28evil%29.ts)");
    } finally {
      await dispose(fixture);
    }
  });

  test("accepts exact source limits and rejects the first byte over either limit", async () => {
    const fixture = await createCode2Skill();
    try {
      const exactFiles = Array.from({ length: 8 }, (_, index) => `exact-${index}.bin`);
      await Promise.all(exactFiles.map((file) => writeFile(join(fixture.cwd, file), Buffer.alloc(256 * 1024, 0x61))));
      const exact = await fixture.tool.execute(
        "exact",
        { name: "n".repeat(128), description: "d".repeat(1_024), files: exactFiles },
        undefined,
        undefined,
        {} as never,
      );
      const exactDetails = exact.details as { bytes: number; files: Array<{ bytes: number }> };
      expect(exactDetails.bytes).toBe(2 * 1024 * 1024);
      expect(exactDetails.files).toHaveLength(8);
      expect(exactDetails.files.every((file) => file.bytes === 256 * 1024)).toBe(true);

      await writeFile(join(fixture.cwd, "oversized.bin"), Buffer.alloc(256 * 1024 + 1, 0x62));
      await expect(
        fixture.tool.execute("file-over", { name: "File Over", description: "Must fail", files: ["oversized.bin"] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/262144-byte limit/iu);
      await writeFile(join(fixture.cwd, "one-more.bin"), Buffer.from("x"));
      await expect(
        fixture.tool.execute(
          "total-over",
          { name: "Total Over", description: "Must fail", files: [...exactFiles, "one-more.bin"] },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/2097152 bytes/iu);
      await expect(access(join(fixture.cwd, ".pi", "skills", "file-over"))).rejects.toThrow();
      await expect(access(join(fixture.cwd, ".pi", "skills", "total-over"))).rejects.toThrow();

      const emptyFiles = Array.from({ length: 32 }, (_, index) => `empty-${index}.txt`);
      await Promise.all(emptyFiles.map((file) => writeFile(join(fixture.cwd, file), "")));
      const counted = await fixture.tool.execute(
        "file-count",
        { name: "File Count", description: "Exact file count", files: emptyFiles },
        undefined,
        undefined,
        {} as never,
      );
      const countedFiles = (counted.details as { files: Array<{ bytes: number; path: string }> }).files;
      expect(countedFiles).toHaveLength(32);
      expect(countedFiles.at(-1)).toEqual({ path: "empty-31.txt", bytes: 0 });
    } finally {
      await dispose(fixture);
    }
  });

  test("serializes concurrent creation of the same complete skill", async () => {
    const fixture = await createCode2Skill();
    try {
      await writeFile(join(fixture.cwd, "source.ts"), "export {};\n", "utf8");
      const params = { name: "Concurrent", description: "Complete artifact", files: ["source.ts"] };
      const outcomes = await Promise.allSettled([
        fixture.tool.execute("first", params, undefined, undefined, {} as never),
        fixture.tool.execute("second", params, undefined, undefined, {} as never),
      ]);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      expect(String(failure?.reason)).toMatch(/already exists/iu);
      await expect(readFile(join(fixture.cwd, ".pi", "skills", "concurrent", "SKILL.md"), "utf8")).resolves.toContain("Complete artifact");
      await expect(readFile(join(fixture.cwd, ".pi", "skills", "concurrent", "references", "source.ts"), "utf8")).resolves.toBe("export {};\n");
      expect((await readdir(join(fixture.cwd, ".pi", "skills"))).filter((name) => name.startsWith(".code2skill-"))).toEqual([]);
    } finally {
      await dispose(fixture);
    }
  });

  test("honors caller cancellation without writing output", async () => {
    const fixture = await createCode2Skill();
    const controller = new AbortController();
    try {
      await writeFile(join(fixture.cwd, "source.ts"), "export {};\n", "utf8");
      controller.abort(new Error("caller cancelled skill creation"));
      await expect(
        fixture.tool.execute("cancel", { name: "Cancelled", description: "No output", files: ["source.ts"] }, controller.signal, undefined, {} as never),
      ).rejects.toThrow(/caller cancelled skill creation/iu);
      await expect(access(join(fixture.cwd, ".pi"))).rejects.toThrow();
    } finally {
      await dispose(fixture);
    }
  });

  test("isolates tool and panel reports and unregisters them on disposal", async () => {
    const fixture = await createCode2Skill();
    try {
      await writeFile(join(fixture.cwd, "source.ts"), "export {};\n", "utf8");
      const result = await fixture.tool.execute(
        "create",
        { name: "Isolated", description: "State remains internal", files: ["source.ts"] },
        undefined,
        undefined,
        {} as never,
      );
      (result.details as { files: Array<{ path: string }> }).files[0]!.path = "mutated";
      const [firstPanel] = await fixture.panels.snapshot();
      const latest = (firstPanel?.data as { latest: { files: Array<{ path: string }> } }).latest;
      expect(latest.files[0]?.path).toBe("source.ts");
      latest.files[0]!.path = "panel-mutated";
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { latest: { files: [{ path: "source.ts" }] } } }]);
      const retained = fixture.tool;

      await fixture.context.fiber.dispose();

      expect(fixture.tools.snapshot().customTools).toEqual([]);
      await expect(fixture.panels.snapshot()).resolves.toEqual([]);
      await expect(
        retained.execute("stale", { name: "Stale", description: "No output", files: ["source.ts"] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/disposed/iu);
    } finally {
      await dispose(fixture);
    }
  });
});

test("creates packs in the current native workspace and invalidates queued work on session changes", async () => {
  const fixture = await createCode2Skill();
  const active = join(fixture.root, "active");
  let id = "initial";
  let session = { sessionId: id, sessionManager: { getCwd: () => fixture.cwd } };
  try {
    await mkdir(active);
    await writeFile(join(fixture.cwd, "source.ts"), "launch source");
    await writeFile(join(active, "source.ts"), "active source");
    fixture.context.provide("piRuntime", {
      get session() {
        return session;
      },
    } as never);
    const params = { name: "Native", description: "Native workspace", files: ["source.ts"] };
    await fixture.tool.execute("initial", params, undefined, undefined, {} as never);
    session = {
      get sessionId() {
        return id;
      },
      sessionManager: { getCwd: () => active },
    };
    await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { generated: 0, latest: null } }]);
    await fixture.tool.execute("active", params, undefined, undefined, {} as never);
    expect(await readFile(join(active, ".pi/skills/native/references/source.ts"), "utf8")).toBe("active source");
    expect(await readFile(join(fixture.cwd, ".pi/skills/native/references/source.ts"), "utf8")).toBe("launch source");
    await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { generated: 1, latest: { slug: "native" } } }]);
    const first = fixture.tool.execute("first-queued", { ...params, name: "Old One" }, undefined, undefined, {} as never);
    const second = fixture.tool.execute("second-queued", { ...params, name: "Old Two" }, undefined, undefined, {} as never);
    id = "replacement";
    await expect(first).rejects.toThrow(/workspace changed/iu);
    await expect(second).rejects.toThrow(/workspace changed/iu);
    await expect(access(join(active, ".pi/skills/old-one"))).rejects.toThrow();
    await expect(access(join(active, ".pi/skills/old-two"))).rejects.toThrow();
    await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { generated: 0, latest: null } }]);
  } finally {
    await dispose(fixture);
  }
});

test.each(["switch", "cancel", "dispose"])("removes staged files when %s interrupts before publication", async (kind) => {
  const fixture = await createCode2Skill();
  let id = "initial";
  fixture.context.provide("piRuntime", {
    session: {
      get sessionId() {
        return id;
      },
      sessionManager: { getCwd: () => fixture.cwd },
    },
  } as never);
  let reached!: () => void, release!: () => void;
  const manifestWritten = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  try {
    await writeFile(join(fixture.cwd, "source.ts"), "original");
    fsHooks.afterManifest = async () => {
      reached();
      await held;
    };
    const pending = fixture.tool.execute(
      "held",
      { name: "Interrupted", description: "Never published", files: ["source.ts"] },
      controller.signal,
      undefined,
      {} as never,
    );
    const outcome = pending.then(
      () => "unexpected success",
      (error: unknown) => String(error),
    );
    await manifestWritten;
    if (kind === "switch") id = "replacement";
    else if (kind === "cancel") controller.abort(new Error("caller cancelled"));
    else await fixture.context.fiber.dispose();
    release();
    expect(await outcome).toMatch(/workspace changed|cancelled|disposed/iu);
    expect(await readdir(join(fixture.cwd, ".pi/skills"))).toEqual([]);
    expect(await readFile(join(fixture.cwd, "source.ts"), "utf8")).toBe("original");
    if (kind !== "dispose") await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { generated: 0, latest: null } }]);
  } finally {
    fsHooks.afterManifest = undefined;
    release();
    await dispose(fixture);
  }
});
