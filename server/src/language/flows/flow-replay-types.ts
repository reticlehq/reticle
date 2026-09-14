import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import type { Predicate } from '@reticlehq/engine/question/predicate/predicate-schema.js';
import type { EvalResult } from '@reticlehq/engine/question/predicate/predicate.js';

/**
 * The shapes a replay needs from whatever is driving it.
 *
 * A LEAF, and that is the whole point. These lived in `flow-replay.ts`, so `flow-step-runners.ts`
 * and `flow-success.ts` — both of which `flow-replay` imports — had to import back out of it to name
 * their own parameters. TypeScript erases a type-only import, so nothing was wrong at runtime; the
 * cycle was real to every tool that reads imports, and it made a large module look like the source
 * of shapes that are really just its vocabulary.
 *
 * A type that two collaborators both need belongs beside neither of them.
 */

/**
 * The session surface flow-replay needs: QUERY to re-resolve a testid anchor against the live
 * DOM, ACT to run the step, and the event/onEvent pair so a signal anchor can wait on a predicate
 * (via the injected waitForPredicate). Mirrors PredicateSession so the same fake drives both.
 */
export interface FlowReplaySession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  /**
   * Attribution window around each replayed step. Optional so a minimal test double still satisfies the
   * interface, but a real session MUST supply it: without a window the step's own effects carry no
   * actionId, and Session.pushEvent classifies an unattributed ref-bearing event as ambient background
   * churn. A 15-step flow can therefore teach the settle oracle to ignore every region the app reacts
   * in — and this is the CI path, so the result is a green suite over an app that is still working.
   */
  beginAction?(tool: string, args: Record<string, unknown>): void;
  finishAction?(error?: string, settled?: boolean, settleMs?: number): void;
  eventsSince(cursor: number): ReticleEvent[];
  onEvent(listener: (event: ReticleEvent) => void): () => void;
  /** Buffer clock (ms since connect) — required by the predicate engine's `settled` check. */
  elapsed(): number;
}

/**
 * The injected predicate-waiter (the real waitForPredicate) — reused, never reimplemented.
 * `since` is the event-time floor (default 0 = whole buffer): pass the cursor captured before a
 * replay so the success oracle can't be satisfied by a stale signal from a prior replay/run.
 */
export type WaitForSignal = (
  session: FlowReplaySession,
  predicate: Predicate,
  timeoutMs: number,
  since?: number,
) => Promise<EvalResult>;

/** Injected sleeper so tests drive replay with a no-op clock; production waits on a real timer. */
export type Sleep = (ms: number) => Promise<void>;
