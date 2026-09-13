/**
 * What kind of subject this is, in the five ways that change how it may be driven.
 *
 * Everything else in this protocol is about what a realm can SEE. This is about what it can be PUT
 * THROUGH, and it exists because the rest of the specification had quietly inherited a browser's
 * answer to a question no browser ever has to ask.
 *
 * "Resume is nearly free — re-drive the prefix, 27ms a step" is true of a web page. On a service a
 * POST is not idempotent; on hardware re-driving a prefix moves a physical arm, costs real time, and
 * may not be repeatable at all. A protocol that silently re-drove a payment or a servo would be a
 * defect, not a feature — and until a realm could say so, nothing in the interface distinguished
 * the two.
 *
 * The discipline is `channels()`'s: **declaring a property you do not have is the lie the
 * conformance suite exists to catch.** Here it is the more expensive lie of the two, because a
 * channel you cannot observe produces a wrong verdict and a `replayPrefix` you do not have produces
 * a re-sent payment.
 */

/** The declared vocabulary, one list per field, so the shape check and the type cannot drift. */
const VALUES = {
  reset: ['none', 'cheap', 'costly'],
  replayPrefix: ['free', 'costly', 'unsafe'],
  time: ['wall', 'injectable', 'stepped'],
  observation: ['exact', 'sampled'],
  actions: ['reversible', 'irreversible'],
} as const;

export interface DeterminismProfile {
  /** Can the subject be returned to a known start? */
  reset: 'none' | 'cheap' | 'costly';
  /** May steps 0..N-1 be re-driven to resume at N? */
  replayPrefix: 'free' | 'costly' | 'unsafe';
  /** Is the clock ours? */
  time: 'wall' | 'injectable' | 'stepped';
  /** Do two identical reads of an unchanged subject agree? */
  observation: 'exact' | 'sampled';
  /** Does an action commit something the realm cannot take back? */
  actions: 'reversible' | 'irreversible';
}

/** How to get back to step N, derived from the profile rather than assumed. */
export const ResumeStrategy = {
  /** Re-drive 0..N-1 silently and report from N. What a browser can afford. */
  REPLAY_PREFIX: 'replay-prefix',
  /** Return to a known start first, then re-drive. Resume becomes a budget decision. */
  RESET_THEN_REPLAY: 'reset-then-replay',
  /** Do not resume. Report the stop and require an explicit instruction. */
  REFUSE: 'refuse',
} as const;
export type ResumeStrategy = (typeof ResumeStrategy)[keyof typeof ResumeStrategy];

/**
 * The resume strategy this subject actually admits.
 *
 * `unsafe` is checked first and alone, because it is not a cost to be weighed against a cheap reset
 * — it is a statement that re-driving the prefix must not happen. Reading the reset first and
 * concluding "cheap reset, so go ahead" is precisely the reasoning that re-sends the payment.
 *
 * Pure, and deliberately separate from any realm: the decision is the same wherever it is asked,
 * and a rule that lived inside one implementation would be re-derived, slightly differently, by the
 * next one.
 */
export function resumeStrategy(profile: DeterminismProfile): ResumeStrategy {
  if ('unsafe' === profile.replayPrefix) return ResumeStrategy.REFUSE;
  // A reset only helps if there is one to do. With `reset: 'none'` the honest answer is that
  // resuming costs what it costs, not that it is unavailable.
  if ('costly' === profile.replayPrefix && 'none' !== profile.reset) {
    return ResumeStrategy.RESET_THEN_REPLAY;
  }
  return ResumeStrategy.REPLAY_PREFIX;
}

/**
 * Whether something is a complete declaration, checked where a declaration is first read.
 *
 * `resumeStrategy` falls through to re-driving the prefix for anything it does not recognise, which
 * is the right default for a value it trusts and the wrong answer for a value nobody declared. An
 * implementation that stubbed this with `{}` would be handed "re-drive freely" by silence, on a
 * subject that might be a payment service — so silence is refused rather than interpreted.
 *
 * It checks the SHAPE, not the truth. A realm that declares `free` and cannot afford it is telling
 * the same kind of lie as one declaring a channel it cannot observe, and no predicate catches that:
 * only driving the subject does.
 */
export function isDeterminismProfile(value: unknown): value is DeterminismProfile {
  if ('object' !== typeof value || null === value) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(VALUES).every(([field, allowed]) =>
    (allowed as readonly string[]).includes(record[field] as string),
  );
}
