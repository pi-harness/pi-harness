import TimerService from "@deepseek-ai/cordis-plugin-timer";

type DisposableFunction<F> = F & { dispose: () => void };

const maximumTimerDelay = 2_147_483_647;

function assertTimerDelay(operation: string, value: unknown, allowZero: boolean): asserts value is number {
  const minimum = allowZero ? 0 : 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximumTimerDelay)
    throw new RangeError(`Timer delay for ${operation} must be an integer from ${minimum} to ${maximumTimerDelay} milliseconds`);
}

function assertCallback(operation: string, value: unknown): asserts value is (...args: unknown[]) => void {
  if (typeof value !== "function") throw new TypeError(`Timer callback for ${operation} must be a function`);
}

function guardedIntervalIterator(iterator: AsyncIterableIterator<void, unknown, void>): AsyncIterableIterator<void, unknown, void> {
  let nextPending = false;
  return {
    next() {
      if (nextPending) return Promise.reject(new Error("Concurrent timer interval next() calls are not supported"));
      nextPending = true;
      return iterator.next().finally(() => {
        nextPending = false;
      });
    },
    return(value) {
      return iterator.return?.(value) ?? Promise.resolve({ done: true, value });
    },
    throw(reason) {
      return iterator.throw?.(reason) ?? Promise.reject(reason instanceof Error ? reason : new Error("Timer interval iterator failed", { cause: reason }));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/** Host-hardened adapter for the vendored Cordis timer service. */
export default class HardenedTimerService extends TimerService {
  override timeout(callback: () => void, delay: number): () => void;
  override timeout(delay: number): Promise<void>;
  override timeout(...args: unknown[]): unknown {
    if (args.length === 1) {
      assertTimerDelay("timeout", args[0], true);
      return super.timeout(args[0]);
    }
    if (args.length !== 2) throw new TypeError("Timer timeout requires a delay or a callback and delay");
    assertCallback("timeout", args[0]);
    assertTimerDelay("timeout", args[1], true);
    return super.timeout(args[0], args[1]);
  }

  override interval(callback: () => void, delay: number): () => void;
  override interval<R = unknown>(delay: number): AsyncIterableIterator<void, R, void>;
  override interval(...args: unknown[]): unknown {
    if (args.length === 1) {
      assertTimerDelay("interval", args[0], false);
      return guardedIntervalIterator(super.interval(args[0]));
    }
    if (args.length !== 2) throw new TypeError("Timer interval requires a delay or a callback and delay");
    assertCallback("interval", args[0]);
    assertTimerDelay("interval", args[1], false);
    return super.interval(args[0], args[1]);
  }

  override throttle<F extends (...args: never[]) => void>(callback: F, delay: number, noTrailing?: boolean): DisposableFunction<F> {
    assertCallback("throttle", callback);
    assertTimerDelay("throttle", delay, false);
    if (noTrailing !== undefined && typeof noTrailing !== "boolean") throw new TypeError("Timer throttle noTrailing must be a boolean");
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastCall = -Infinity;
    const execute = (args: unknown[]): void => {
      if (disposed) return;
      lastCall = Date.now();
      callback(...(args as never[]));
    };
    const dispose = this.ctx.effect(
      () => () => {
        disposed = true;
        clearTimeout(timer);
        timer = undefined;
      },
      "ctx.throttle()",
    );
    const wrapper = ((...args: unknown[]) => {
      if (disposed) return;
      clearTimeout(timer);
      timer = undefined;
      const remaining = delay - Date.now() + lastCall;
      if (remaining <= 0) execute(args);
      else if (!noTrailing)
        timer = setTimeout(() => {
          timer = undefined;
          execute(args);
        }, remaining);
    }) as unknown as F;
    return Object.assign(wrapper, { dispose });
  }

  override debounce<F extends (...args: never[]) => void>(callback: F, delay: number): DisposableFunction<F> {
    assertCallback("debounce", callback);
    assertTimerDelay("debounce", delay, false);
    return super.debounce(callback, delay);
  }
}
