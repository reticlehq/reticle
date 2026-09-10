/**
 * Asserting on what the UI SENT, not on what came back (#798).
 *
 * `net.bodyContains` searches the response only, and the comment on it says why: searching the
 * request too would let it pass on the very defect it exists to catch (the app sent `1187.01`, so
 * that string is in the request whatever the server then did with it). That reasoning is right, and
 * it leaves a real gap. For a filter, a search box or a form, the thing under test IS the outgoing
 * payload — "applying this filter actually sends it" had no verdict at all, only
 * `reticle_network { bodies: true }` and a person reading `requestBody` by eye.
 *
 * So these are separate fields rather than a mode on `bodyContains`: neither assertion can then be
 * satisfied by the wrong half of the exchange.
 *
 * Extracted from `predicate-eval.ts`, which was at the 1000-line cap.
 */
import { REDACTED_VALUE } from '@reticlehq/core';
import {
  clipBody,
  dataMatches,
  describeNetFilter,
  str,
  type EvalResult,
} from './predicate-eval.js';
import type { PredicateKind } from '@reticlehq/core';
import type { Predicate } from './predicate-schema.js';

/** The net predicate as `describeNetFilter` types it. */
type NetPredicate = Extract<Predicate, { kind: typeof PredicateKind.NET }>;

/** A net predicate, narrowed to the fields this module reads. */
interface RequestBodyPredicate {
  requestBodyContains?: string;
  requestBodyMatches?: Record<string, unknown>;
}

/**
 * What the filtering pass learned about calls that matched everything else.
 *
 * Accumulated during the single pass over events rather than recomputed after it, the way the
 * response-side trackers already are.
 */
export interface RequestBodyState {
  /** A call matched everything else but carried no recorded request body. */
  unrecorded: boolean;
  /** The request body a clause was checked against and did not match. */
  mismatch?: string;
  /** The prefix of a TRUNCATED request body the clause did not hold over — undecidable, not absent. */
  truncated?: string;
  /**
   * A key whose CAPTURED value is `[REDACTED]`, so the clause cannot be judged at all.
   *
   * Request bodies go through the same redaction path as responses before they are ever recorded,
   * so a clause on a sensitive key is unsatisfiable whatever the app sent. Grading that a mismatch
   * would blame the application for the SDK's own redaction and send someone to fix a correct
   * payload.
   */
  redactedField?: string;
}

export function newRequestBodyState(): RequestBodyState {
  return { unrecorded: false };
}

/**
 * Does this event satisfy the predicate's request-body clauses? Records why not in `state`.
 *
 * Returns true when there is nothing to check, so callers can apply it unconditionally.
 */
export function checkRequestBody(
  data: Record<string, unknown>,
  predicate: RequestBodyPredicate,
  state: RequestBodyState,
): boolean {
  const { requestBodyContains, requestBodyMatches } = predicate;
  if (undefined === requestBodyContains && undefined === requestBodyMatches) return true;

  const sent = str(data['requestBody']);
  if (sent === undefined) {
    state.unrecorded = true;
    return false;
  }
  const wasTruncated = true === data['requestBodyTruncated'];
  const note = (): false => {
    // The same rule the response side keeps: a needle missing from a body we hold only the first N
    // bytes of is undecidable, not absent.
    if (wasTruncated) state.truncated ??= sent;
    else state.mismatch ??= sent;
    return false;
  };

  if (requestBodyContains !== undefined && !sent.includes(requestBodyContains)) return note();
  if (requestBodyMatches === undefined) return true;

  let payload: unknown;
  try {
    payload = JSON.parse(sent);
  } catch {
    // Not JSON (a form post, plain text). A shallow key match cannot be applied, and guessing at
    // form encoding here would answer a different question than the one asked. Use
    // `requestBodyContains` for those.
    return note();
  }
  if (null === payload || typeof payload !== 'object' || Array.isArray(payload)) return note();

  const actual = payload as Record<string, unknown>;
  const redacted = Object.keys(requestBodyMatches).find((key) => REDACTED_VALUE === actual[key]);
  if (redacted !== undefined) {
    state.redactedField ??= redacted;
    return false;
  }
  return dataMatches(actual, requestBodyMatches) ? true : note();
}

/**
 * The verdict for a request-body clause nothing satisfied, or `undefined` to fall through.
 *
 * Ranked the way the response side ranks its own: the two nobody could have answered (redacted,
 * unrecorded, truncated) come before the one that WAS answered and came out false.
 */
export function requestBodyVerdict(
  state: RequestBodyState,
  predicate: NetPredicate,
  matchCount: number,
): EvalResult | undefined {
  if (matchCount > 0) return undefined;
  const wanted = JSON.stringify(predicate.requestBodyContains ?? predicate.requestBodyMatches);

  if (state.redactedField !== undefined) {
    const field = JSON.stringify(state.redactedField);
    return {
      pass: false,
      inconclusive: `a call matching ${describeNetFilter(predicate)} was made, but its ${field} was REDACTED before the body was recorded, so this clause cannot be judged — a redacted field is unknown, not different. Assert on a non-sensitive key, or on the effect the value had`,
      observed: `a matching request whose ${field} is ${REDACTED_VALUE}`,
      expected: `a request body matching ${wanted}`,
      assertion: 'net.requestBodyMatches',
    };
  }
  if (state.unrecorded) {
    return {
      pass: false,
      failureReason: `a call matched but its REQUEST body was not recorded, so the request-body clause could not be checked — enable it where the app calls connect(): reticle({ captureNetworkBodies: true })`,
      observed: 'a matching call with no recorded request body',
      expected: `a request body matching ${wanted}`,
      assertion: 'net.requestBody',
    };
  }
  if (state.truncated !== undefined) {
    return {
      pass: false,
      inconclusive: `a call matching ${describeNetFilter(predicate)} was sent with a request body that was TRUNCATED before it was recorded, and the clause did not hold over the part that was kept — so this is undecidable, not a failure`,
      observed: `the first ${String(state.truncated.length)} characters of a truncated request body ${JSON.stringify(clipBody(state.truncated))}`,
      expected: `a request body matching ${wanted}`,
      assertion: 'net.requestBody',
    };
  }
  if (state.mismatch !== undefined) {
    // Named separately from "no call matched", for the reason the response side already learned: the
    // request DID fire, and reporting zero matches sends the caller to check the url and the method,
    // which are both fine, instead of to the value the UI actually sent.
    return {
      pass: false,
      failureReason: `a call matching ${describeNetFilter(predicate)} was sent with ${JSON.stringify(clipBody(state.mismatch))}, which does not match the request-body clause — the request fired, the payload is what differed`,
      observed: `request body ${JSON.stringify(clipBody(state.mismatch))}`,
      expected: `a request body matching ${wanted}`,
      assertion: 'net.requestBody',
    };
  }
  return undefined;
}
