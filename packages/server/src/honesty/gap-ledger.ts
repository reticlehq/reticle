import { dedupeGaps, type InstrumentationGap } from '@reticlehq/core';

/**
 * What this session still cannot see, accumulated across its verdicts.
 *
 * A gap reported on one verdict and then forgotten is a note. A gap that is still standing when the
 * agent asks "am I done?" is a piece of work — and that difference is the entire discipline
 * mechanism, because an agent finishing a task is the one moment it will act on a cost it can close.
 *
 * ## Why the LAST verdict decides, not the whole history
 *
 * The honest question is "is this app still unverifiable in this way", not "was it ever". An agent
 * that hits a gap, adds the build plugin and re-verifies has CLOSED it — the later verdict simply
 * stops emitting that kind — and a ledger that still reported it would punish exactly the behaviour
 * this exists to cause. Nobody instruments an app twice for a tool that never notices the first time.
 *
 * So `open()` reflects the most recent verdict, and `everSeen` is kept separately for the summary,
 * where "you hit this and fixed it" is worth saying and is not a reason to withhold done.
 */
export class GapLedger {
  #open: InstrumentationGap[] = [];
  #everSeen = new Set<string>();

  /**
   * Record what the verdict just reported. An empty list is a real observation — it is how a gap
   * gets closed — so it must not be ignored as "nothing to record".
   */
  note(gaps: readonly InstrumentationGap[]): void {
    this.#open = dedupeGaps(gaps);
    for (const gap of gaps) this.#everSeen.add(gap.kind);
  }

  /** Gaps the most recent verdict still reported. The ones that are work right now. */
  open(): readonly InstrumentationGap[] {
    return this.#open;
  }

  /** Every kind seen in this session, including ones since closed. */
  get everSeen(): readonly string[] {
    return [...this.#everSeen];
  }

  /**
   * Did this session leave the app less verifiable than it could be?
   *
   * The one question a "have I finished" call needs answered, and the one a session summary turns
   * into `unproven` rather than `verified`.
   */
  get hasOpen(): boolean {
    return this.#open.length > 0;
  }
}

/**
 * Record a verdict's gaps against the session that produced it.
 *
 * Tolerates a session with no ledger, and that is a statement about the seam rather than a hedge:
 * `Session` is satisfied structurally, and dozens of specs — plus any consumer embedding this engine
 * — build one as an object literal rather than through the constructor. Such a session is a real
 * caller, it simply keeps no ledger, and recording is a side effect that must never be the reason a
 * verdict fails to return.
 *
 * One helper rather than an optional-chain at each call site: the tolerance is a decision, and a
 * decision spelled `?.` in two places is one nobody can find later.
 */
export function noteSessionGaps(
  session: { gaps?: GapLedger },
  gaps: readonly InstrumentationGap[],
): void {
  session.gaps?.note(gaps);
}
