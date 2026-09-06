import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TimerService } from "@deepseek-ai/cordis-plugin-timer";
import { bootHarness, type BootedHarness } from "../src/boot.js";

const booted: BootedHarness[] = [];
const timerEntry = import.meta.resolve("@deepseek-ai/cordis-plugin-timer");

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(booted.splice(0).map(async (harness) => harness.dispose()));
  vi.restoreAllMocks();
});

async function bootTimer(): Promise<{ harness: BootedHarness; timer: TimerService }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-harness-timer-"));
  const profilePath = join(directory, "cordis.yml");
  await writeFile(profilePath, JSON.stringify([{ id: "timer", name: timerEntry, config: {} }]), "utf8");
  const harness = await bootHarness({ configPath: profilePath });
  booted.push(harness);
  const timer = harness.context.get("timer");
  if (timer === undefined) throw new Error("Timer service was not registered");
  return { harness, timer };
}

function thrownBy(callback: () => unknown): unknown {
  try {
    const result = callback();
    if (result instanceof Promise) void result.catch(() => {});
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectThrownMessage(callback: () => unknown, pattern: RegExp): void {
  const error = thrownBy(callback);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(pattern);
}

describe("Cordis timer integration", () => {
  test("uses the hardened timer adapter for runtime-loaded marketplace entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-dynamic-timer-"));
    const profilePath = join(directory, "cordis.yml");
    await writeFile(profilePath, "[]", "utf8");
    const harness = await bootHarness({ configPath: profilePath });
    booted.push(harness);

    await harness.context.loader.create({ name: "@deepseek-ai/cordis-plugin-timer", config: {} });
    const timer = harness.context.get("timer");

    expect(timer).toBeDefined();
    expect(() => timer?.interval(() => {}, 0)).toThrow(/timer delay/iu);
  });

  test.each([
    ["timeout", (timer: TimerService) => timer.timeout(() => {}, -1)],
    ["fractional timeout", (timer: TimerService) => timer.timeout(() => {}, 1.5)],
    ["oversized timeout", (timer: TimerService) => timer.timeout(() => {}, 2_147_483_648)],
    ["interval", (timer: TimerService) => timer.interval(() => {}, 0)],
    ["negative interval", (timer: TimerService) => timer.interval(() => {}, -1)],
    ["throttle", (timer: TimerService) => timer.throttle(() => {}, Number.NaN)],
    ["zero-delay throttle", (timer: TimerService) => timer.throttle(() => {}, 0)],
    ["debounce", (timer: TimerService) => timer.debounce(() => {}, 2_147_483_648)],
  ])("rejects unsafe %s delays before scheduling", async (_label, invoke) => {
    const { timer } = await bootTimer();

    expect(() => invoke(timer)).toThrow(/timer delay/iu);
  });

  test("rejects malformed callbacks and throttle options", async () => {
    const { timer } = await bootTimer();

    expectThrownMessage(() => (timer.timeout as unknown as (callback: unknown, delay: number) => unknown)(null, 10), /callback/iu);
    expectThrownMessage(() => (timer.interval as unknown as (callback: unknown, delay: number) => unknown)("callback", 10), /callback/iu);
    expectThrownMessage(() => (timer.throttle as unknown as (callback: unknown, delay: number) => unknown)(null, 10), /callback/iu);
    expectThrownMessage(() => (timer.debounce as unknown as (callback: unknown, delay: number) => unknown)(null, 10), /callback/iu);
    expectThrownMessage(
      () => (timer.throttle as unknown as (callback: () => void, delay: number, noTrailing: unknown) => unknown)(() => {}, 10, "yes"),
      /noTrailing/iu,
    );
  });

  test("does not execute a throttled callback after its disposer runs", async () => {
    const { timer } = await bootTimer();
    vi.useFakeTimers();
    const callback = vi.fn();
    const throttled = timer.throttle(callback, 100);
    throttled("first");
    expect(callback).toHaveBeenCalledOnce();

    throttled.dispose();
    await vi.advanceTimersByTimeAsync(100);
    throttled("after-dispose");

    expect(callback).toHaveBeenCalledOnce();
  });

  test("rejects concurrent async-iterator next calls instead of orphaning one", async () => {
    const { timer } = await bootTimer();
    vi.useFakeTimers();
    const iterator = timer.interval(100);
    const first = iterator.next();
    const second = iterator.next();
    const secondAssertion = expect(second).rejects.toThrow(/concurrent.*next/iu);

    await vi.advanceTimersByTimeAsync(100);

    await secondAssertion;
    await expect(first).resolves.toEqual({ done: false, value: undefined });
    await iterator.return?.();
  });

  test("rejects a pending timeout promise when its owning context is disposed", async () => {
    const { harness, timer } = await bootTimer();
    vi.useFakeTimers();
    const pending = timer.timeout(1_000);
    const outcome = pending.catch((error: unknown) => error);

    booted.splice(booted.indexOf(harness), 1);
    await harness.dispose();

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/disposed/iu);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("runs timeout and interval callbacks and honors explicit disposers", async () => {
    const { timer } = await bootTimer();
    vi.useFakeTimers();
    const timeoutCallback = vi.fn();
    const intervalCallback = vi.fn();
    timer.timeout(timeoutCallback, 25);
    const disposeInterval = timer.interval(intervalCallback, 10);

    await vi.advanceTimersByTimeAsync(25);
    disposeInterval();
    await vi.advanceTimersByTimeAsync(25);

    expect(timeoutCallback).toHaveBeenCalledOnce();
    expect(intervalCallback).toHaveBeenCalledTimes(2);
  });
});
