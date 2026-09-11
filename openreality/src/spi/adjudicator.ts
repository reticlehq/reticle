import { type Claim, Declaration } from '../vocabulary/intent.js';
import {
  type ChannelDescriptor,
  disagreementCanConvict,
  Grade,
  Independence,
} from '../vocabulary/channel.js';
import {
  canSupportConsequence,
  type Coverage,
  type Evidence,
  impeachingSpots,
} from '../vocabulary/evidence.js';
import { type Window, closedCleanly } from '../vocabulary/realm-surface.js';
import { type Anomaly, AnomalyTier, Verdict } from '../vocabulary/verdict.js';

/**
 * Turning evidence into a verdict, without knowing what kind of world it came from.
 *
 * The adjudicator is REALM-BLIND, and that is the architectural claim of this whole protocol: if
 * the rules below can be stated without mentioning a browser, then a browser is an implementation
 * detail and every other environment is a first-class citizen rather than a port.
 *
 * They can. Nothing here knows what a DOM is.
 *
 * This function is normative. An implementation may reach these verdicts by another route, and
 * the conformance suite scores whether it reaches the SAME ones -- but where an implementation
 * disagrees with this function, this function is what the specification means.
 */

/**
 * The clause that decided, as a code rather than as a sentence.
 *
 * The prose in `reasons` is for a person and is an implementation's own; this is the same fact in
 * a form another program can compare. Both are needed, and the distinction was found by the
 * conformance suite rather than reasoned about: a scenario that requires "disproved BECAUSE two
 * channels contradicted" cannot be scored against `verdict` alone -- `no` is also what a merely
 * failed assertion returns -- and scoring it against the sentence would pin every implementation
 * to this one's vocabulary, which is the thing a specification must never do.
 *
 * One code per clause of `adjudicate`, in the order the clauses run.
 */
export const Ground = {
  /** Clause 1: nothing was declared, over a window that closed cleanly. */
  NOTHING_DECLARED: 'nothing-declared',
  /** Clause 2: the claim reads a channel this implementation does not observe. */
  CHANNEL_NOT_OBSERVED: 'channel-not-observed',
  /** Clause 3: independent channels contradict each other. */
  CONTRADICTED: 'contradicted',
  /** Clause 4: the declared consequence did not hold. */
  ASSERTION_FAILED: 'assertion-failed',
  /** Clauses 1 and 5: the window did not close the way it said it would. */
  WINDOW_NOT_CLOSED: 'window-not-closed',
  /** Clause 6: something the claim needed was not visible. */
  COVERAGE_IMPEACHED: 'coverage-impeached',
  /** Clause 7: an absence inside a window whose end we chose. Never a fault. */
  SUSPICION_UNRESOLVED: 'suspicion-unresolved',
  /** Clause 8: the claim was written down after the action. */
  DECLARED_AFTER_ACTION: 'declared-after-action',
  /** Clause 9: nothing independent and consequence-grade paid for it. */
  NO_INDEPENDENT_CONSEQUENCE: 'no-independent-consequence',
  /** The bottom of the ladder: every rung cleared. */
  PROVED: 'proved',
} as const;
export type Ground = (typeof Ground)[keyof typeof Ground];

export interface Adjudication {
  readonly verdict: Verdict;
  /** What bought a `yes`. Absent when nothing did. */
  readonly grade?: Grade;
  /** The deciding clause, as a code another implementation can be scored against. */
  readonly ground: Ground;
  /** The deciding clause, named. A verdict whose reason is unnamed cannot be argued with. */
  readonly reasons: readonly string[];
}

export interface AdjudicationInput {
  readonly claim: Claim;
  readonly window: Window;
  readonly channels: readonly ChannelDescriptor[];
  readonly evidence: readonly Evidence[];
  readonly coverage: Coverage;
  readonly anomalies: readonly Anomaly[];
  /** Did the claim's own assertions evaluate true? Undefined means nothing could evaluate them. */
  readonly assertionsHeld: boolean | undefined;
}

/** The channels this claim needed, gathered from its assertions. */
function channelsNeeded(claim: Claim): readonly string[] {
  return [...new Set(claim.assertions.flatMap((a) => a.channels))];
}

/**
 * The clauses, in order, and the order is the specification.
 *
 * Each rung is a reason a `yes` is unavailable, checked before the ones below it. They are
 * arranged so that the cheapest disqualification is found first and, more importantly, so that
 * "I could not see" is always evaluated before "it did not happen" -- the single ordering mistake
 * that turns a verification tool into a bug generator.
 */
export function adjudicate(input: AdjudicationInput): Adjudication {
  const { claim, window, channels, evidence, coverage, anomalies, assertionsHeld } = input;

  // 1. Nothing was declared. Not a pass, and not a failure to see -- a different fact from both.
  if (claim.assertions.length === 0) {
    return closedCleanly(window)
      ? {
          verdict: Verdict.NO_FAULT,
          ground: Ground.NOTHING_DECLARED,
          reasons: ['the window closed cleanly and nothing was declared to prove'],
        }
      : {
          verdict: Verdict.UNKNOWN,
          ground: Ground.WINDOW_NOT_CLOSED,
          reasons: ['nothing was declared, and the window did not close cleanly either'],
        };
  }

  // 2. The claim reads something nobody was watching. Checked BEFORE any evidence is weighed,
  //    because "nothing was watching" and "it did not happen" produce identical empty evidence.
  const declared = new Set(channels.map((c) => c.id));
  const missing = channelsNeeded(claim).filter((c) => !declared.has(c));
  if (missing.length > 0) {
    return {
      verdict: Verdict.UNKNOWN,
      ground: Ground.CHANNEL_NOT_OBSERVED,
      reasons: [`the claim reads ${missing.join(', ')}, which this implementation cannot observe`],
    };
  }

  // 3. An observed anomaly on independent channels outranks a passing assertion. This is the
  //    clause that earns the protocol its keep: a green assertion sitting on top of a failed
  //    operation is the bug class the whole design exists to refuse.
  const convicting = anomalies.filter(
    (a) => a.tier === AnomalyTier.OBSERVED && convicts(a, channels),
  );
  if (convicting.length > 0) {
    return {
      verdict: Verdict.NO,
      ground: Ground.CONTRADICTED,
      reasons: convicting.map((a) => `${a.claim} — but ${a.counter}`),
    };
  }

  // 4. The assertions themselves failed.
  if (assertionsHeld === false) {
    return {
      verdict: Verdict.NO,
      ground: Ground.ASSERTION_FAILED,
      reasons: ['the declared consequence did not hold'],
    };
  }

  // 5. The window never closed properly, so nothing here is a statement about a finished effect.
  if (!closedCleanly(window)) {
    return {
      verdict: Verdict.UNKNOWN,
      ground: Ground.WINDOW_NOT_CLOSED,
      reasons: [`the window closed by ${String(window.closedBy)} rather than ${window.closes}`],
    };
  }

  // 6. Something the claim needed was not visible. Honest implementations declare more of these,
  //    and only the IMPEACHING ones count -- see BlindSpot.impeaching, without which honesty is
  //    punished and an implementation learns to declare less.
  const impeaching = impeachingSpots(coverage, channelsNeeded(claim));
  if (impeaching.length > 0) {
    return {
      verdict: Verdict.UNKNOWN,
      ground: Ground.COVERAGE_IMPEACHED,
      reasons: impeaching.map((s) => s.detail),
    };
  }

  // 7. An absence-derived anomaly. Never a fault; always a reason to look again.
  const suspicions = anomalies.filter((a) => a.tier === AnomalyTier.ABSENCE_DERIVED);
  if (suspicions.length > 0) {
    return {
      verdict: Verdict.UNKNOWN,
      ground: Ground.SUSPICION_UNRESOLVED,
      reasons: suspicions.map((a) => `${a.claim} — and ${a.counter}`),
    };
  }

  // 8. The claim was written down after the fact, so it cannot be proved — only not contradicted.
  //    Anything that happened can be described as what you meant.
  if (claim.declaredAt !== Declaration.BEFORE_ACTION) {
    return {
      verdict: Verdict.UNKNOWN,
      ground: Ground.DECLARED_AFTER_ACTION,
      reasons: ['the claim was declared after the action, so it can be met but not proved'],
    };
  }

  // 9. Nothing independent and consequence-grade paid for it. The last rung, and the one that
  //    separates this protocol from every automation tool: agreement among channels the action
  //    itself produced is not evidence, however much of it there is.
  const proving = evidence.filter(canSupportConsequence);
  if (proving.length === 0) {
    return {
      verdict: Verdict.UNKNOWN,
      ground: Ground.NO_INDEPENDENT_CONSEQUENCE,
      reasons: [
        'nothing independent of the action supports this at consequence grade; ' +
          'the subject agreeing with itself is not evidence that it acted',
      ],
    };
  }

  return {
    verdict: Verdict.YES,
    grade: Grade.CONSEQUENCE,
    ground: Ground.PROVED,
    reasons: ['proved by independent evidence over a cleanly closed window'],
  };
}

/**
 * May this anomaly force a `no`?
 *
 * At least one of the two channels it sets against each other must be independent. A disagreement
 * between two channels the action itself produced is the subject contradicting its own reporting
 * -- real, worth saying, and not proof that anything failed.
 *
 * An anomaly naming a channel the implementation never declared cannot convict either: it is a
 * statement about evidence nobody has.
 */
function convicts(anomaly: Anomaly, channels: readonly ChannelDescriptor[]): boolean {
  const [left, right] = anomaly.between;
  const a = channels.find((c) => c.id === left);
  const b = channels.find((c) => c.id === right);
  if (a === undefined || b === undefined) return false;
  return disagreementCanConvict(a, b);
}

/**
 * Whether a set of declared channels could ever produce a proof here.
 *
 * Worth asking at startup rather than one `unknown` at a time. An implementation with no
 * independent channel is not a broken implementation; it is a `presence`-only one, and it should
 * say so in its profile.
 */
export function couldEverProve(channels: readonly ChannelDescriptor[]): boolean {
  return channels.some(
    (c) => c.independence === Independence.INDEPENDENT && c.grade === Grade.CONSEQUENCE,
  );
}
