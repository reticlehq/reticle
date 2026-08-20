import { Verified, type ImpactCounts, type ImpactSnapshot } from '@reticlehq/core';
import { estimateTokens } from '../session/output-budget.js';
import { ImpactStore, type ImpactFoldMeta } from './impact-store.js';

/**
 * The daemon's single impact recorder.
 *
 * One store per daemon, created on the first call that knows the project's `.reticle` root. A
 * module singleton for the same reason the tool counters are: the dispatch chokepoint has to be
 * able to record without every tool threading a store through its arguments, and a second recorder
 * would silently split the user's own history in half.
 */

let store: ImpactStore | undefined;

/** Wire the recorder to a project. Idempotent; the first root wins for the daemon's lifetime. */
export function initImpact(opts: {
  reticleRoot: string | undefined;
  projectName?: string;
  now?: () => number;
}): ImpactStore | undefined {
  // No root, no record. Programmatic callers and test doubles build their own deps and are not
  // obliged to carry one, and a courtesy counter must never be the reason a tool call throws.
  if (opts.reticleRoot === undefined || 0 === opts.reticleRoot.length) return store;
  store ??= new ImpactStore({ ...opts, reticleRoot: opts.reticleRoot });
  return store;
}

/** The live store, if one has been initialised. */
export function impactStore(): ImpactStore | undefined {
  return store;
}

/** Test seam: drop the singleton so a suite can start from a clean record. */
export function resetImpactForTest(): void {
  store = undefined;
}

/** Record one delta, if the recorder is live. Never throws: stats must not break a tool call. */
export function recordImpact(delta: Partial<ImpactCounts>, meta: ImpactFoldMeta = {}): void {
  try {
    store?.record(delta, meta);
  } catch {
    // Counting is a courtesy to the user; failing to count is not worth failing their call over.
  }
}

export function impactSnapshot(): ImpactSnapshot | undefined {
  return store?.snapshot();
}

/**
 * What one tool call did, as counters.
 *
 * Pure and exported so the shape is testable without a dispatch: given a result and a duration, it
 * says what the record should gain. `verified` is the only field that can mint a verdict, which is
 * the same rule the product states to agents - everything else moves or reads the app.
 */
export function deltaForToolResult(
  raw: unknown,
  durationMs: number,
  refused: boolean,
): Partial<ImpactCounts> {
  const delta: Partial<ImpactCounts> = {
    calls: 1,
    drivingMs: Math.max(0, Math.round(durationMs)),
    tokensReturned: estimateTokens(JSON.stringify(raw) ?? ''),
  };
  if (refused) {
    delta.refusals = 1;
    return delta;
  }
  const verified = isRecord(raw) ? raw['verified'] : undefined;
  if (verified === Verified.YES) {
    delta.verdicts = 1;
    delta.passed = 1;
  } else if (verified === Verified.NO) {
    delta.verdicts = 1;
    delta.failed = 1;
  } else if (verified === Verified.UNKNOWN) {
    delta.verdicts = 1;
    delta.unknown = 1;
  }
  return delta;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && null !== value;
}
