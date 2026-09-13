/**
 * Response/request BODY projection for the network observer.
 *
 * Split out of network.ts, which had grown to hold URL redaction, body projection, fetch, XHR, SSE,
 * WebSocket and sendBeacon at once. This module owns exactly one question: given a body, what is safe
 * and affordable to report?
 */
import { REDACTED_VALUE } from '@reticlehq/core';
import { isSensitiveKey, safeStringify, scrubKnownSecrets } from '../../security/serialization.js';
import { nativeClearTimeout, nativeSetTimeout } from '../../timers/native/native-timers.js';

/** Only text-like bodies are worth capturing; binary (images/fonts/octet-stream) is skipped. */
const CAPTURABLE_CONTENT =
  /application\/json|text\/|application\/xml|x-www-form-urlencoded|graphql/i;

/**
 * Content types that are STREAMS, never complete bodies.
 *
 * `text/event-stream` matches `text/` in CAPTURABLE_CONTENT, and body capture awaited
 * `res.clone.text` BEFORE returning the response to the app. A clone of a stream only settles when
 * the stream ends — and an SSE stream does not end — so the app's `await fetch...)` never resolved.
 * Enabling body capture silently hung every streaming endpoint (SSE, and the chunked `application/json`
 * every token-streaming model API uses), leaving a permanently loading UI with no reason to suspect the
 * observability SDK. Never read these; the frame observer covers SSE properly.
 */
const STREAMING_CONTENT = /event-stream|x-ndjson|application\/stream/i;

/**
 * Content types that stay OPEN by design — watching them would make every first settle pay the full
 * watch bound for a stream doing exactly its job. Real SSE is covered by the EventSource observer.
 */
const ENDLESS_BY_DESIGN = /event-stream/i;

/**
 * Is this response body still arriving after the request itself resolved?
 *
 * STRUCTURAL, not a content-type allowlist. The first version listed `x-component|x-ndjson|
 * application/stream` — which is to say "Next.js RSC, plus two guesses". It closed the exact defect
 * it was written against and left every other streamed response as invisible as before: a chunked
 * `application/json` from a token API, a streamed HTML document, an export assembled server-side.
 * Fixing one app's symptom and calling the class solved is how a false green comes back wearing
 * different clothes.
 *
 * The real signal is on the wire: a response with a BODY and no `content-length` is being sent
 * chunked, which is the definition of "the server is still writing". `content-length` present means
 * the size was known up front and the body cannot grow.
 *
 * Deliberately independent of content type, with one exception above for streams that never end.
 */
export function isStreamingBody(contentType: string | null, contentLength: string | null): boolean {
  if (contentType !== null && ENDLESS_BY_DESIGN.test(contentType)) return false;
  return null === contentLength;
}

/**
 * Longest the SDK will wait on a response-body clone before emitting without it.
 *
 * Two layers protect the app. `text/event-stream` and friends are skipped outright, which covers the
 * common streaming case at zero cost. This deadline is the backstop for a body that streams WITHOUT
 * announcing it in its content type — chunked `application/json` from a token-streaming API. Gating on
 * `content-length` instead was tried and rejected: plenty of complete responses omit it (gzip, HTTP/2),
 * so that would silently stop capturing bodies for ordinary apps. A bounded half-second on a rare path
 * beats an unbounded hang, and beats losing capture everywhere.
 */
const BODY_READ_TIMEOUT_MS = 500;

/**
 * Resolve with the body text, or `undefined` if it takes too long.
 *
 * The app is already awaiting our patched fetch, so any unbounded read here is a hang in the host app.
 * Losing an observation is always preferable to freezing the page being observed.
 */
export async function withBodyDeadline(read: Promise<string>): Promise<string | undefined> {
  // The timer is CLEARED on the winning path. Left uncleared, every captured body leaves a live timer
  // and a retained closure behind — harmless individually, but `boundedFrame` in this same package
  // already races-with-cleanup correctly, so not reusing that shape was an oversight rather than a
  // choice. It also keeps test workers from being held open by pending handles.
  let timer: number | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        timer = nativeSetTimeout(() => resolve(undefined), BODY_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) nativeClearTimeout(timer);
  }
}

export function isCapturableType(contentType: string | null): boolean {
  if (null === contentType) return false;
  if (STREAMING_CONTENT.test(contentType)) return false;
  return CAPTURABLE_CONTENT.test(contentType);
}

/**
 * Per-body character cap. Bodies ride the same ring buffer as the DOM/route/console timeline, so an
 * uncapped body could evict the whole behavioral history; the small cap keeps a few large responses
 * from starving the timeline (the separate-budget concern in the scalability audit).
 */
const MAX_BODY_CHARS = 8192;

/**
 * Hard bound on how much of a body is ever PARSED or SCANNED, independent of how much is reported.
 *
 * Only twice the output cap, and that ceiling is measured rather than guessed. The redaction pass uses
 * `[A-Za-z0-9_.-]+` followed by a delimiter, which backtracks quadratically on a long run without one.
 * Timed on this machine: 8 KB → 36 ms, 16 KB → 136 ms, 64 KB → 2067 ms. A first attempt at 8× the
 * output cap therefore still froze the main thread for seconds, so the bound is set where the cost
 * stays bounded AND redaction keeps enough context to catch a secret straddling the reported edge.
 * Scanning far past the output cap is wasted work in any case — only 8 KB is ever reported.
 */
const MAX_BODY_SCAN_CHARS = MAX_BODY_CHARS * 2;

/**
 * An `Authorization: Bearer …` / `Basic …` credential. The token side requires credential shape — 16+
 * chars AND at least one digit or symbol — so ordinary prose ("Basic subscription includes…", "Bearer
 * capacity exceeded") is NOT mangled, only actual opaque tokens are.
 */
const AUTH_SCHEME_TOKEN =
  /\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]{16,})(?=[A-Za-z0-9._~+/=-]*[\d._~+/=-])[A-Za-z0-9._~+/=-]+/gi;

/**
 * Redact credentials in ANY text body (form-urlencoded, text/plain, xml, or JSON that failed to parse).
 * sanitizeForTransport only redacts KEYS inside a parsed object, so a `password=secret` form post or a
 * `Bearer <token>` string would otherwise ship verbatim. Redacts the value of any `key=value` / `key: value`
 * pair whose key is sensitive, plus credential-shaped auth-scheme tokens.
 */
function redactText(text: string): string {
  return (
    text
      // Auth-scheme tokens FIRST: `Authorization: Bearer <token>` — the key/value rule below would
      // otherwise consume just "Bearer" as Authorization's value (it stops at whitespace) and leave the
      // token behind, so the scheme rule must run before it.
      .replace(AUTH_SCHEME_TOKEN, (_m: string, scheme: string) => `${scheme} ${REDACTED_VALUE}`)
      .replace(
        /([A-Za-z0-9_.-]+)(\s*[=:]\s*"?)([^&\s,;"}]+)/g,
        (match: string, key: string, sep: string) =>
          isSensitiveKey(key) ? `${key}${sep}${REDACTED_VALUE}` : match,
      )
  );
}

/**
 * Cap for a body retained only because the response FAILED.
 *
 * Smaller than the general cap on purpose: an error payload that says why is measured in tens or
 * hundreds of bytes -- the case that prompted this was 74 -- and this path runs whether or not the
 * app asked for body capture, so it must not be the reason a page holds a large buffer.
 */
const ERROR_BODY_CHARS = 4096;

/**
 * Should this response's body be retained even with `captureNetworkBodies` off?
 *
 * The response body of a FAILED request is the single most diagnostic thing on the wire, and it was
 * the one thing dropped by default. A confirmed `POST /auth/v1/signup -> 500, responseSize: 74`
 * told an agent that signup is broken; the 74 bytes would have said the mail provider refuses this
 * domain, which is the half that is actionable (#800).
 *
 * Recovering it after the fact is not a cheap retry -- it means editing the app's instrumentation,
 * restarting the dev server, re-driving a multi-field form and re-submitting against a rate-limited
 * path -- so "turn body capture on and re-run" is not a real answer for the case that needs it.
 *
 * Scoped to keep faith with #705, which asks for bodies OFF by default because a first drive
 * buffered authenticated and sensitive payloads:
 *
 *  - failures only, never a 2xx or 3xx, so the volume case #705 is about is untouched;
 *  - a smaller cap ({@link ERROR_BODY_CHARS});
 *  - the same redaction path as any other captured body, applied before retention;
 *  - and switchable off with `connect({ captureErrorBodies: false })` for a workspace that wants
 *    nothing retained at all.
 *
 * Failures are rare by definition, so the retained volume is bounded by how broken the app is.
 */
export function shouldCaptureErrorBody(status: number, enabled: boolean): boolean {
  // A network-level failure reports status 0 and has no body to read; `statusIsOk` in network.ts
  // treats 3xx as success (a normal navigation redirect), and so does this.
  return enabled && status >= 400;
}

/** Project a failure body under the error-only cap, with the ordinary redaction applied. */
export function projectErrorBody(
  rawText: string,
  contentType: string | null,
): { body: string; truncated: boolean } {
  const projected = projectBody(rawText, contentType);
  if (projected.body.length <= ERROR_BODY_CHARS) return projected;
  return { body: projected.body.slice(0, ERROR_BODY_CHARS), truncated: true };
}

/**
 * Redact + cap a body for the agent transcript. JSON is parsed and run through the same
 * sanitizeForTransport redaction used for state (sensitive keys -> [REDACTED]); every other text body
 * (and JSON that didn't parse) goes through redactText so form/plain-text credentials can't leak.
 * Returns the (possibly truncated) body plus whether it was cut.
 */
export function projectBody(
  rawText: string,
  contentType: string | null,
): { body: string; truncated: boolean } {
  // Bound the INPUT before any parsing or scanning. The cap used to be applied only at the end, so a
  // large body was JSON.parsed in full, deep-walked, re-stringified, and swept by two global regexes
  // before all but 8 KB of the result was thrown away — seconds of synchronous main-thread work for a
  // fixed-size output. A 30 MB CSV export or a big HTML error page froze the app, which is the same
  // class of host-app damage as the streaming hang, with the SDK still the cause.
  //
  // The slice is generous (a multiple of the output cap) so redaction still sees enough context to
  // recognise a secret that straddles the boundary, while the work stays bounded regardless of body size.
  const oversized = rawText.length > MAX_BODY_SCAN_CHARS;
  const text = oversized ? rawText.slice(0, MAX_BODY_SCAN_CHARS) : rawText;
  let out: string;
  if (contentType !== null && /json|graphql/i.test(contentType)) {
    try {
      // safeStringify already sanitizes internally — the extra sanitizeForTransport here re-walked
      // every captured JSON body a second time (~21% of the per-response cost) for an identical result.
      out = safeStringify(JSON.parse(text));
    } catch {
      out = redactText(text); // looked like JSON but wasn't — still redact key/value + auth tokens
    }
  } else {
    out = redactText(text);
  }
  // Key-based redaction can't see a secret sitting in a VALUE under a benign key — scan the projected
  // text for high-confidence secret shapes (JWTs, provider keys) as a backstop, JSON or not.
  out = scrubKnownSecrets(out);
  // Truncated if the projection overflows the cap OR the input itself was clipped above — a body the
  // SDK never fully read must not be reported as complete.
  const truncated = oversized || out.length > MAX_BODY_CHARS;
  return { body: out.length > MAX_BODY_CHARS ? out.slice(0, MAX_BODY_CHARS) : out, truncated };
}
