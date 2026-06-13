// Native timers captured (bound) at module load, BEFORE any fake-clock patch. The SDK uses
// these for its own internal waits (presenter pacing, hover dwell, transport reconnect) so
// that freezing the app's clock (iris_clock) never deadlocks Iris itself.
//
// Important: we bind the reference now. Resolving `setTimeout` at call time would pick up the
// patched (frozen) timer once iris_clock freezes the clock — which would hang the SDK.
const g: typeof globalThis = globalThis;

const realSetTimeout = typeof g.setTimeout === 'function' ? g.setTimeout.bind(g) : null;
const realClearTimeout = typeof g.clearTimeout === 'function' ? g.clearTimeout.bind(g) : null;
const realRaf =
  typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame.bind(g) : null;

export const nativeSetTimeout = (cb: () => void, ms = 0): number =>
  realSetTimeout ? (realSetTimeout(cb, ms) as unknown as number) : 0;

export const nativeClearTimeout = (id: number): void => {
  realClearTimeout?.(id);
};

export const nativeSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => nativeSetTimeout(resolve, ms));

/** One animation frame via the real (unpatched) rAF, or a 0ms timer fallback (jsdom/SSR). */
export const nativeFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (realRaf) realRaf(() => resolve());
    else nativeSetTimeout(() => resolve(), 0);
  });

/**
 * "Settle": let the framework flush. Awaits a microtask then one animation frame so a React
 * commit (and the MutationObserver records it triggers) lands before the caller returns. Uses
 * native timers/rAF so a frozen app clock (iris_clock) never stalls it — rAF/microtasks are
 * never patched by the fake clock, so this is deadlock-safe under freeze.
 */
export const settle = async (): Promise<void> => {
  await Promise.resolve(); // drain the current microtask queue (React scheduler tick)
  await nativeFrame(); // one frame so commit + MutationObserver records flush
};
