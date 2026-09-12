import { declaresDom } from '@reticlehq/engine/question/predicate/predicate-asks.js';
import type { Predicate } from '@reticlehq/engine/question/predicate/predicate-schema.js';
import type { Session } from '../../../portal/session/session.js';

/**
 * Where an assertion's OWN evidence is written, as `file:line`.
 *
 * The element descriptors an oracle returns already carry the nearest `data-reticle-source` the build
 * plugin stamped, so a predicate that matched an element knows exactly where that element lives. It
 * is only reported when every matched descriptor agrees: two loci and no way to choose is the same
 * problem as no locus at all, and a guessed pointer costs the agent the trip AND leaves it further
 * from the code.
 *
 * Near-miss evidence is deliberately NOT read. A near miss is a DIFFERENT element than the one the
 * caller asked about, so its line is a suggestion dressed as a fact.
 */
function evidenceSource(evidence: unknown): string | undefined {
  if (!Array.isArray(evidence) || 0 === evidence.length) return undefined;
  let agreed: string | undefined;
  for (const entry of evidence) {
    if ('object' !== typeof entry || null === entry) return undefined;
    const found = (entry as { source?: unknown }).source;
    if ('string' !== typeof found || 0 === found.length) return undefined;
    if (agreed === undefined) agreed = found;
    else if (agreed !== found) return undefined;
  }
  return agreed;
}

/**
 * The `file:line` an ASSERTION is entitled to report — its own evidence, or nothing.
 *
 * `reticle_assert` and `reticle_wait_for` drive nothing, so the last act's source is whatever
 * unrelated action ran before them. Journaling it made an assert on one component claim it had
 * proven something about another, and an assert that matched nothing claim a location at all — a
 * wrong file:line in front of an agent, persisted, and read back by `reticle_context` long after
 * the turn that produced it.
 *
 * The one borrow that survives is the documented one, and only on a failure: a predicate with no DOM
 * clause has no element to point at, and the handler that should have fired the missing signal or
 * made the missing request lives with the control that was last driven. That is what the tools'
 * output schemas describe, and it is a pointer to the code under test rather than a guess about
 * which code this verdict was about.
 */
export function assertSource(facts: {
  predicate: Predicate;
  evidence: unknown;
  pass: boolean;
  lastActSource: string | undefined;
  /**
   * Set when the verdict could not be EVALUATED rather than evaluated and found false.
   *
   * A file:line reads as a precise, well-attributed finding about that file. Attaching one to a
   * reading that proved nothing sends the investigation into correct code: reported against a
   * wedged Next.js dev server, where a route verdict named `components/.../header.tsx:53` and the
   * reporter nearly filed "the header Sign Up link is broken" — the server was answering nothing at
   * all, on every route.
   *
   * Gated here rather than in the route oracle, because every producer of an inconclusive verdict
   * has the same problem: a throttled tab, a superseded window, an unreadable locator. One guard
   * where all of them route through.
   */
  inconclusive?: string | undefined;
}): string | undefined {
  const own = evidenceSource(facts.evidence);
  if (own !== undefined) return own;
  if (facts.pass || declaresDom(facts.predicate)) return undefined;
  // Nothing was proven and nobody could have proven it — so there is nothing to point at.
  if (facts.inconclusive !== undefined) return undefined;
  return facts.lastActSource;
}

/**
 * The file:line an assertion may report — see `assertSource`.
 *
 * Neither `reticle_assert` nor `reticle_wait_for` drives anything, so the last act's source is about
 * some earlier action and not about this verdict. The pointer comes from the assertion's own matched
 * evidence; the last driven control is borrowed only for a RED whose predicate has no DOM clause at
 * all, which is the failure that genuinely has no element to point at.
 */
export function assertionSource(
  session: Session,
  predicate: Predicate,
  verdict: { pass: boolean; evidence?: unknown; inconclusive?: string },
): { source?: string } {
  const source = assertSource({
    predicate,
    evidence: verdict.evidence,
    pass: verdict.pass,
    lastActSource: session.lastAct.source(),
    ...(verdict.inconclusive === undefined ? {} : { inconclusive: verdict.inconclusive }),
  });
  return source === undefined ? {} : { source };
}
