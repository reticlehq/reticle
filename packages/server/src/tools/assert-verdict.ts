import type { Predicate } from '../events/predicate.js';
import type { Session } from '../session/session.js';
import { findContradictions, type Contradiction } from '../events/contradictions.js';
import {
  blindSpotsFromState,
  buildCoverageStatement,
  Coverage,
  impeachesCapture,
  transportGapNote,
} from '../honesty/blind-spots.js';
import { buildHonestyBlock } from '../honesty/honesty.js';
import { hasAcceptedWrite } from '../honesty/accepted-write.js';
import { hasUnreadWriteOutcome } from '../honesty/unread-outcome.js';
import { decideVerified } from '../honesty/verified.js';
import { gradeOfPredicate } from './assert-grade.js';

/**
 * The honesty verdict for a plain `reticle_assert`.
 *
 * This is the single field an agent reads, and it was missing from the most-used verdict path.
 * `act_and_wait` has always returned it; `reticle_assert` returned a bare `pass: true`.
 *
 * Measured on a shipments console: a dispatch answered 202 Accepted, the row rendered "dispatched"
 * optimistically, an assert taken right after the click returned `pass: true` with no caveat, and the
 * server reverted the write to "held" 1.2s later. The 202 machinery that exists precisely to report
 * that as `verified: "unknown"` was never reached, because the tool an agent actually calls did not
 * consult it. Asserting a moment earlier — while the POST was still open — is the same story with a
 * different name: `request-never-settled`, also unreported.
 */
export async function assertVerdict(
  session: Session,
  predicate: Predicate,
  pass: boolean,
  since: number,
  /** Set when the assertion was never evaluated — see honesty/verified.ts. */
  inconclusive?: string,
  /**
   * Set when the tab went away mid-wait, so the assertion was never OBSERVED. `reticle_assert` and
   * `reticle_wait_for` reach the same disconnect path as the act tools, and a verdict that blames
   * the app for a lost connection is no more honest on this route than on that one.
   */
  observationLost?: boolean,
): Promise<{
  decision: Record<string, unknown>;
  contradictions: Contradiction[];
  coverage: Record<string, unknown>;
}> {
  // Scope caveat, stated because it is a real limitation and not a bug: blind spots are tracked per
  // SESSION, not per assertion window, so a cross-origin iframe seen once marks every later verdict
  // in that session partial — including ones about a region it cannot affect. That errs toward
  // over-warning, which is the correct direction here: the failure this guards against is a green
  // that implies coverage it never had, and a needless caveat costs the agent a sentence.
  const spots = blindSpotsFromState(session.blindSpots());
  const statement = buildCoverageStatement(spots);
  // Omitted entirely when coverage is full, so an intact page pays nothing and the field's PRESENCE
  // is the warning.
  const coverage =
    Coverage.PARTIAL === statement.coverage
      ? {
          coverage: statement.note ?? Coverage.PARTIAL,
          coverage_spots: statement.spots.map((sp) => ({ kind: sp.kind, count: sp.count })),
        }
      : {};
  const windowEvents = await session.queryEvents({ since });
  // Everything before the window, passed as LEARNING material only. A scale error disagrees with a
  // value the API stated earlier in the session, which an action-scoped window can never contain —
  // measured live, `observe` over a wide window reported `unit-mismatch` while `assert` on the same
  // session reported none. Attribution is unchanged: findings still come only from windowEvents.
  const prior =
    since > 0 ? (await session.queryEvents({ since: 0 })).filter((e) => e.t < since) : [];
  const contradictions = findContradictions(windowEvents, { prior });
  // Only a spot that IMPEACHES the capture downgrades a verdict. A structural boundary (virtualized
  // rows, a cross-origin frame) is reported as coverage and must not impugn what WAS observed.
  const impeaching = buildCoverageStatement(spots.filter((sp) => impeachesCapture(sp.kind)));
  // A gap in the WINDOW, as opposed to a standing limit of the page. Both mean the same thing to the
  // rule — part of what happened was not seen — so both belong in `blindSpots`, which is the only
  // input `decideVerified` reads for that.
  const gap = transportGapNote(windowEvents);
  const impeachingNotes = [impeaching.note, gap].filter((n): n is string => n !== undefined);
  const outcomePending = hasAcceptedWrite(windowEvents);
  const outcomeUnread = hasUnreadWriteOutcome(windowEvents);
  const decision = decideVerified({
    pass,
    ...(inconclusive === undefined ? {} : { inconclusive }),
    ...(true === observationLost ? { observationLost: true } : {}),
    honesty: buildHonestyBlock({
      grade: gradeOfPredicate(predicate),
      attribution: 'window',
      coveragePartial: Coverage.PARTIAL === statement.coverage,
      ...(0 === impeachingNotes.length ? {} : { blindSpots: impeachingNotes }),
    }),
    contradictions,
    ...(outcomePending ? { outcomePending } : {}),
    ...(outcomeUnread ? { outcomeUnread } : {}),
  });
  return { decision: decision as unknown as Record<string, unknown>, contradictions, coverage };
}
