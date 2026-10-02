/**
 * The gap, as a number the person who ran the session can see.
 *
 * Reticle's whole claim is that it measures the distance between what an agent believed happened
 * and what did. It measures that on every verdict, writes the answer into the journal, and shows it
 * to nobody: the counts exist, the reasons exist, the contradictions exist, and no surface anywhere
 * says "you made 14 claims, 9 held, 2 were false, 3 could not be decided, and here is who owns each
 * of those three". The value of the product is the one thing it never reports.
 *
 * A FOLD over the journal, never a second store — the rule `run-context.ts` next door states, for
 * the same reason: two ways to compute one number is worse than one way, because the day they
 * disagree the disagreement lands inside a verdict and a user finds it before we do.
 *
 * Nothing here sends anything anywhere, and that is deliberate rather than incidental. This is the
 * LOCAL half. Whether a fleet-wide version of the same number is worth collecting is a separate
 * decision with a separate owner, and building the local one first is what makes that decision
 * answerable from something other than a guess.
 */
import {
  JournalVerdictEffectSchema,
  Verified,
  VerifiedReason,
  VerdictAttribution,
  verdictAttributionOf,
  type JournalAction,
  type JournalVerdictEffect,
} from '@reticlehq/core';

/** One claim that did not hold, in the words it was made and the engine's reason for refusing it. */
export interface GapFailure {
  claim: string;
  reason?: VerifiedReason;
}

export interface GapSummary {
  /** Actions that asserted something. An action that only drove the app is not a claim. */
  claims: number;
  held: number;
  failed: number;
  /** `unknown`: Reticle could not tell. Never folded into held or failed — that is the false green. */
  undecided: number;
  /**
   * `no-fault`: nothing was declared, so nothing was checked.
   *
   * The fourth answer, kept apart from the other three. Folding it anywhere is how a session that
   * proved nothing reads as a session that proved something.
   */
  nothingToProve: number;
  /**
   * WHO can act on each undecided verdict, counted per owner.
   *
   * The only part of an `unknown` a reader can do anything with: the four owners imply four
   * different next moves — wait, fix the app, fix the harness, look again. Empty when nothing was
   * undecided, and a verdict that recorded no reason contributes to no owner rather than to a
   * guessed one.
   */
  undecidedBy: Partial<Record<VerdictAttribution, number>>;
  /**
   * Failures where a CHANNEL disagreed with what the app showed.
   *
   * Counted apart from an ordinary failure because they mean different things to the reader: an
   * assertion that failed is a check doing its job, and a contradiction is a green that would have
   * been believed. This number is the product's own headline, measured on the reader's own session.
   */
  falseGreensCaught: number;
  failures: GapFailure[];
}

/**
 * The reason, as the engine's own enum, or undefined.
 *
 * The journal stores `reason` as a free string rather than the enum — deliberately, because the
 * ledger has to keep reading records written by an older engine whose vocabulary it cannot know.
 * So a reason this build does not recognise is treated exactly like an absent one: no owner. The
 * alternative is attributing an unknown word to one of four buckets, which is inventing an
 * attribution nobody recorded.
 */
function knownReason(reason: string | undefined): VerifiedReason | undefined {
  if (reason === undefined) return undefined;
  const known: readonly string[] = Object.values(VerifiedReason);
  return known.includes(reason) ? (reason as VerifiedReason) : undefined;
}

/** The verdict a verification tool recorded on this action, if it recorded one. */
function verdictOf(action: JournalAction): JournalVerdictEffect | undefined {
  const parsed = JournalVerdictEffectSchema.safeParse(action.effect);
  return parsed.success ? parsed.data : undefined;
}

export function gapSummary(actions: readonly JournalAction[]): GapSummary {
  const summary: GapSummary = {
    claims: 0,
    held: 0,
    failed: 0,
    undecided: 0,
    nothingToProve: 0,
    undecidedBy: {},
    falseGreensCaught: 0,
    failures: [],
  };
  for (const action of actions) {
    const verdict = verdictOf(action);
    if (verdict === undefined) continue;
    summary.claims += 1;
    switch (verdict.verified) {
      case Verified.YES:
        summary.held += 1;
        break;
      case Verified.NO: {
        summary.failed += 1;
        if (VerifiedReason.CONTRADICTED === verdict.reason) summary.falseGreensCaught += 1;
        const reason = knownReason(verdict.reason);
        summary.failures.push(
          reason === undefined ? { claim: verdict.claim } : { claim: verdict.claim, reason },
        );
        break;
      }
      case Verified.UNKNOWN: {
        summary.undecided += 1;
        // A record written before `reason` existed has none, and must not be read as though it did:
        // counting it under an owner would invent an attribution nobody recorded.
        const reason = knownReason(verdict.reason);
        const owner = reason === undefined ? undefined : verdictAttributionOf(reason);
        if (owner !== undefined && VerdictAttribution.NONE !== owner) {
          summary.undecidedBy[owner] = (summary.undecidedBy[owner] ?? 0) + 1;
        }
        break;
      }
      case Verified.NO_FAULT:
        summary.nothingToProve += 1;
        break;
    }
  }
  return summary;
}
