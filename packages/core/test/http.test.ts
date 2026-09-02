import { describe, expect, test } from "vitest";
import { configureHttpProxy } from "../src/http.js";

function globalDispatcherNames(): string[] {
  return Object.getOwnPropertySymbols(globalThis)
    .filter((symbol) => String(symbol).includes("undici.globalDispatcher"))
    .map((symbol) => (globalThis as unknown as Record<symbol, { constructor?: { name?: string } }>)[symbol]?.constructor?.name ?? "unknown");
}

describe("configureHttpProxy", () => {
  test("installs Pi's proxy-aware dispatcher so provider calls honour HTTP(S)_PROXY", async () => {
    await expect(configureHttpProxy()).resolves.toBeUndefined();

    expect(globalDispatcherNames()).toContain("EnvHttpProxyAgent");
  });

  test("applies the httpProxy setting to the environment Pi's dispatcher reads", async () => {
    const previousHttp = process.env.HTTP_PROXY;
    const previousHttps = process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    const services = { settingsManager: { getGlobalSettings: () => ({ httpProxy: "http://127.0.0.1:9999" }), getHttpIdleTimeoutMs: () => 30_000 } };

    try {
      await expect(configureHttpProxy(services as never)).resolves.toBeUndefined();

      expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:9999");
      expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:9999");
    } finally {
      if (previousHttp === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previousHttp;
      if (previousHttps === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previousHttps;
    }
  });
});
