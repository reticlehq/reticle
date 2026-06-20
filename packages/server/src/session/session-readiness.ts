/**
 * First-run readiness: the agent often issues its first tool call in the window between `iris init`
 * and the app's SDK actually connecting its WebSocket — so a naive resolve throws "no session". This
 * lets the agent (via iris_wait_ready) BLOCK briefly until a session appears instead of failing the
 * race, smoothing the most common first-5-minutes footgun.
 *
 * Pure control loop: the session count, clock, and sleep are all injected, so it is unit-tested with
 * no real timers — and in production it polls a real `setTimeout` sleep.
 */
export interface WaitForReadyOptions {
  /** Live count of connected sessions (SessionManager.count). */
  count: () => number;
  /** Give up after this much elapsed time. */
  timeoutMs: number;
  /** Injected monotonic clock (ms). */
  now: () => number;
  /** Injected delay between polls. */
  sleep: (ms: number) => Promise<void>;
  /** Poll interval (ms). Default 100. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 100;

/**
 * Resolve `true` as soon as at least one session is connected, or `false` if the timeout elapses
 * first. Returns immediately when a session is already connected (the common, already-ready case —
 * so this never adds latency on the happy path, including the benchmark which always has a session).
 */
export async function waitForReady(opts: WaitForReadyOptions): Promise<boolean> {
  if (opts.count() > 0) return true;
  const start = opts.now();
  const poll = opts.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    if (opts.now() - start >= opts.timeoutMs) return opts.count() > 0;
    await opts.sleep(poll);
    if (opts.count() > 0) return true;
  }
}
