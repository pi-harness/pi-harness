import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { checkCoreUpdate, formatCoreUpdateNotice } from "../src/update-check.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

function registryServer(body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    });
    servers.push(server);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("server did not bind to a TCP port"));
      resolve(`http://127.0.0.1:${address.port}/@pi-harness%2Fcore/latest`);
    });
  });
}

describe("core update check", () => {
  test("returns a newer compatible release from the registry", async () => {
    const registryUrl = await registryServer({ version: "0.1.15" });

    await expect(checkCoreUpdate("0.1.14", { registryUrl })).resolves.toEqual({ currentVersion: "0.1.14", latestVersion: "0.1.15" });
  });

  test("ignores releases outside the current minor line", async () => {
    const registryUrl = await registryServer({ version: "0.2.0" });

    await expect(checkCoreUpdate("0.1.14", { registryUrl })).resolves.toBeUndefined();
  });

  test("ignores registry failures and malformed responses", async () => {
    const registryUrl = await registryServer({ nope: true });

    await expect(checkCoreUpdate("0.1.14", { registryUrl, timeoutMs: 100 })).resolves.toBeUndefined();
    await expect(checkCoreUpdate("0.1.14", { registryUrl: "http://127.0.0.1:1/unreachable", timeoutMs: 100 })).resolves.toBeUndefined();
  });

  test("formats a concise actionable notice", () => {
    expect(formatCoreUpdateNotice({ currentVersion: "0.1.14", latestVersion: "0.1.15" })).toBe(
      "Pi Harness update available: @pi-harness/core 0.1.14 → 0.1.15. Run `npm update --global @pi-harness/pi-harness` to install it.\n",
    );
  });
});
