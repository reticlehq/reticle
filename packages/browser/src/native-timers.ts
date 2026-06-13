// Native timers captured (bound) at module load, BEFORE any fake-clock patch. The SDK uses
// these for its own internal waits (presenter pacing, hover dwell, transport reconnect) so
// that freezing the app's clock (iris_clock) never deadlocks Iris itself.
//
// Important: we bind the reference now. Resolving `setTimeout` at call time would pick up the
// patched (frozen) timer once iris_clock freezes the clock — which would hang the SDK.
const g: typeof globalThis = globalThis;

const realSetTimeout = typeof g.setTimeout === 'function' ? g.setTimeout.bind(g) : null;
const realClearTimeout = typeof g.clearTimeout === 'function' ? g.clearTimeout.bind(g) : null;

export const nativeSetTimeout = (cb: () => void, ms = 0): number =>
  realSetTimeout ? (realSetTimeout(cb, ms) as unknown as number) : 0;

export const nativeClearTimeout = (id: number): void => {
  realClearTimeout?.(id);
};

export const nativeSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => nativeSetTimeout(resolve, ms));
