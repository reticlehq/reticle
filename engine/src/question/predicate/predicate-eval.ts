import {
  EventType,
  NetInitiator,
  PredicateKind,
  ResponseBodyReason,
  SettledChannel,
  StreamDirection,
  isDevToolingUrl,
  isForeignTraffic,
  urlForMatch,
  REDACTED_VALUE,
  type ReticleEvent,
} from '@reticlehq/core';
import { isReticleVoice } from '../../state-bookkeeping.js';
import { describeObserved } from './observed-in-window.js';
import { netEvidence } from './net-evidence.js';
import { truncatedBodyAdvice } from './truncated-body-advice.js';
import { mergeNetworkDetail, withDownloadRequests } from '@/window/network-detail-merge.js';
import { departedInWindow } from '@/window/event-filters.js';
import {
  checkRequestBody,
  REMEDY_BODY_CAPTURE,
  newRequestBodyState,
  requestBodyVerdict,
} from './predicate-request-body.js';
export { evalConsole } from './predicate-console.js';
import type { Predicate } from './predicate-schema.js';
import {
  clipBody,
  dataMatches,
  describeBodyFieldMiss,
  describeFieldMiss,
  describeNetFilter,
  matchJsonBody,
  num,
  redactedOnPath,
  str,
  type EvalResult,
} from './predicate-eval-kit.js';
import { keyFragmentOnly } from './body-key-fragment.js';
import { evalExactCount } from '@/exact-count.js';
import {
  PRE_ATTACH_CAVEAT,
  mediaLoadReason,
  nativeDownloadReason,
  targetsMediaLoad,
  targetsNativeDownload,
  targetsUnobservedChannel,
  unobservedChannelReason,
} from './net-blind-spots.js';
export {
  clipBody,
  dataMatches,
  describeNetFilter,
  matchValue,
  str,
  type EvalResult,
} from './predicate-eval-kit.js';

/** The oracle a net body clause reports, so an agent can branch on which one decided. */
const NetBodyAssertion = {
  CONTAINS: 'net.bodyContains',
  MATCHES: 'net.bodyMatches',
} as const;
type NetBodyClause = (typeof NetBodyAssertion)[keyof typeof NetBodyAssertion];

// The predicate SHAPE — the discriminated union, its aliases and its zod schema — lives in
// predicate-schema.ts, and is re-exported here: the two halves are ONE public surface.
export * from './predicate-schema.js';

/**
 * Did this call succeed, as the app experienced it?
 *
 * `ok` is authoritative when present — IPC sets it explicitly, because an IPC call has no status
 * code and the 200/500 Reticle derives is a convenience, not a fact. Falling back to the HTTP status
 * keeps ordinary web requests working without the observer having to set the field everywhere.
 *
 * This exists so an agent can assert on the OUTCOME rather than on a number Reticle invented.
 */
function callSucceeded(data: Record<string, unknown>): boolean {
  if ('boolean' === typeof data['ok']) {
    return data['ok'];
  }
  const status = num(data['status']);
  return status === undefined || status < 400;
}

/**
 * One call, as the failure report should name it: `POST /api/generate-script → 500`.
 *
 * The status used to be dropped here, which made the most common net failure unreadable. Asserting
 * `{status: 200}` against a call that returned 500 reported only `POST /api/generate-script` — the
 * very field the predicate filtered on was missing from the account of what was seen, so the agent
 * is told the call happened and left to guess why it did not match.
 *
 * The arrow is OMITTED when there is no status. An in-flight or aborted request genuinely has none,
 * and `→ undefined` would be a fabricated fact about the wire.
 */
function describeCall(e: ReticleEvent): string {
  const head = `${str(e.data['method']) ?? 'GET'} ${str(e.data['url']) ?? ''}`;
  const status = num(e.data['status']);
  return status === undefined ? head : `${head} → ${String(status)}`;
}

/**
 * What a miss should say when the displayed URL was redacted. Matching uses `urlRaw` when present;
 * an older SDK has no copy, so the miss has to say which of the two it is.
 */
const REDACTED_PATH_HINT =
  'this path segment was redacted — the literal you matched may be here, try bodyContains';

function observedNetCalls(
  events: readonly ReticleEvent[],
  urlContains: string | undefined,
): string {
  const calls = events.filter((e) => e.type === EventType.NET_REQUEST);
  const base = describeObserved('calls', calls.map(describeCall));
  if (urlContains === undefined) {
    return base;
  }
  const encoded = encodeURIComponent(REDACTED_VALUE);
  const redacted = calls.some((e) => {
    const url = str(e.data['url']) ?? '';
    return url.includes(REDACTED_VALUE) || url.includes(encoded);
  });
  return redacted ? `${base}; ${REDACTED_PATH_HINT}` : base;
}

/** Same, for a signal: the matcher as applied, with the cardinality and the floor taken out. */
function describeSignalFilter(
  p: Extract<Predicate, { kind: typeof PredicateKind.SIGNAL }>,
): string {
  const { kind: _kind, count: _count, since: _since, ...filter } = p;
  return JSON.stringify(filter);
}

function nativeDownloadMiss(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.NET }>,
): EvalResult | undefined {
  const media = targetsMediaLoad(p.urlContains);
  if (
    !media &&
    !targetsNativeDownload(p.urlContains) &&
    !departedInWindow(events, p.since ?? 0, p.method, p.urlContains)
  ) {
    return undefined;
  }
  const filter = describeNetFilter(p);
  const reason = media ? mediaLoadReason(filter) : nativeDownloadReason(filter);
  return {
    pass: false,
    failureReason: reason,
    inconclusive: reason,
    observed: observedNetCalls(events, p.urlContains),
    expected: `a fetch or XHR matching ${filter}`,
    assertion: media ? 'net.media-load' : 'net.native-download',
  };
}

/**
 * Initiator types the browser SDK's resource-timing observer stamps onto document-initiated records
 * (adapters/realm/browser/src/observers/network.ts). The patched transports sign themselves `fetch`,
 * `xhr` or `beacon`, so any NET_REQUEST carrying one of these came from a `resource` entry, and its
 * mere presence is proof the PerformanceObserver is alive on this page. Mirrors the wire; keep in
 * sync with the browser package.
 */
const DOCUMENT_INITIATORS: ReadonlySet<string> = new Set([
  'link',
  'css',
  'img',
  'script',
  'manifest',
  'other',
]);

/**
 * Whether a request was a subresource the DOCUMENT fetched (script, stylesheet, image…), as the
 * resource-timing observer stamps them, rather than one the app sent through fetch, XHR, a beacon or
 * IPC. The capsule's blast radius uses it to keep a page load out of "what this action also did".
 */
export function isDocumentInitiated(event: ReticleEvent): boolean {
  if (event.type !== EventType.NET_REQUEST) {
    return false;
  }
  const initiator = str(event.data['initiator']);
  return initiator !== undefined && DOCUMENT_INITIATORS.has(initiator);
}

/**
 * Did the observer actually report a document-initiated load?
 *
 * This is the gate on the unobserved-channel downgrade above. Once subresource observation landed,
 * a miss over `.ico`/`.css`/`.woff2` is no longer inherently unknowable: if the observer is live it
 * would have seen the favicon load, so seeing none is evidence it never fired. But the observer is
 * opt-in-by-engine, not guaranteed: on a renderer without `PerformanceObserver` (or before any
 * resource entry exists) nothing distinguishes "not requested" from "not visible", and the honest
 * answer stays inconclusive. Liveness is inferred from the same events being judged: one
 * document-initiated record anywhere in the window proves the channel works.
 */
function observerSawSubresources(events: ReticleEvent[]): boolean {
  return events.some(isDocumentInitiated);
}

/**
 * The response-body clause as the caller wrote it, for a verdict that has to quote it.
 *
 * One expression rather than two, because every body verdict below is the same sentence whichever
 * clause asked the question, and printing `undefined` where the clause was `bodyMatches` is how a
 * verdict stops being readable.
 */
function wantedBody(p: Extract<Predicate, { kind: typeof PredicateKind.NET }>): string {
  return JSON.stringify(p.bodyContains ?? p.bodyMatches);
}

/**
 * The remedy for a body the SDK skipped ON PURPOSE with capture on, or `undefined` (#1520).
 *
 * Shared by every message that would otherwise say "enable captureNetworkBodies": that advice is
 * wrong when capture is already on and the body was a stream, a binary type, or a read that did
 * not finish. `undefined` means no reason was stamped: capture was off, or the SDK predates it.
 */
export function skippedBodyRemedy(reason: unknown): string | undefined {
  if (ResponseBodyReason.STREAMING === reason) {
    return 'The body was streamed in an unsupported format (such as ndjson), and capture is already on. Assert the result in the DOM or in state instead, or use a non-streaming endpoint.';
  }
  if (ResponseBodyReason.NOT_TEXT === reason) {
    return 'The body is not text (binary, or a content type that is not recorded), and capture is already on. Assert the result in the DOM or in state instead.';
  }
  if (ResponseBodyReason.UNREADABLE === reason) {
    return 'The body is not available yet or could not be read, and capture is already on. SSE capture can take up to 10 seconds. Use wait_for with a sufficient timeout to retry the body assertion. If the body remains unavailable, assert the result in the DOM or in state instead.';
  }
  return undefined;
}

/** The skip reason every one of these calls carries, when they all carry the same one. */
export function sharedSkipReason(reasons: readonly unknown[]): unknown {
  const [first] = reasons;
  if (first === undefined) {
    return undefined;
  }
  return reasons.every((r) => r === first) ? first : undefined;
}

/** Why a matched call's body could not answer a body clause, and what to do instead (#1520). */
function unrecordedBodyReason(
  p: Extract<Predicate, { kind: typeof PredicateKind.NET }>,
  reason: unknown,
): string {
  const head = `a call matching ${describeNetFilter(p)} was answered, but its body was not recorded, so ${wantedBody(p)} could not be checked, which is not the same as absent.`;
  return `${head} ${skippedBodyRemedy(reason) ?? REMEDY_BODY_CAPTURE}`;
}

export function evalNet(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.NET }>,
  sdkVersion?: string,
): EvalResult {
  // SSE headers close the request immediately. A later detail supplies its captured body without another call.
  if (p.bodyContains !== undefined || p.bodyMatches !== undefined) {
    events = mergeNetworkDetail(events);
  } else {
    // A server-sent download is a request even when nothing asks for its body.
    events = withDownloadRequests(events);
  }
  const since = p.since ?? 0;
  /**
   * Computed once: the gate every zero-match downgrade below reads. True means the resource-timing
   * observer is demonstrably live in this window, so a miss is evidence rather than blindness.
   */
  const sawSubresources = observerSawSubresources(events);
  /**
   * Did any call match everything EXCEPT the body assertion, while carrying no recorded body?
   *
   * Bodies are opt-in, so without them a body predicate can never hold — and "no call matched" would
   * send the caller to check the url and the method, which are both fine, instead of to the one
   * setting that makes the assertion possible. Tracked while filtering rather than recomputed after,
   * because it is the same pass over the same events.
   */
  let matchedButUnrecorded = false;
  /** Why the SDK skipped that body, when it said (#1520). Absent: capture off, or an older SDK. */
  let unrecordedReason: unknown;
  /** A call matched url/method but carried NO readable status (document-initiated subresource). */
  let unobservableStatus = false;
  /**
   * The response body of a call that matched everything EXCEPT the body assertion, and HAD one.
   *
   * Reported by the first field user of `bodyContains`: a body mismatch was formatted as
   * "expected 1 network call(s) matching {method, urlContains, status}, saw 0" — the body assertion
   * was applied but not printed — so the verdict read "the request never fired" and sent them hunting
   * a UI wiring bug that did not exist, when the defect was the value the server answered with.
   */
  let bodyMismatch: string | undefined;
  /**
   * The prefix of a TRUNCATED body the needle was not found in. Held apart from `bodyMismatch`
   * because the two are different verdicts: a full body without the needle decides the assertion,
   * a truncated one cannot (#614).
   */
  let truncatedBody: string | undefined;
  // Which clause the truncated body missed: a predicate can carry both, and the remedy for each differs.
  let truncatedClause: NetBodyClause | undefined;
  /**
   * A `bodyContains` needle that was FOUND, and found only inside a key name (#987).
   *
   * Not a match and not a miss: the substring is there, and it supports no claim about any value.
   * Held with the body it was found in, because the verdict has to show both.
   */
  let keyFragment: { key: string; body: string } | undefined;
  /** A response key whose captured value is `[REDACTED]`, so a `bodyMatches` clause is unjudgeable. */
  let redactedResponseField: string | undefined;
  const requestState = newRequestBodyState();
  const matches = events.filter((e) => {
    if (e.type !== EventType.NET_REQUEST || e.t < since) {
      return false;
    }
    const d = e.data;
    if (p.method !== undefined && str(d['method'])?.toUpperCase() !== p.method.toUpperCase()) {
      return false;
    }
    if (p.urlContains !== undefined && !urlForMatch(d).includes(p.urlContains)) {
      return false;
    }
    if (p.status !== undefined) {
      const status = num(d['status']);
      if (status === undefined) {
        // Document-initiated subresources (link/css/img/manifest via resource timing) carry no
        // readable status on engines without responseStatus. A failed assertion here would read
        // "your change is broken" and send the caller to fix working code — the exact false
        // negative the oracle exists to prevent. Downgrade to unknown instead.
        unobservableStatus = true;
        return false;
      }
      if (status !== p.status) {
        return false;
      }
    }
    if (p.ok !== undefined && callSucceeded(d) !== p.ok) {
      return false;
    }
    if (!checkRequestBody(d, p, requestState)) {
      return false;
    }
    if (p.bodyContains !== undefined || p.bodyMatches !== undefined) {
      // The RESPONSE body only, and this is the whole point of these fields. Searching the request
      // too would let `bodyContains: "1187.01"` pass on the very defect it exists to catch: the app
      // SENT that number, so it is in the request whatever the server then did with it. The server's
      // answer is the one channel a UI cannot fake.
      const response = str(d['responseBody']);
      if (response === undefined) {
        matchedButUnrecorded = true;
        unrecordedReason ??= d['responseBodyReason'];
        return false;
      }
      // A needle missing from a body we only hold the FIRST N BYTES of is undecidable, not absent:
      // the rest of the response was never recorded, so nothing here can say whether it was in
      // there (#614). Grading it `pass: false` with "the response value is what differed" is the
      // inversion the honesty rules exist to prevent — an unknown reported as decided, against a
      // response that was very likely correct.
      const missed = (clause: NetBodyClause): false => {
        if (true === d['responseBodyTruncated']) {
          truncatedBody ??= response;
          truncatedClause ??= clause;
        } else {
          bodyMismatch ??= response;
        }
        return false;
      };
      if (p.bodyContains !== undefined) {
        if (!response.includes(p.bodyContains)) {
          return missed(NetBodyAssertion.CONTAINS);
        }
        const fragment = keyFragmentOnly(response, p.bodyContains);
        if (fragment !== undefined) {
          keyFragment ??= { key: fragment, body: response };
          return false;
        }
      }
      if (p.bodyMatches !== undefined) {
        const verdict = matchJsonBody(response, p.bodyMatches);
        if ('mismatch' === verdict) {
          return missed(NetBodyAssertion.MATCHES);
        }
        if ('match' !== verdict) {
          redactedResponseField ??= verdict.redacted;
          return false;
        }
      }
    }
    return true;
  });
  if (unobservableStatus && 0 === matches.length) {
    // The url/method matched a document-initiated subresource whose engine could not read a status.
    // "No matching call" would be a lie in both directions: it may have succeeded, it may have 404'd
    // on exactly the path mistake the caller is hunting. Say the truth — not observable here.
    return {
      pass: false,
      inconclusive: `a document-initiated request matching ${describeNetFilter(p)} was observed, but this engine does not expose its status code (resource timing without responseStatus) — assert on the element or route instead, or check the network tab`,
      observed: 'a matching request with no readable status',
      expected: `a status of ${String(p.status)} on ${JSON.stringify(p.urlContains ?? '*')}`,
      assertion: 'net.unobservable-status',
    };
  }
  if (matchedButUnrecorded && 0 === matches.length) {
    // Inconclusive, never a plain failure: nothing says the body lacked the text, only that nobody
    // read it (#1520). The same family as evicted evidence answering `no` (#1231).
    const reason = unrecordedBodyReason(p, unrecordedReason);
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      observed: 'a matching call with no recorded body',
      expected: `a body carrying ${wantedBody(p)}`,
      assertion: NetBodyAssertion.CONTAINS,
    };
  }
  if (keyFragment !== undefined && 0 === matches.length) {
    // Ranked above every other body verdict, because it is the only one that used to be a PASS.
    return {
      pass: false,
      inconclusive: `a call matching ${describeNetFilter(p)} was answered with a body where ${JSON.stringify(p.bodyContains)} appears ONLY inside the key name ${JSON.stringify(keyFragment.key)} — no value in the response contains it, so this substring proves nothing about what any field holds. Assert the field itself: \`bodyMatches: { "<field>": <value> }\``,
      observed: `response body ${JSON.stringify(clipBody(keyFragment.body))}`,
      expected: `a response body carrying ${JSON.stringify(p.bodyContains)} as a value, or as a whole key`,
      assertion: NetBodyAssertion.CONTAINS,
    };
  }
  if (redactedResponseField !== undefined && 0 === matches.length) {
    const field = JSON.stringify(redactedResponseField);
    return {
      pass: false,
      inconclusive: `a call matching ${describeNetFilter(p)} was answered, but its ${field} was REDACTED before the body was recorded, so this clause cannot be judged — a redacted field is unknown, not different. Assert on a non-sensitive key, or on the effect the value had`,
      observed: `a matching response whose ${field} is ${REDACTED_VALUE}`,
      expected: `a response body matching ${JSON.stringify(p.bodyMatches)}`,
      assertion: NetBodyAssertion.MATCHES,
    };
  }
  // Ranked ABOVE the mismatch branch: when both a truncated and a full body missed the needle,
  // the honest verdict is the undecidable one. Deciding on the full body would report a failure
  // the truncated call may well contradict.
  if (truncatedBody !== undefined && 0 === matches.length) {
    // `bodyMatches` parses the whole body, and a JSON prefix never parses, so "assert on something
    // inside the recorded prefix" changes nothing for it: the same clause on the same prefix is the
    // same unknown. Name what can work for the clause that was actually asked (#1417). The grade
    // stays inconclusive either way: a partial parse must not decide it, since a later duplicate key
    // could overturn whatever the prefix seemed to say.
    const missedMatch = NetBodyAssertion.MATCHES === truncatedClause;
    return {
      pass: false,
      inconclusive: `a call matching ${describeNetFilter(p)} was answered with a body that was TRUNCATED before it was recorded, and ${wantedBody(p)} is not in the part that was kept — so this is undecidable, not a failure. ${truncatedBodyAdvice(sdkVersion, missedMatch)}`,
      observed: `the first ${String(truncatedBody.length)} characters of a truncated response body ${JSON.stringify(clipBody(truncatedBody))}`,
      expected: `a response body carrying ${wantedBody(p)}`,
      assertion: truncatedClause ?? NetBodyAssertion.CONTAINS,
    };
  }
  const requestVerdict = requestBodyVerdict(requestState, p, matches.length, bodyMismatch);
  if (requestVerdict !== undefined) {
    return requestVerdict;
  }
  if (bodyMismatch !== undefined && 0 === matches.length) {
    // The call is there and its body is there; only the VALUE differs. Counting it as zero matches
    // points at the wiring, which is the one place the defect is not. A field clause also names the
    // field that differed, because a 200-character clip may not reach it.
    const field =
      p.bodyMatches === undefined ? undefined : describeBodyFieldMiss(bodyMismatch, p.bodyMatches);
    const because = field === undefined ? '' : `: ${field}`;
    return {
      pass: false,
      failureReason: `a call matching ${describeNetFilter(p)} was made and answered ${JSON.stringify(clipBody(bodyMismatch))}, which does not carry ${wantedBody(p)}${because} — the request fired, the response value is what differed`,
      observed: `response body ${JSON.stringify(clipBody(bodyMismatch))}${because}`,
      expected: `a response body carrying ${wantedBody(p)}`,
      assertion: NetBodyAssertion.CONTAINS,
    };
  }
  // `count` (exact) turns presence into a cardinality assertion — catches the double-submit /
  // useEffect-double-fire / retry-storm regression class, where the request DID fire (presence passes)
  // but fired the WRONG number of times. Without `count`, the matcher is presence-only (≥1).
  if (p.count !== undefined) {
    if (0 === matches.length) {
      const download = nativeDownloadMiss(events, p);
      if (download !== undefined) {
        return download;
      }
    }
    if (
      matches.length !== p.count &&
      0 === matches.length &&
      targetsUnobservedChannel(p.urlContains) &&
      !sawSubresources
    ) {
      return {
        pass: false,
        failureReason: unobservedChannelReason(describeNetFilter(p)),
        inconclusive: unobservedChannelReason(describeNetFilter(p)),
        assertion: 'net.count',
      };
    }
    const counted = evalExactCount({
      matched: matches.length,
      want: p.count,
      noun: 'network call(s)',
      filter: describeNetFilter(p),
      assertion: 'net.count',
    });
    // Same blind head, second door: "saw 0" over a whole-session window is the same claim the
    // presence branch makes, and just as unable to see a startup call. A `count: 0` assertion is
    // left alone on purpose — it PASSES here, and turning that green into a non-pass is a grade
    // change, not a wording one.
    return 0 === matches.length && 0 === since && counted.failureReason !== undefined
      ? { ...counted, failureReason: `${counted.failureReason}${PRE_ATTACH_CAVEAT}` }
      : counted;
  }
  const hit = matches[0];
  if (hit === undefined) {
    const download = nativeDownloadMiss(events, p);
    if (download !== undefined) {
      return download;
    }
  }
  if (hit === undefined && targetsUnobservedChannel(p.urlContains) && !sawSubresources) {
    const reason = unobservedChannelReason(describeNetFilter(p));
    return {
      pass: false,
      failureReason: reason,
      inconclusive: reason,
      observed: observedNetCalls(events, p.urlContains),
      expected: `at least one call matching ${describeNetFilter(p)}`,
      assertion: 'net.unobserved-channel',
    };
  }
  return hit !== undefined
    ? { pass: true, evidence: netEvidence(hit.data, p) }
    : {
        pass: false,
        failureReason: `no network call matched ${JSON.stringify(p)}${0 === since ? PRE_ATTACH_CAVEAT : ''}`,
        // Same reasoning as the signal miss: "no matching call" cannot be told apart from "the app
        // made no calls at all", and those need different fixes.
        observed: observedNetCalls(events, p.urlContains),
        expected: `at least one call matching ${JSON.stringify(p)}`,
        assertion: 'net.present',
      };
}

export function evalAnimation(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.ANIMATION }>,
): EvalResult {
  const wantType = true === p.completed ? EventType.ANIM_END : EventType.ANIM_START;
  const hit = events.find((e) => {
    if (e.type !== wantType) {
      return false;
    }
    const name = str(e.data['name']);
    // A check with no name asks about the app, so Reticle's own bookkeeping signals do not count.
    if (p.name === undefined ? isReticleVoice(name ?? '') : name !== p.name) {
      return false;
    }
    if (p.target !== undefined && e.ref !== p.target) {
      return false;
    }
    return true;
  });
  return hit !== undefined
    ? { pass: true, evidence: hit.data }
    : {
        pass: false,
        failureReason: `no animation matched ${JSON.stringify(p)}`,
        observed: 'no matching animation in the window',
        expected: `an animation matching ${JSON.stringify(p)}`,
        assertion: 'animation.present',
      };
}

export function evalSignal(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.SIGNAL }>,
): EvalResult {
  /**
   * A pattern key the transport sanitizer redacted on a payload of the right name. The marker is
   * written for a sensitive key whatever it held, so neither `*` nor a value can be judged against it
   * — the same rule the body clauses keep.
   */
  let redactedField: string | undefined;
  const isMatch = (e: ReticleEvent): boolean => {
    if (e.type !== EventType.SIGNAL) {
      return false;
    }
    const name = str(e.data['name']);
    // A check with no name asks about the app, so Reticle's own bookkeeping signals do not count.
    if (p.name === undefined ? isReticleVoice(name ?? '') : name !== p.name) {
      return false;
    }
    if (p.dataMatches !== undefined) {
      const payload = (e.data['data'] ?? {}) as Record<string, unknown>;
      const hidden =
        'object' === typeof payload
          ? Object.keys(p.dataMatches).find((key) => redactedOnPath(payload, key))
          : undefined;
      if (hidden !== undefined) {
        redactedField ??= hidden;
        return false;
      }
      if (!dataMatches(payload, p.dataMatches)) {
        return false;
      }
    }
    return true;
  };
  const redactedVerdict = (): EvalResult | undefined => {
    if (redactedField === undefined) {
      return undefined;
    }
    const field = JSON.stringify(redactedField);
    return {
      pass: false,
      inconclusive: `signal '${p.name ?? '(any)'}' fired, but its ${field} was REDACTED before it was recorded, so this clause cannot be judged — a redacted field is unknown, not different. Assert on a non-sensitive key, or on the effect the value had`,
      observed: `a signal payload whose ${field} is ${REDACTED_VALUE}`,
      expected: `signal '${p.name ?? '(any)'}' with payload matching ${JSON.stringify(p.dataMatches)}`,
      assertion: 'signal.payload',
    };
  };

  // `count` (exact) turns presence into a cardinality assertion, exactly as it does on `net`. The
  // double-fire is invisible to every state-only oracle — a handler wired twice leaves the store in
  // the right shape and fires the signal twice — and so is the wrong-name fire, where the intended
  // signal fires once beside a mistyped sibling and a presence check cannot say which is which.
  // Counting only what the MATCHER matched is what separates them. Omit = presence (≥1).
  if (p.count !== undefined) {
    const matched = events.filter(isMatch).length;
    // A redacted payload might have been one of the matches, so no count over it is decided.
    const unjudgeable = redactedVerdict();
    if (unjudgeable !== undefined) {
      return unjudgeable;
    }
    return evalExactCount({
      matched,
      want: p.count,
      noun: 'signal(s)',
      filter: describeSignalFilter(p),
      assertion: 'signal.count',
    });
  }

  const hit = events.find(isMatch);
  if (hit !== undefined) {
    return { pass: true, evidence: hit.data };
  }
  // `find` scanned every event to get here, so a redacted payload has been seen if there was one.
  const unjudgeable = redactedVerdict();
  if (unjudgeable !== undefined) {
    return unjudgeable;
  }

  // Near-miss: show signals that fired with the same name (so the agent sees the real data).
  const sameName = events
    .filter(
      (e) =>
        e.type === EventType.SIGNAL && (p.name === undefined || str(e.data['name']) === p.name),
    )
    .map((e) => e.data['data'] ?? e.data);
  const first = sameName[0];
  const fieldMiss =
    p.dataMatches !== undefined && 'object' === typeof first && first !== null
      ? describeFieldMiss(first as Record<string, unknown>, p.dataMatches)
      : undefined;
  return {
    pass: false,
    failureReason:
      sameName.length > 0
        ? `signal '${p.name ?? '(any)'}' fired ${String(sameName.length)}x but data didn't match`
        : `no signal matched ${JSON.stringify(p)}`,
    observed:
      sameName.length > 0
        ? `signal '${p.name ?? '(any)'}' fired ${String(sameName.length)}x, payload: ${JSON.stringify(first)}${fieldMiss === undefined ? '' : `; ${fieldMiss}`}`
        : // Name what DID fire: a typo'd signal name and a genuinely dead action produce the same
          // sentence otherwise, and the agent cannot tell them apart. See observed-in-window.ts.
          `signal '${p.name ?? '(any)'}' never fired; ${describeObserved(
            'signals',
            events.filter((e) => e.type === EventType.SIGNAL).map((e) => str(e.data['name']) ?? ''),
          )}`,
    expected:
      p.dataMatches === undefined
        ? `signal '${p.name ?? '(any)'}' to fire`
        : `signal '${p.name ?? '(any)'}' with payload matching ${JSON.stringify(p.dataMatches)}`,
    // Two distinct failures behind one prose line: never fired at all, versus fired with the wrong
    // payload. They call for different fixes, so the agent should not have to tell them apart by
    // reading the sentence.
    assertion: sameName.length > 0 ? 'signal.payload' : 'signal.absent',
    evidence: sameName.length > 0 ? { nearMiss: sameName } : undefined,
  };
}

/**
 * Assert a value inside a registered store — the deterministic source of truth no DOM/network read
 * can reach. Reads the store (STATE_READ), walks `path` (dot-path, numeric array indices), and matches
 * the value against `equals` (a literal, `*` for presence, or a `{$gte,$contains,$length,…}` operator
 * pattern — same matcher as signal `dataMatches`). This is what turns "the UI lies about the store"
 * from a manual three-step catch into a one-line, LLM-free regression invariant a flow can carry.
 */

/**
 * Activity that resets the "quiet" timer for a `settled` predicate: network calls and STRUCTURAL DOM
 * mutations (nodes added/removed, attributes changed). Deliberately EXCLUDES `dom.text` and animation
 * frames: a count-up counter, a spinner, a pulsing dot, or any looping CSS animation emits a text/anim
 * event every frame forever, so an app with ambient motion would NEVER go quiet (observed live: one
 * login flooded 319 dom.text events from the dashboard's count-up animations). That is the same trap
 * that got Playwright's `networkidle` deprecated. Network + structural DOM are the real "the app is
 * still doing work" signals; for an outcome gated on an animation finishing, assert that specific
 * consequence (signal/net) instead of relying on settle.
 */
const SETTLE_ACTIVITY: ReadonlySet<EventType> = new Set([
  EventType.NET_REQUEST,
  EventType.DOM_ADDED,
  EventType.DOM_REMOVED,
  EventType.DOM_ATTR,
]);

/** An app-scoped settle: the default's activity, and every framework render commit. */
const APP_ACTIVITY: ReadonlySet<EventType> = new Set([...SETTLE_ACTIVITY, EventType.RENDER_COMMIT]);

/** The quiet window of a network-scoped settle: a completed request is the only activity. */
const NETWORK_ACTIVITY: ReadonlySet<EventType> = new Set([EventType.NET_REQUEST]);

/** The three net-shaped event types a URL can be read off — the only ones dev tooling can produce. */
const NET_TYPES: ReadonlySet<EventType> = new Set([
  EventType.NET_PENDING,
  EventType.NET_REQUEST,
  EventType.NET_STREAM,
]);

/** Default quiet window — enough to absorb a render+xhr settle without waiting on slow polls. */
const DEFAULT_QUIET_MS = 500;
/** Work the app declared (`reticle.busy`; core's `RETICLE_BUSY_SIGNAL`); not imported: coupling only shrinks. */
const RETICLE_BUSY_SIGNAL = 'reticle:busy';

/**
 * Did the browser LEAVE for this record, rather than make a request whose result we will see?
 *
 * `NetInitiator.NAVIGATION` is emitted as a `NET_PENDING` — because that is exactly what it is — but
 * its completion goes to a document this session does not live into, so no `NET_REQUEST` can ever
 * match it. Counting it as outstanding means the first click on any outbound link or download button
 * wedges settle on that page for the rest of the session.
 *
 * The act wait (`server/src/surface/tools/act/settle-in-flight.ts`) has always excluded it and
 * `core/src/wire/net.ts` says it must be; this predicate counted it, so `act_and_wait { until:
 * settled }` after a plain `<a href>` never passed and agents dropped `settled` from their `until`.
 * Spelled against the shared constant rather than the string, so the two settle decisions cannot
 * drift onto two vocabularies.
 */
const isDeparture = (data: Record<string, unknown>): boolean =>
  data['initiator'] === NetInitiator.NAVIGATION;

/**
 * What the caller knows about whose traffic this is.
 *
 * Both members are OPTIONAL and both fail OPEN. `settled` used to answer "has the app finished?" over
 * whatever bytes were in the buffer, so a request that no other settle decision counts could hold it
 * open forever — and an assertion that can never pass is one agents delete from their `until`, which
 * costs them the honesty the predicate exists to provide. The fix is to ask the same two questions
 * the act wait asks; the caller who cannot answer them gets exactly the behaviour this had before.
 */
export interface SettleScope {
  /** The page under test — what makes a request third-party. Absent: nothing is foreign. */
  appUrl?: string | undefined;
  /** Same-origin endpoints the project declared as background. Absent: nothing is excluded. */
  background?: readonly string[] | undefined;
}

/**
 * "The page has gone quiet": no network/DOM/animation activity for at least `quietMs`. Needs the
 * wall-clock `now` (in the buffer's time base) because "no activity in the last N ms" is relative to
 * now, not to any buffered event — so `now` is injected (AGENTS.md rule 7), and the wait loop's
 * poll interval is what eventually flips this to pass once activity stops.
 */
export function evalSettled(
  allEvents: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.SETTLED }>,
  now: number,
  scope?: SettleScope,
): EvalResult {
  const quietMs = p.quietMs ?? DEFAULT_QUIET_MS;

  // Three kinds of traffic say nothing about whether the APP finished its work, and all three are
  // dropped from BOTH halves of the calculation below (in-flight AND the quiet timer) and DISCLOSED
  // on the evidence, never silently swallowed:
  //
  //   - dev tooling, the framework talking about ITSELF (see DevToolingChannel);
  //   - a departure, which by construction can never complete (see `NetInitiator.NAVIGATION`);
  //   - somebody else's host, or a same-origin endpoint the project declared (`isForeignTraffic`).
  //
  // The last two were counted here while `settle-in-flight.ts` and the contradiction pass dropped
  // them, so the product held two answers to one question. The predicate's answer was the wrong one:
  // after a plain `<a href>` click it reported "1 request(s) still in flight" forever, and a vendor
  // beacon made every assertion on such an app return `unknown / outcome_pending`.
  //
  // A departure is kept APART from foreign traffic all the way into the disclosure. The two are one
  // CLASSIFICATION and two EXPLANATIONS — both drop out of the count, but "the page left for another
  // document" and "somebody else's host answered" send a reader to different next steps, and one
  // list holding both makes the second the only thing the first can be read as.
  const ignoredDevTooling: string[] = [];
  const ignoredForeign: string[] = [];
  const ignoredDepartures: string[] = [];
  const events = allEvents.filter((e) => {
    if (!NET_TYPES.has(e.type)) {
      return true;
    }
    // Classified by `urlForMatch`, DISCLOSED by `url`: redaction rewrites sensitive path segments at
    // emit time (`/auth/token/refresh-context` -> `/auth/token/[REDACTED]`), and a declared
    // `background` pattern is matched with `String.includes` — so classifying on the displayed URL
    // would let a redacted segment put the endpoint back in the in-flight count, which is the defect
    // this whole branch exists to fix. The haystack is the raw request; the transcript gets the
    // displayed one. Same division of labour `urlContains` uses at the top of this file.
    const matchUrl = urlForMatch(e.data);
    const shown = str(e.data['url']);
    if (isDevToolingUrl(matchUrl)) {
      if (shown !== undefined && !ignoredDevTooling.includes(shown)) {
        ignoredDevTooling.push(shown);
      }
      return false;
    }
    // Departure first: a departure to the app's own origin is still a request whose result nobody
    // will see, and reporting it as somebody else's host would be the wrong explanation.
    if (isDeparture(e.data)) {
      if (shown !== undefined && !ignoredDepartures.includes(shown)) {
        ignoredDepartures.push(shown);
      }
      return false;
    }
    if (isForeignTraffic(matchUrl, scope?.appUrl, scope?.background ?? [])) {
      if (shown !== undefined && !ignoredForeign.includes(shown)) {
        ignoredForeign.push(shown);
      }
      return false;
    }
    return true;
  });
  // Three separate lists rather than one: "the framework talking about itself", "the page left", and
  // "somebody else's host" are three different facts about a window, and a reader told only one of
  // them has to guess which it was.
  const disclosure = {
    ...(0 === ignoredDevTooling.length ? {} : { ignoredDevTooling }),
    ...(0 === ignoredForeign.length ? {} : { ignoredForeign }),
    ...(0 === ignoredDepartures.length ? {} : { ignoredDepartures }),
  };

  // A request that STARTED (NET_PENDING) but never completed (NET_REQUEST with the same id) is
  // still in flight — the page is NOT settled no matter how quiet the DOM has gone. Without this,
  // a slow save reads as "settled" the instant its spinner stops mutating the DOM: the exact
  // false-green `settled` exists to prevent.
  //
  // COUNT per id, don't just set-membership: a retry that reuses a request id (two NET_PENDING, one
  // NET_REQUEST) would mark the id "done" and hide the second, still-flying request — an in-flight
  // UNDERCOUNT that greens settle while a request is live. In-flight for an id is pendings minus
  // completions (floored at 0); unkeyed pendings each count as one.
  const pendingById = new Map<string, number>();
  const doneById = new Map<string, number>();
  let unkeyedPending = 0;
  for (const e of events) {
    if (e.type === EventType.NET_PENDING) {
      const id = str(e.data['id']);
      if (id === undefined) {
        unkeyedPending += 1;
      } else {
        pendingById.set(id, (pendingById.get(id) ?? 0) + 1);
      }
    } else if (e.type === EventType.NET_REQUEST) {
      const id = str(e.data['id']);
      if (id !== undefined) {
        doneById.set(id, (doneById.get(id) ?? 0) + 1);
      }
    }
  }
  let inFlight = unkeyedPending;
  for (const [id, pending] of pendingById) {
    inFlight += Math.max(0, pending - (doneById.get(id) ?? 0));
  }

  // A completed request whose BODY is still streaming is not a finished request. `fetch` resolves at
  // HEADERS, so on a Next.js App Router page the RSC payload reported complete 16 ms in while the
  // Suspense boundary's content arrived 889 ms later — and the silence between them read as a settled
  // page with a loading spinner still on screen. An OPEN with no CLOSE is in flight, counted the same
  // way as a pending with no completion.
  const openStreams = new Set<string>();
  for (const e of events) {
    if (e.type !== EventType.NET_STREAM) {
      continue;
    }
    const id = str(e.data['id']);
    if (id === undefined) {
      continue;
    }
    const direction = str(e.data['direction']);
    if (StreamDirection.OPEN === direction) {
      openStreams.add(id);
    } else if (StreamDirection.CLOSE === direction) {
      openStreams.delete(id);
    }
  }
  const streaming = openStreams.size;

  // Work only the app can see (`reticle.busy`): starts minus ends, in order, never below zero, so an
  // end whose start fell before this window is not credit against work started inside it.
  let appBusy = 0;
  for (const e of events) {
    if (e.type !== EventType.SIGNAL || RETICLE_BUSY_SIGNAL !== e.data['name']) {
      continue;
    }
    const delta = (e.data['data'] as { delta?: unknown } | undefined)?.delta;
    if ('number' === typeof delta) {
      appBusy = Math.max(0, appBusy + Math.sign(delta));
    }
  }
  if (appBusy > 0 && 0 === inFlight + streaming) {
    const what = `${String(appBusy)} app task(s) still pending`;
    return {
      pass: false,
      failureReason: `not settled: ${what}`,
      observed: what,
      expected: 'no work the app declared still pending',
      assertion: 'settled.app-busy',
      evidence: { settled: false, appBusy, ...disclosure },
    };
  }

  if (inFlight + streaming > 0) {
    let what = `${String(inFlight)} request(s) in flight and ${String(streaming)} response body(ies) still streaming`;
    if (0 === streaming) {
      what = `${String(inFlight)} request(s) still in flight`;
    } else if (0 === inFlight) {
      what = `${String(streaming)} response body(ies) still streaming`;
    }
    return {
      pass: false,
      failureReason: `not settled: ${what}`,
      observed: what,
      expected: 'no requests in flight and no response bodies still streaming',
      assertion: 'settled.in-flight',
      evidence: {
        settled: false,
        inFlight,
        ...(streaming > 0 ? { streaming } : {}),
        ...disclosure,
      },
    };
  }

  // A network-scoped settle reads only completed requests for the quiet window; the in-flight checks
  // above already ran for every scope.
  let activity = SETTLE_ACTIVITY;
  if (SettledChannel.NETWORK === p.channel) {
    activity = NETWORK_ACTIVITY;
  } else if (SettledChannel.APP === p.channel) {
    activity = APP_ACTIVITY;
  }
  let lastT = -1;
  let lastType: EventType | undefined;
  for (const e of events) {
    if (activity.has(e.type) && e.t > lastT) {
      lastT = e.t;
      lastType = e.type;
    }
  }
  if (lastT < 0) {
    return {
      pass: true,
      evidence: { settled: true, quietForMs: null, note: 'no activity to settle', ...disclosure },
    };
  }
  const quietForMs = now - lastT;
  if (quietForMs >= quietMs) {
    return {
      pass: true,
      evidence: { settled: true, quietForMs, lastActivity: lastType, ...disclosure },
    };
  }
  return {
    pass: false,
    failureReason: `not settled: last activity (${String(lastType)}) ${String(quietForMs)}ms ago, need ${String(quietMs)}ms quiet`,
    observed: `last activity was ${String(lastType)}, ${String(quietForMs)}ms ago`,
    expected: `${String(quietMs)}ms of quiet`,
    assertion: 'settled.quiet',
    evidence: { quietForMs, lastActivity: lastType, ...disclosure },
    // The one failure in this file that knows exactly when it could stop being one: if nothing else
    // happens, the window closes in this many ms. A waiter that re-checks THEN instead of on its next
    // blind tick stops paying up to a full poll interval on the hottest call in the product. Only a
    // hint — the predicate is still evaluated at that moment, and can still fail.
    retryAfterMs: quietMs - quietForMs,
  };
}
