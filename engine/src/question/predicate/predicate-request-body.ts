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
  describeBodyFieldMiss,
  describeNetFilter,
  matchJsonBody,
  str,
  type EvalResult,
} from './predicate-eval-kit.js';
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
interface RequestBodyState {
  /** A call matched everything else but carried no recorded request body. */
  unrecorded: boolean;
  /** The body type the SDK named for an unrecorded request body, which it does only with capture on. */
  unrecordedType?: unknown;
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

/** What the SDK keeps with no setting, so an agent does not switch capture on for a body it has. */
export const BODY_CAPTURE_DEFAULTS =
  'A failed response (HTTP 400 and up) keeps its body by default. A request body, and the body of ' +
  'a successful response, need `captureNetworkBodies: true`.';

/** The remedy when capture is off: the defaults, then where the setting goes. */
export const REMEDY_BODY_CAPTURE =
  `${BODY_CAPTURE_DEFAULTS} Turn it on where the app calls connect(): ` +
  '`reticle.connect({ captureNetworkBodies: true })`, or in the Vite plugin: ' +
  '`reticle({ captureNetworkBodies: true })`.';

/**
 * The remedy for a request body the SDK did not record although capture is on, or `undefined`.
 *
 * With capture on, the SDK names the type of a body it cannot stringify (`requestBodyType`: a
 * `Blob`, a `FormData`, a stream). "Enable captureNetworkBodies" is then wrong advice (#1520).
 */
export function requestBodySkipRemedy(bodyType: unknown): string | undefined {
  if ('string' !== typeof bodyType || 0 === bodyType.length) return undefined;
  return `the request body was a ${bodyType}, which the SDK does not record as text, and capture is already on. Assert on the response or on the effect the request had instead`;
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
    state.unrecordedType ??= data['requestBodyType'];
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

  // `matchJsonBody` is the shared one, and a body that is not a JSON object counts as a mismatch
  // there for the reason this side already had written down: guessing at form encoding would answer
  // a different question than the one asked, and `requestBodyContains` exists for those bodies.
  const verdict = matchJsonBody(sent, requestBodyMatches);
  if ('match' === verdict) return true;
  if ('mismatch' === verdict) return note();
  state.redactedField ??= verdict.redacted;
  return false;
}

/**
 * The verdict for a request-body clause nothing satisfied, or `undefined` to fall through.
 *
 * Ranked the way the response side ranks its own: the two nobody could have answered (redacted,
 * unrecorded, truncated) come before the one that WAS answered and came out false.
 *
 * `responseMismatch` is the response body of a call whose request DID satisfy the clause and whose
 * response did not. When it is set, a definite request mismatch on some OTHER call is not the
 * explanation and yields to it; the unknowns above still win, because the call they describe may
 * be the one that would have satisfied the whole predicate.
 */
export function requestBodyVerdict(
  state: RequestBodyState,
  predicate: NetPredicate,
  matchCount: number,
  responseMismatch?: string,
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
    // Unknown, not different: nothing was read, so nothing says the body did not match (#1520).
    const reason = `a call matched but its REQUEST body was not recorded, so the request-body clause could not be checked — ${requestBodySkipRemedy(state.unrecordedType) ?? REMEDY_BODY_CAPTURE}`;
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
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
  if (state.mismatch !== undefined && responseMismatch === undefined) {
    // Named separately from "no call matched", for the reason the response side already learned: the
    // request DID fire, and reporting zero matches sends the caller to check the url and the method,
    // which are both fine, instead of to the value the UI actually sent.
    const field =
      predicate.requestBodyMatches === undefined
        ? undefined
        : describeBodyFieldMiss(state.mismatch, predicate.requestBodyMatches);
    const because = field === undefined ? '' : `: ${field}`;
    return {
      pass: false,
      failureReason: `a call matching ${describeNetFilter(predicate)} was sent with ${JSON.stringify(clipBody(state.mismatch))}, which does not match the request-body clause${because} — the request fired, the payload is what differed`,
      observed: `request body ${JSON.stringify(clipBody(state.mismatch))}${because}`,
      expected: `a request body matching ${wanted}`,
      assertion: 'net.requestBody',
    };
  }
  return undefined;
}
