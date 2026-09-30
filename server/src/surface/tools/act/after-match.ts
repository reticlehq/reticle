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
