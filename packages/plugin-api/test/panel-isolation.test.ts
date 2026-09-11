import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry } from "../src/services.js";

describe("plugin panel failure isolation", () => {
  test.each([false, true])("isolates a visibility failure (async=%s)", async (asynchronous) => {
    const registry = new PiPluginUiRegistry();
    let failedReads = 0;
    registry.register({
      id: "broken", pluginId: "broken-plugin", title: "Broken panel",
      visible: () => {
        if (asynchronous) return Promise.reject(new Error("Visibility unavailable"));
        throw new Error("Visibility unavailable");
      },
      read: () => { failedReads++; return { private: "must not be read" }; },
    });
    registry.register({ id: "hidden", pluginId: "hidden-plugin", title: "Hidden", visible: () => false,
      read: () => { throw new Error("Hidden panel must not be read"); } });
    registry.register({ id: "healthy", pluginId: "healthy-plugin", title: "Healthy", read: () => ({ ready: true }) });
    await expect(registry.snapshot()).resolves.toEqual([
      { id: "broken", pluginId: "broken-plugin", title: "Broken panel", error: "Visibility unavailable" },
      { id: "healthy", pluginId: "healthy-plugin", title: "Healthy", data: { ready: true } },
    ]);
    expect(failedReads).toBe(0);
  });
});
