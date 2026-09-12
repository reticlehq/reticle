/**
 * A second vantage point that can look and cannot touch.
 *
 * Every channel a `Realm` declares is, in the end, the subject describing itself. The DOM says the
 * order was saved because the app wrote that on the screen; the network says so because the app made
 * the call. When an app lies to itself — the optimistic update that was never committed, the write
 * that returned 200 and rolled back — every channel inside it repeats the lie consistently, and no
 * amount of evidence from in there ever settles it. The database is not in there.
 *
 * So a `Witness` is a `Realm` minus the ability to act, and the omission is the entire point: it
 * cannot be the thing that caused what it reports. Modelling it as a realm with the action methods
 * left unimplemented would be the interface inviting exactly the coupling that makes its evidence
 * worthless — and an implementer who CAN act through the same object eventually will.
 *
 * `Realm` extends this, which is the honest direction of the relationship: acting is the addition,
 * observing is the base. Everything the adjudicator needs is here; `perform` is not part of it.
 */

import type { ChannelDescriptor, ChannelId } from '../vocabulary/channel.js';
import type { Coverage, Observation, BlindSpot } from '../vocabulary/evidence.js';
import type { Window } from '../vocabulary/realm-surface.js';
import type { SubjectRef } from '../vocabulary/subject.js';
import { AnomalyKind, AnomalyTier, type Anomaly } from '../vocabulary/verdict.js';

export abstract class Witness {
  /** What is being looked at, and what would invalidate evidence about it. */
  abstract identity(): SubjectRef;

  /**
   * What this vantage point can observe.
   *
   * A witness's channels are usually `independent`, and that is what makes asking it worth the
   * round trip — but it is still a DECLARATION, checked the same way every other one is. A witness
   * that calls itself independent and is reading the app's own cache is telling the protocol's
   * costliest lie: it looks like corroboration and is an echo.
   */
  abstract channels(): readonly ChannelDescriptor[];

  /** When "done" happens from here, which is rarely when it happens in the subject. */
  abstract openWindow(budgetMs: number): Window;

  /** Everything seen in that window, on the channels declared above. */
  abstract observe(window: Window): Promise<readonly Observation[]>;

  /** What could not be seen. An empty `blindSpots` is a positive claim that nothing was hidden. */
  abstract coverage(window: Window): Promise<Coverage>;
}

/** What the subject appeared to claim, and the channel it claimed it on. */
export interface ActorClaim {
  claim: string;
  channel: ChannelId;
}

/** What the witness could say about the same moment. */
export interface WitnessReport {
  channel: ChannelId;
  observed: readonly Observation[];
  /** What the witness could NOT see. Silence from a blind witness is not evidence of absence. */
  blind?: readonly BlindSpot[];
}

/**
 * The subject said it happened; did anything outside the subject agree?
 *
 * Returns an OBSERVED anomaly when the witness looked and saw nothing, which is the one shape no
 * evidence from inside the subject can produce — and the adjudicator's clause 3 then outranks a
 * passing assertion with it, because one of the two channels is independent.
 *
 * It returns NOTHING when the witness could not look. A witness that was unreachable saw nothing for
 * a reason that has nothing to do with the application, and reporting that as "the write never
 * happened" would be the protocol inventing a defect out of its own blind spot — the same rule that
 * makes an empty `blindSpots` array a positive claim rather than a default.
 *
 * Pure: two reports in, an anomaly or nothing out. No realm, no clock, no IO.
 */
export function witnessDisagreement(
  actor: ActorClaim,
  witness: WitnessReport,
): Anomaly | undefined {
  const couldNotLook = (witness.blind ?? []).some((spot) => spot.channel === witness.channel);
  if (couldNotLook) return undefined;
  if (witness.observed.length > 0) return undefined;
  return {
    kind: AnomalyKind.CLAIM_UNCORROBORATED,
    tier: AnomalyTier.OBSERVED,
    claim: actor.claim,
    counter: `nothing on ${witness.channel}, observed from outside the subject, corroborates it`,
    between: [actor.channel, witness.channel],
    evidence: [],
  };
}
