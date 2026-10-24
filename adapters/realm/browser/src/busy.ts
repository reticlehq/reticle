import { RETICLE_BUSY_SIGNAL } from '@reticlehq/core';
import { captureMethod } from '@/patching/capture-method.js';

/**
 * Work only the app can see (a debounced save, a worker, a socket reply), announced as it starts and
 * ends so a wait for the page to settle holds until it is done (`settled` counts it like a request).
 * Returns `work` untouched: the caller still owns its result and its rejection.
 */
export function trackBusy<T>(
  work: Promise<T>,
  signal: (name: string, data: Record<string, unknown>) => void,
): Promise<T> {
  signal(RETICLE_BUSY_SIGNAL, { delta: 1 });
  const done = (): void => {
    signal(RETICLE_BUSY_SIGNAL, { delta: -1 });
  };
  work.then(done, done);
  return work;
}

/** The longest timer `trackShortTimers` counts by default: a debounce, not a poll. */
export const SHORT_TIMER_MS = 1000;

/**
 * Opt-in: every `setTimeout` of at most `maxMs` counts as busy work until it fires or is cleared, so a
 * settle waits out a debounce the app never declared. Off unless called: it patches the app's timers.
 * Returns the undo. A fake clock frozen while this runs schedules on the native timers it captured.
 */
export function trackShortTimers(
  signal: (name: string, data: Record<string, unknown>) => void,
  maxMs: number = SHORT_TIMER_MS,
): () => void {
  // Stored values, so the undo restores the very functions the page had (as the fake clock does).
  const realSet = captureMethod(window, 'setTimeout');
  const realClear = captureMethod(window, 'clearTimeout');
  const callSet = realSet.bind(window) as (cb: () => void, ms: number) => number;
  const callClear = realClear.bind(window) as (id: number | undefined) => void;
  const pending = new Set<number>();
  const end = (id: number): void => {
    if (pending.delete(id)) signal(RETICLE_BUSY_SIGNAL, { delta: -1 });
  };
  window.setTimeout = ((cb: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    // Anything not counted goes to the real timer untouched, string handler and arguments included.
    if ('function' !== typeof cb || delay > maxMs)
      return Reflect.apply(realSet, window, [cb, delay, ...args]) as number;
    signal(RETICLE_BUSY_SIGNAL, { delta: 1 });
    const id = callSet(() => {
      end(id);
      cb(...args);
    }, delay);
    pending.add(id);
    return id;
  }) as unknown as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined) end(id);
    callClear(id);
  }) as unknown as typeof window.clearTimeout;
  return () => {
    window.setTimeout = realSet;
    window.clearTimeout = realClear;
  };
}
