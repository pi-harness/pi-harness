import { describe, expect, test, vi } from "vitest";
import { PiPluginUiRegistry } from "../src/services.js";

describe("plugin panel failure isolation", () => {
  test.each([false, true])("isolates a visibility failure (async=%s)", async (asynchronous) => {
    const registry = new PiPluginUiRegistry();
    let failedReads = 0;
    registry.register({
      id: "broken",
      pluginId: "broken-plugin",
      title: "Broken panel",
      visible: () => {
        if (asynchronous) return Promise.reject(new Error("Visibility unavailable"));
        throw new Error("Visibility unavailable");
      },
      read: () => {
        failedReads++;
        return { private: "must not be read" };
      },
    });
    registry.register({
      id: "hidden",
      pluginId: "hidden-plugin",
      title: "Hidden",
      visible: () => false,
      read: () => {
        throw new Error("Hidden panel must not be read");
      },
    });
    registry.register({ id: "healthy", pluginId: "healthy-plugin", title: "Healthy", read: () => ({ ready: true }) });
    await expect(registry.snapshot()).resolves.toEqual([
      { id: "broken", pluginId: "broken-plugin", title: "Broken panel", error: "Visibility unavailable" },
      { id: "healthy", pluginId: "healthy-plugin", title: "Healthy", data: { ready: true } },
    ]);
    expect(failedReads).toBe(0);
  });

  test("bounds a stalled panel, keeps healthy panels available, and reuses the in-flight read", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PiPluginUiRegistry();
      let stalledReads = 0;
      let readSignal: AbortSignal | undefined;
      registry.register({
        id: "stalled",
        pluginId: "stalled-plugin",
        title: "Stalled panel",
        read: (signal?: AbortSignal) => {
          stalledReads += 1;
          readSignal = signal;
          return new Promise(() => undefined);
        },
      });
      registry.register({ id: "healthy", pluginId: "healthy-plugin", title: "Healthy", read: () => ({ ready: true }) });

      const first = registry.snapshot();
      const overlapping = registry.snapshot();
      let firstResult: Awaited<typeof first> | undefined;
      let overlappingResult: Awaited<typeof overlapping> | undefined;
      void first.then((value) => {
        firstResult = value;
      });
      void overlapping.then((value) => {
        overlappingResult = value;
      });
      await vi.advanceTimersByTimeAsync(2_000);

      const expected = [
        { id: "stalled", pluginId: "stalled-plugin", title: "Stalled panel", error: "Plugin UI panel timed out after 2000 ms" },
        { id: "healthy", pluginId: "healthy-plugin", title: "Healthy", data: { ready: true } },
      ];
      expect(firstResult).toEqual(expected);
      expect(overlappingResult).toEqual(expected);
      expect(stalledReads).toBe(1);
      expect(readSignal?.aborted).toBe(true);

      let repeatedResult: Awaited<ReturnType<PiPluginUiRegistry["snapshot"]>> | undefined;
      void registry.snapshot().then((value) => {
        repeatedResult = value;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(repeatedResult).toEqual(expected);
      expect(stalledReads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds stalled visibility without reading private panel data", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PiPluginUiRegistry();
      let visibilitySignal: AbortSignal | undefined;
      let reads = 0;
      registry.register({
        id: "stalled-visibility",
        pluginId: "stalled-plugin",
        title: "Stalled visibility",
        visible: (signal?: AbortSignal) => {
          visibilitySignal = signal;
          return new Promise(() => undefined);
        },
        read: () => {
          reads += 1;
          return { private: true };
        },
      });

      const snapshot = registry.snapshot();
      let result: Awaited<typeof snapshot> | undefined;
      void snapshot.then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(result).toEqual([
        {
          id: "stalled-visibility",
          pluginId: "stalled-plugin",
          title: "Stalled visibility",
          error: "Plugin UI panel timed out after 2000 ms",
        },
      ]);
      expect(visibilitySignal?.aborted).toBe(true);
      expect(reads).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps a shared timeout terminal when an abort-ignoring read finishes late", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PiPluginUiRegistry();
      let finishRead: ((value: unknown) => void) | undefined;
      registry.register({
        id: "late",
        pluginId: "late-plugin",
        title: "Late panel",
        read: () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      });

      const first = registry.snapshot();
      await vi.advanceTimersByTimeAsync(1_500);
      const overlapping = registry.snapshot();
      await vi.advanceTimersByTimeAsync(500);

      await expect(first).resolves.toEqual([{ id: "late", pluginId: "late-plugin", title: "Late panel", error: "Plugin UI panel timed out after 2000 ms" }]);
      finishRead?.({ stale: true });
      await vi.advanceTimersByTimeAsync(0);
      await expect(overlapping).resolves.toEqual([
        { id: "late", pluginId: "late-plugin", title: "Late panel", error: "Plugin UI panel timed out after 2000 ms" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("aborts and forgets pending work when a panel is unregistered", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PiPluginUiRegistry();
      let reads = 0;
      let firstSignal: AbortSignal | undefined;
      const panel = {
        id: "reloadable",
        pluginId: "reloadable-plugin",
        title: "Reloadable panel",
        read: (signal?: AbortSignal) => {
          reads += 1;
          if (reads === 1) {
            firstSignal = signal;
            return new Promise(() => undefined);
          }
          return { generation: reads };
        },
      };
      const unregister = registry.register(panel);
      void registry.snapshot();

      unregister();
      registry.register(panel);
      const reloaded = registry.snapshot();
      await vi.advanceTimersByTimeAsync(0);

      expect(firstSignal?.aborted).toBe(true);
      expect(reads).toBe(2);
      await expect(reloaded).resolves.toEqual([{ id: "reloadable", pluginId: "reloadable-plugin", title: "Reloadable panel", data: { generation: 2 } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not read panel data when stalled visibility finishes after timeout", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PiPluginUiRegistry();
      let finishVisibility: ((visible: boolean) => void) | undefined;
      let reads = 0;
      registry.register({
        id: "late-visibility",
        pluginId: "late-plugin",
        title: "Late visibility",
        visible: () =>
          new Promise((resolve) => {
            finishVisibility = resolve;
          }),
        read: () => {
          reads += 1;
          return { private: true };
        },
      });

      const snapshot = registry.snapshot();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(snapshot).resolves.toEqual([
        { id: "late-visibility", pluginId: "late-plugin", title: "Late visibility", error: "Plugin UI panel timed out after 2000 ms" },
      ]);
      finishVisibility?.(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(reads).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("isolates a rejection that cannot be converted to a string", async () => {
    const registry = new PiPluginUiRegistry();
    registry.register({
      id: "hostile-error",
      pluginId: "hostile-plugin",
      title: "Hostile error",
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- plugins can reject with arbitrary foreign values
      read: () => Promise.reject(Object.create(null)),
    });
    registry.register({ id: "healthy", pluginId: "healthy-plugin", title: "Healthy", read: () => ({ ready: true }) });

    await expect(registry.snapshot()).resolves.toEqual([
      { id: "hostile-error", pluginId: "hostile-plugin", title: "Hostile error", error: "Unknown plugin panel error" },
      { id: "healthy", pluginId: "healthy-plugin", title: "Healthy", data: { ready: true } },
    ]);
  });

  test("reports a synchronous callback that returns after the panel budget", async () => {
    let elapsedMs = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    try {
      const registry = new PiPluginUiRegistry();
      registry.register({
        id: "blocking",
        pluginId: "blocking-plugin",
        title: "Blocking panel",
        read: () => {
          elapsedMs = 2_001;
          return { late: true };
        },
      });

      await expect(registry.snapshot()).resolves.toEqual([
        { id: "blocking", pluginId: "blocking-plugin", title: "Blocking panel", error: "Plugin UI panel timed out after 2000 ms" },
      ]);
    } finally {
      now.mockRestore();
    }
  });
});
