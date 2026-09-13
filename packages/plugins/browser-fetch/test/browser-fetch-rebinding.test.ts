import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { beforeEach, describe, expect, test, vi } from "vitest";
import browserFetchPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const lookup = vi.hoisted(() => vi.fn(() => Promise.resolve([{ address: "1.1.1.1", family: 4 as const }])));

vi.mock("node:dns/promises", async (importOriginal) => ({ ...(await importOriginal()), lookup }));

describe("browser-fetch DNS pinning", () => {
  beforeEach(() => {
    lookup.mockReset();
    lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
  });

  test("does not reconnect to an address that was not validated", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-browser-fetch-rebinding-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("private data");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Browser fetch rebinding test server did not bind to a port");
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(browserFetchPlugin, { timeoutMs: 100 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "browser_fetch");
      if (tool === undefined) throw new Error("browser_fetch was not registered");

      await expect(tool.execute("fetch", { url: `http://localhost:${address.port}/secret` }, undefined, undefined, {} as never)).rejects.toThrow();
      expect(lookup).toHaveBeenCalledWith("localhost", { all: true, verbatim: true });
      expect(requests).toBe(0);
    } finally {
      await context.fiber.dispose();
      await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
      await rm(root, { recursive: true, force: true });
    }
  });

  test("applies the request timeout while DNS resolution is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-browser-fetch-dns-timeout-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    let resolveLookup!: (addresses: Array<{ address: string; family: 4 }>) => void;
    const pendingLookup = new Promise<Array<{ address: string; family: 4 }>>((resolve) => {
      resolveLookup = resolve;
    });
    lookup.mockImplementationOnce(() => pendingLookup);
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let execution: Promise<unknown> | undefined;
    try {
      provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
      context.provide("piTools", tools);
      context.provide("piPluginUi", new PiPluginUiRegistry());
      await context.plugin(browserFetchPlugin, { timeoutMs: 100 });
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "browser_fetch");
      if (tool === undefined) throw new Error("browser_fetch was not registered");

      execution = tool.execute("fetch", { url: "https://example.com/" }, undefined, undefined, {} as never);
      const outcome = await Promise.race([
        execution.then(
          () => new Error("Browser fetch unexpectedly succeeded"),
          (error: unknown) => error,
        ),
        new Promise<string>((resolve) => {
          fallback = setTimeout(() => resolve("DNS lookup remained pending"), 500);
        }),
      ]);

      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome)).toMatch(/timed out after 100 ms/iu);
    } finally {
      if (fallback !== undefined) clearTimeout(fallback);
      resolveLookup([{ address: "1.1.1.1", family: 4 }]);
      await context.fiber.dispose();
      await execution?.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
