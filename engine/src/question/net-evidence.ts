/**
 * What a network verdict returns as its PROOF.
 *
 * Split out of predicate-eval.ts, which sits at the size backstop, and split HERE because this is a
 * separate question from "did the predicate hold": that file decides the answer, this one decides
 * what is shown to justify it. The two failure modes differ too. A wrong verdict is a wrong verdict;
 * wrong evidence is a verdict nobody can check, or one that costs forty times what it is worth.
 */

import { PredicateKind } from '@reticlehq/core';
import { withoutUrlRaw } from '../window/event-filters.js';
import type { Predicate } from './predicate-schema.js';

/**
 * How much of a body the evidence for a PASS may carry when the check never read it.
 *
 * Enough to see the shape of what the server answered — a JSON document's opening keys — and not the
 * document itself. Measured in the field: six `act_and_wait` calls asserting `{ urlContains, status
 * 200 }` through one interview each returned the server's whole answer, ~9.6KB of the same document
 * growing by one slot per step, so almost all of it was a re-send of what the agent already had. The
 * evidence block was 9,693 of an 11,194-byte result.
 *
 * Larger than `MAX_BODY_IN_FAILURE`, and deliberately: a failure quotes the value that DIFFERED and
 * knows which one that is, while a pass is showing the caller what came back and has no such anchor.
 */
const MAX_BODY_IN_EVIDENCE = 512;

/** Body fields a net predicate can read, and the clause that reads each. */
const BODY_EVIDENCE_FIELDS: Readonly<Record<string, string>> = {
  responseBody: 'bodyContains',
  requestBody: 'requestBodyContains',
};

/**
 * How much of the body around a matched needle is quoted.
 *
 * Enough to see the needle in its structure — the key it sits under, the value beside it — without
 * the document it came from.
 */
const BODY_MATCH_CONTEXT = 120;

/** Where a quoted window starts, and the elision markers that keep it honest at both ends. */
function windowAround(body: string, at: number, needle: string): string {
  const from = Math.max(0, at - BODY_MATCH_CONTEXT);
  const to = Math.min(body.length, at + needle.length + BODY_MATCH_CONTEXT);
  return `${from > 0 ? '…' : ''}${body.slice(from, to)}${to < body.length ? '…' : ''}`;
}

/** The head of a body, for a claim that never read it. Elision is VISIBLE — see the note below. */
function headOf(body: string): string {
  return body.length <= MAX_BODY_IN_EVIDENCE ? body : `${body.slice(0, MAX_BODY_IN_EVIDENCE)}…`;
}

/**
 * The matched call, as the proof of the claim that was actually made.
 *
 * A predicate asking about status and url is proved by status and url; returning the whole payload
 * beside them is cost with no bearing on the verdict. A predicate asking `bodyContains` is proved BY
 * the body, and that one keeps it in full — clipping a body a check consumed would be weakening the
 * check to make it cheaper, which is the trade this codebase does not make.
 */
export function netEvidence(
  data: Record<string, unknown>,
  p: Extract<Predicate, { kind: typeof PredicateKind.NET }>,
): unknown {
  const stripped = (withoutUrlRaw({ data }) as { data: unknown }).data;
  if (null === stripped || 'object' !== typeof stripped) return stripped;
  const clause = p as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...(stripped as Record<string, unknown>) };
  for (const [field, askedBy] of Object.entries(BODY_EVIDENCE_FIELDS)) {
    const body = out[field];
    if ('string' !== typeof body || body.length <= MAX_BODY_IN_EVIDENCE) continue;
    const needle = clause[askedBy];
    const at = 'string' === typeof needle ? body.indexOf(needle) : -1;
    if (at < 0) {
      // No clause read this body, or the pass came from elsewhere: the head shows the shape of the
      // answer. The ellipsis is load-bearing — a silently shortened body reads as "the server
      // answered this much", a different and wrong fact — and `responseSize` rides alongside
      // untouched, so the real length stays available and `reticle_network` fetches the rest.
      out[field] = headOf(body);
      continue;
    }
    // The clause matched. What proves it is the MATCH, not the document it was found in: the needle
    // in its context, plus where it was. Six field verdicts each returned the same 8KB interview
    // document to prove one substring of it, and the document proved nothing the window does not.
    out[field] = windowAround(body, at, needle as string);
    out['bodyMatchAt'] = at;
  }
  return out;
}
