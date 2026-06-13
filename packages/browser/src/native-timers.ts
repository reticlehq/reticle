// Native timers captured at module load, before any fake-clock patch. The SDK uses these
// for its own internal waits (presenter pacing, hover dwell, transport reconnect) so that
// freezing the app's clock (iris_clock) never deadlocks Iris itself.
const hasTimers = typeof setTimeout === 'function';

export const nativeSetTimeout: (cb: () => void, ms?: number) => number = hasTimers
  ? (cb, ms) => setTimeout(cb, ms) as unknown as number
  : () => 0;

export const nativeClearTimeout: (id: number) => void = hasTimers
  ? (id) => {
      clearTimeout(id);
    }
  : () => undefined;

export const nativeSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => nativeSetTimeout(resolve, ms));
