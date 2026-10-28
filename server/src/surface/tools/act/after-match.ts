/**
 * What act_and_wait does between the moment its predicate first holds and the moment it grades.
 *
 * The predicate resolves the INSTANT it holds, which on an optimistically-navigating app is while
 * the write is still in flight — so the verdict was taken over a window the app had not finished,
 * and came back `unknown / unsettled` asking the CALLER to re-check. A login that genuinely
 * succeeded returned at 492ms of an 8000ms budget with every corroborating channel agreeing. So the
 * rest of the budget the caller already granted is spent here, in three steps, each deciding
 * nothing on its own.
 */

import type { Predicate } from '@reticlehq/core';
import { hiddenMatchNote } from '@reticlehq/engine/evidence/already-true.js';
import {
  evaluatePredicate,
  type EvalResult,
} from '@reticlehq/engine/question/predicate/predicate.js';
import { waitForInFlight } from './settle-in-flight.js';
import { waitForReaction } from './react-grace.js';
import { revertedAfterMatch } from './durable.js';

type Waited = Parameters<typeof waitForInFlight>[0] & Parameters<typeof revertedAfterMatch>[0];

/** Returns the sentence to fail with when the consequence reverted, else undefined. */
export async function finishAfterMatch(
  session: Waited,
  until: Predicate,
  since: number,
  baselines: Parameters<typeof revertedAfterMatch>[3],
  remaining: () => number,
): Promise<string | undefined> {
  const sleep = { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
  // 1. Follow any open request to its response. A response that arrives as a FAILURE still
  // contradicts — and now arrives INSIDE the window, where the detector can see it at all — while a
  // request still open when the budget runs out reports unsettled, an honest limit rather than an
  // early exit. Costs nothing on the common path, where no request is in flight.
  await waitForInFlight(session, since, remaining(), sleep);
  // 2. Then the app's REACTION to that response. Close the window between the response and the
  // re-render and every channel agrees the app took a successful write and did nothing —
  // `response-ignored`, a `verified:"no"` on a correct app, produced entirely by where we stopped
  // looking. Paid only in the shape that would otherwise be accused, and short enough that a
  // genuinely dropped response is still reported.
  await waitForReaction(session, since, remaining(), sleep);
  // 3. Then ask whether what held still holds — see revertedAfterMatch.
  return revertedAfterMatch(session, until, since, baselines);
}

/**
 * How long a match that holds only on hidden nodes gets to show. An entrance fade or a toast mounted
 * at opacity 0 reads hidden for its first frame, and the wait matched on that frame. A node hidden
 * by design pays this once, on a verdict that is `unknown` either way.
 */
const SHOWN_GRACE_MS = 1000;

/** Poll cadence — the same as the reaction grace. */
const SHOWN_POLL_MS = 50;

/**
 * A green that rests only on hidden matches, read again until a match shows, for at most
 * SHOWN_GRACE_MS. Returns the reading that shows one, or `verdict` unchanged. Nothing is predicted:
 * the verdict is judged on what the page painted, and a node that stays hidden stays `hidden_match`.
 */
export async function awaitShownMatch(
  session: Parameters<typeof evaluatePredicate>[0],
  until: Predicate,
  since: number,
  baselines: Parameters<typeof evaluatePredicate>[4],
  verdict: EvalResult,
  remaining: () => number,
): Promise<EvalResult> {
  if (!verdict.pass || hiddenMatchNote(until, verdict.evidence) === undefined) {
    return verdict;
  }
  // Counted in reads, not read off the session clock, so a clock that does not move still ends it.
  const reads = Math.floor(Math.min(SHOWN_GRACE_MS, remaining()) / SHOWN_POLL_MS);
  for (let read = 0; read < reads; read += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, SHOWN_POLL_MS));
    const now = await evaluatePredicate(session, until, since, true, baselines);
    if (!now.pass) {
      return verdict;
    }
    if (hiddenMatchNote(until, now.evidence) === undefined) {
      return now;
    }
  }
  return verdict;
}
