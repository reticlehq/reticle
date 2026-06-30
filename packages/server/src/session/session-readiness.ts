/**
 * First-run readiness: the agent often issues its first tool call in the window between `reticle init`
 * and the app's SDK actually connecting its WebSocket — so a naive resolve throws "no session". This
 * lets the agent (via reticle_wait_ready) BLOCK briefly until a session appears instead of failing the
 * race, smoothing the most common first-5-minutes footgun.
 *
 * Pure control loop: the session count, clock, and sleep are all injected, so it is unit-tested with
 * no real timers — and in production it polls a real `setTimeout` sleep.
 */
interface WaitForReadyOptions {
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
 * One-line orientation for a FRESH agent — the Reticle loop, returned by reticle_wait_ready (the first call)
 * so an agent learns how to drive Reticle without reading docs. Named so it is not a free string; kept
 * terse on purpose (it rides the first response, where token budget is tightest).
 */
export const RETICLE_LOOP_GUIDE =
  'Reticle loop — LOOK: reticle_snapshot / reticle_query / reticle_inspect · ACT: reticle_act (or reticle_act_and_wait) · ' +
  'OBSERVE: reticle_observe / reticle_wait_for / reticle_network / reticle_console · ASSERT: reticle_assert over program ' +
  'truth, not just the DOM · REGRESS: reticle_record_start → reticle_replay, or reticle_flow_verify for the whole ' +
  'suite. The human can flag bugs from the panel — drain them with reticle_review and resolve each once fixed. ' +
  'MANDATORY: the moment you stop driving — finishing your reply or waiting on the human — call reticle_yield ' +
  '(mode:"waiting", or mode:"ask" with the question) so the panel shows your real state; reticle_end_session ' +
  'only when the whole task is done. Never leave the panel reading "live" when you have actually stopped.';

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
