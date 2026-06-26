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
const realPerfNow =
  typeof g.performance?.now === 'function' ? g.performance.now.bind(g.performance) : null;

/**
 * Monotonic "now" bound at load. clock.ts deliberately does NOT patch performance.now, so this
 * stays live even when the app clock (iris_clock) is frozen — the presenter state machine relies
 * on it. Falls back to 0 in SSR where performance is absent.
 */
export const nativeNow = (): number => (realPerfNow ? realPerfNow() : 0);

export const nativeSetTimeout = (cb: () => void, ms = 0): number =>
  realSetTimeout ? (realSetTimeout(cb, ms) as unknown as number) : 0;

export const nativeClearTimeout = (id: number): void => {
  realClearTimeout?.(id);
};

/**
 * A self-rescheduling interval built on the bound real timer. We do NOT use
 * `setInterval` because iris_clock can freeze the app's timers — a native, pre-bound
 * timer keeps the page-health heartbeat ticking so a frozen clock never reads as stale.
 * Returns a stop function.
 */
export const nativeSetInterval = (cb: () => void, ms: number): (() => void) => {
  let stopped = false;
  let id = 0;
  const tick = (): void => {
    if (stopped) return;
    cb();
    if (stopped) return;
    id = nativeSetTimeout(tick, ms);
  };
  id = nativeSetTimeout(tick, ms);
  return () => {
    stopped = true;
    nativeClearTimeout(id);
  };
};

/** Max time we wait for a real animation frame before giving up and resolving anyway. */
export const FRAME_BUDGET_MS = 200;

/** Outcome of a bounded frame/settle wait. */
export interface FrameOutcome {
  /** true = a real rAF fired within budget; false = the timeout fallback fired. */
  settled: boolean;
}

/**
 * One animation frame, BOUNDED: races real rAF against a nativeSetTimeout(FRAME_BUDGET_MS).
 * In a throttled/background tab rAF never fires, so the timer wins and we still resolve.
 * Returns whether rAF won (settled:true) or the fallback fired (settled:false).
 */
export const boundedFrame = (budgetMs = FRAME_BUDGET_MS): Promise<FrameOutcome> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (settled: boolean): void => {
      if (done) return;
      done = true;
      nativeClearTimeout(timer);
      resolve({ settled });
    };
    const timer = nativeSetTimeout(() => finish(false), budgetMs);
    if (realRaf) realRaf(() => finish(true));
    else nativeSetTimeout(() => finish(true), 0); // jsdom/SSR: 0ms timer "is" the frame
  });

/** One animation frame, BOUNDED — delegates to boundedFrame so it never hangs in a throttled tab. */
export const nativeFrame = (): Promise<void> => boundedFrame().then(() => undefined);

/**
 * "Settle": let the framework flush. Awaits a microtask then one BOUNDED animation frame so a
 * React commit (and the MutationObserver records it triggers) lands before the caller returns.
 * Uses native timers/rAF so a frozen app clock (iris_clock) never stalls it, AND is bounded so a
 * throttled/background tab (rAF never fires) never deadlocks. Reports whether a real frame fired.
 */
export const settle = async (budgetMs = FRAME_BUDGET_MS): Promise<FrameOutcome> => {
  await Promise.resolve(); // drain the current microtask queue (React scheduler tick)
  return boundedFrame(budgetMs); // one bounded frame so commit + MutationObserver records flush
};
