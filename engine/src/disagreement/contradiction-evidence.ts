/**
 * What a request IS, which requests are OURS, and how to say one out loud.
 *
 * Split out of `contradictions.ts` when that file crossed the line cap — and the seam was already
 * there rather than invented for the occasion. Everything here answers a question ABOUT NETWORK
 * EVIDENCE: what did this event mean, was it a write, did a retry rescue it, is it the toolchain's
 * own traffic rather than the app's, is this cadence a poll, what did a write carry, which page did
 * a list request ask for, and which `net` clause would name this call — and whether a settled field
 * reading shows the app wrote the screen forward. Nothing here knows what a contradiction is.
 *
 * The rules next door read this vocabulary and decide what disagrees. Keeping the two apart means a
 * new rule cannot quietly redefine what "in flight" or "ours" means for itself, which is how two
 * rules end up disagreeing about the same window.
 */

import {
  EventType,
  FieldChangeField,
  FieldChangeKind,
  MUTATING_METHODS,
  NEXT_ACTION_FIELD,
  PredicateKind,
  REQUEST_SHAPE_FIELD,
  ROUTE_CHANGE_HOW_FIELD,
  RouteChangeHow,
  asNumber,
  asString,
  isDevToolingUrl,
  isForeignTraffic,
  urlForMatch,
  type ReticleEvent,
} from '@reticlehq/core';

export interface NetCall {
  method: string;
  url: string;
  /** Grader haystack — the raw request when redaction rewrote `url`. */
  matchUrl: string;
  status: number | undefined;
  /**
   * `undefined` means NO VERDICT — not failure.
   *
   * A one-way IPC `send` hands the message to the main process and returns; the renderer never learns
   * whether it was handled. The observer deliberately omits both `ok` and `status` rather than
   * manufacture a success nobody reported. Collapsing that to `false` here manufactured a FAILURE
   * nobody reported instead, which is the same sin pointing the other way: every fire-and-forget send
   * raised `ui-advanced-request-failed` against a UI that had done nothing wrong.
   */
  ok: boolean | undefined;
}

export function netCall(e: ReticleEvent): NetCall {
  const status = asNumber(e.data['status']);
  return {
    method: (asString(e.data['method']) ?? '').toUpperCase(),
    url: asString(e.data['url']) ?? '',
    matchUrl: urlForMatch(e.data),
    status,
    // `ok` is authoritative when present (IPC sets it explicitly); status is the HTTP fallback.
    // Neither present = no verdict was ever reported, which stays undefined all the way through.
    ok:
      e.data['ok'] === undefined && status === undefined
        ? undefined
        : true === e.data['ok'] || (e.data['ok'] === undefined && (status ?? 0) < 400),
  };
}

/**
 * The failed calls that a LATER successful call to the same endpoint replaced.
 *
 * Identity, not index: each `netCall` is a fresh object held by `settled`, and `settled` is built
 * from events in sequence order, so "later" is simply "further along the array". Compared on
 * `matchUrl` so a cache-buster or a changing query token cannot make a retry look like a different
 * call — the same normalisation every other url comparison here uses.
 */
export function recoveredByRetry(settled: readonly NetCall[]): ReadonlySet<NetCall> {
  const out = new Set<NetCall>();
  for (let i = 0; i < settled.length; i += 1) {
    const call = settled[i];
    if (call === undefined || false !== call.ok) continue;
    for (let j = i + 1; j < settled.length; j += 1) {
      const later = settled[j];
      if (later === undefined) continue;
      if (true === later.ok && later.method === call.method && later.matchUrl === call.matchUrl) {
        out.add(call);
        break;
      }
    }
  }
  return out;
}

/**
 * Did the user-visible application state move forward? DOM, store and route only — deliberately NOT
 * network, animation or signal. The question every rule below asks is "did the app act as if it
 * succeeded", and a request firing is not the app acting as if anything.
 */
export function isMutating(call: NetCall): boolean {
  return MUTATING_METHODS.includes(call.method);
}

export function describe(call: NetCall): string {
  return `${call.method} ${call.url}${call.status === undefined ? '' : ` → ${String(call.status)}`}`;
}

/**
 * Actions that are SUPPOSED to make something happen, so producing nothing is a finding.
 *
 * Deliberately narrow. `hover`, `focus` and `scrollIntoView` can legitimately move nothing, and
 * `fill`/`type` change an input's value without necessarily mutating the DOM tree — flagging those
 * would manufacture noise, which is the failure mode opposite to a false green and just as bad.
 */
export const NET_TYPES: ReadonlySet<EventType> = new Set([
  EventType.NET_PENDING,
  EventType.NET_REQUEST,
  EventType.NET_STREAM,
]);

/**
 * Hash-router paths put the route in the fragment (`#/settings`, `#!/home`). An in-page skip link
 * does not (`#main-content`, `#`, empty). The blank-destination rule must still see the former.
 */
export function isInPageFragment(hash: string): boolean {
  if ('' === hash || '#' === hash) return true;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  return !body.startsWith('/') && !body.startsWith('!');
}

export function hrefAsUrl(value: string | undefined): URL | undefined {
  if (value === undefined || '' === value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Same origin + pathname + search, different in-page fragment — a skip link, not a new view.
 *
 * Returns false when `from`/`to` are missing, so older events without hrefs keep the existing rule.
 */
export function isSameDocumentHashAnchor(event: ReticleEvent): boolean {
  if (event.type !== EventType.ROUTE_CHANGE) return false;
  const from = hrefAsUrl(asString(event.data['from']));
  const to = hrefAsUrl(asString(event.data['to']));
  if (from === undefined || to === undefined) return false;
  if (from.origin !== to.origin || from.pathname !== to.pathname || from.search !== to.search) {
    return false;
  }
  if (from.hash === to.hash) return false;
  return isInPageFragment(to.hash);
}

/**
 * A `replaceState` that keeps the pathname recorded state in the URL. It is not a navigation.
 *
 * Search and an in-page fragment may change (`?zoom=125`, `#main-content`). A hash-router fragment
 * (`#/invoices`) is still a new view, and so is a replace onto a different pathname. Missing hrefs
 * stay under the blank-destination rule: an event that cannot show the path stayed put is not exempt.
 */
export function isSamePathnameReplace(event: ReticleEvent): boolean {
  if (event.type !== EventType.ROUTE_CHANGE) return false;
  if (asString(event.data[ROUTE_CHANGE_HOW_FIELD]) !== RouteChangeHow.REPLACE) return false;
  const from = hrefAsUrl(asString(event.data['from']));
  const to = hrefAsUrl(asString(event.data['to']));
  if (from === undefined || to === undefined) return false;
  if (from.origin !== to.origin || from.pathname !== to.pathname) return false;
  if (from.hash !== to.hash && !isInPageFragment(to.hash)) return false;
  return true;
}

/**
 * Did this event show a field whose post-handler reading differs from its pre-action one?
 *
 * React writes `checked` and `value` as properties, so a controlled checkbox that re-renders
 * produces no attribute mutation. The field change from the input event itself cannot fill that
 * gap: it is emitted from the user's own event, before a controlled component restores the
 * property, and counting it would treat a box React immediately reverted as rendered.
 *
 * A settled read carries the value from before the action beside the value after the handlers
 * ran. The browser only sends one when the app itself wrote the property during the action, so an
 * uncontrolled field the browser toggled on its own never counts. The screen moved only when the
 * two readings differ.
 */
export function settledFieldRendered(event: ReticleEvent): boolean {
  if (event.type !== EventType.FIELD_CHANGE) return false;
  if (event.data[FieldChangeField.KIND] !== FieldChangeKind.SETTLED) return false;
  const checked = event.data[FieldChangeField.CHECKED];
  const previousChecked = event.data[FieldChangeField.PREVIOUS_CHECKED];
  if ('boolean' === typeof checked && 'boolean' === typeof previousChecked) {
    return checked !== previousChecked;
  }
  const value = event.data[FieldChangeField.VALUE];
  const previous = event.data[FieldChangeField.PREVIOUS];
  return 'string' === typeof value && 'string' === typeof previous && value !== previous;
}

/**
 * Did this event show the screen moving, for the state-vs-render rule? A DOM node added, removed or
 * changed, route movement (a navigation IS a render), or a field the app itself wrote to a new
 * value (`settledFieldRendered`). The input event's own field change does not count: that is the
 * keystroke or the browser's own toggle, true of a component that never re-rendered.
 */
export function screenMoved(event: ReticleEvent): boolean {
  return (
    event.type === EventType.DOM_ADDED ||
    event.type === EventType.DOM_REMOVED ||
    event.type === EventType.DOM_ATTR ||
    event.type === EventType.DOM_TEXT ||
    event.type === EventType.ROUTE_CHANGE ||
    settledFieldRendered(event)
  );
}

/**
 * Split the window into the app's traffic and the dev toolchain's own (see `DevToolingChannel`).
 *
 * NOTHING below may judge the toolchain. Reported from a real drive: a correct Next.js navigation
 * graded `verified: "no"` because the dev overlay was resolving a source map for an unrelated React
 * key warning, and that in-flight `POST /__nextjs_original-stack-frames` read as "the UI advanced
 * over a request that never settled". Every app that logs one dev warning got a false negative on
 * every action. The overlay's own 404s and duplicate fetches are the same story on other checks,
 * which is why the split happens ONCE here rather than in the one check that reported it.
 *
 * CLASSIFY on `urlForMatch`, DISCLOSE `url`. Redaction rewrites a sensitive path segment at emit
 * time (`/verify/refresh-token` -> `/verify/[REDACTED]`) and keeps the original only in `urlRaw`, so
 * a project's DECLARED `background` pattern — matched with `String.includes` — never matched what
 * this read. The endpoint went back in among the app's own traffic and every rule below judged it,
 * which is the half of the same defect the settle wait had. Disclosure deliberately keeps the
 * DISPLAYED spelling: the raw one is the match haystack, not something to project into a transcript.
 */
export function splitForeignTraffic(
  events: readonly ReticleEvent[],
  appOrigin: string | undefined,
  background: readonly string[] = [],
): {
  app: readonly ReticleEvent[];
  ignored: string[];
} {
  const ignored: string[] = [];
  const app = events.filter((e) => {
    if (!NET_TYPES.has(e.type)) return true;
    const matchUrl = urlForMatch(e.data);
    const shown = asString(e.data['url']);
    // Somebody else's code, twice over: the toolchain's own channel, and any site that is not the
    // app under test. Neither can answer the question every rule below asks.
    const match = 0 === matchUrl.length ? undefined : matchUrl;
    if (!isDevToolingUrl(match) && !isForeignTraffic(match, appOrigin, background)) return true;
    if (shown !== undefined && !ignored.includes(shown)) ignored.push(shown);
    return false;
  });
  return { app, ignored };
}

/**
 * Cross-channel contradictions in this window, with the edit-epoch caveat attached when it applies.
 *
 * Cross-epoch evidence is LABELLED rather than excluded, which is the opposite of what the document
 * scoping does, and the difference is the point. A navigation is total — it throws away the page,
 * the refs, the in-flight requests and the state — so nothing recorded before it is still about the
 * world, and dropping it is the only honest option. A hot update is not: most modules, most of the
 * DOM, the whole network log and every console line survive one, so most of what was observed a
 * second before an edit is still true a second after. Excluding it would empty windows that hold
 * real findings, and an emptied window reads as "nothing happened" — which is the more expensive of
 * the two wrong answers and the one this whole family of checks exists to prevent.
 *
 * So the findings stand and the caveat is said out loud, and only when it is unambiguous: EVERY
 * observation in the window predates the edit. One post-edit observation and the agent is already
 * looking at the code it wrote, so the label would be noise.
 */
/**
 * Below this, repeated writes are a BURST, whatever their spacing.
 *
 * A double submit is two clicks, or one click and a re-render: milliseconds apart. Nothing a human
 * or a StrictMode remount does lands on a quarter-second grid, so this is the floor under which
 * regularity means nothing.
 */
export const POLL_MIN_INTERVAL_MS = 250;

/**
 * How far a gap may sit from the median and still count as the same cadence.
 *
 * Loose on purpose: a real poll drifts under load, and a `setInterval` competing with a busy main
 * thread is not metronomic. Tight enough that a burst followed by a late retry — the shape a double
 * submit plus a user's second attempt makes — is not read as a rhythm.
 */
export const POLL_JITTER_RATIO = 0.4;

/**
 * Is this the same write on a steady interval, rather than the same write twice?
 *
 * THREE samples minimum, and that is the load-bearing part: two writes give one gap, and a single
 * gap cannot distinguish a cadence from a coincidence. Two writes stay a duplicate however far
 * apart they are, which is the classic double submit and every case this rule was written for.
 */
export function isSteadyCadence(times: readonly number[]): boolean {
  if (times.length < 3) return false;
  const ordered = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i += 1) gaps.push((ordered[i] ?? 0) - (ordered[i - 1] ?? 0));
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (median < POLL_MIN_INTERVAL_MS) return false;
  return gaps.every((gap) => Math.abs(gap - median) <= median * POLL_JITTER_RATIO);
}

/**
 * What this request CARRIED, as far as the record knows — `undefined` when it does not know.
 *
 * The page's shape fingerprint first: it is present on every request from an instrumented page,
 * including the overwhelming majority where body capture is off. A captured body is the fallback for
 * a realm that records one without a fingerprint (desktop IPC). Neither means the record does not
 * say what this request carried — a body the page could not read as text, or an SDK too old to
 * compute a fingerprint — and that is an ABSENCE of identity, not an identity shared with every
 * other silent request.
 *
 * A Server Action's action id joins both halves, and it is the half that survives a `FormData`
 * body: several actions POST to the page's own URL, so without it every call is an unknown identity
 * pooled with all the others, and no fingerprint can separate two that share a shape. The id alone
 * SPLITS two different actions; it cannot say that two runs of one action carried the same thing,
 * and `carried` keeps that limit on the record for the finding to say.
 */
export interface WriteIdentity {
  /** The value the grouping compares. */
  readonly key: string;
  /** Whether the key also describes WHAT the request carried, not only which action ran. */
  readonly carried: boolean;
}

export function identityOf(event: ReticleEvent): WriteIdentity | undefined {
  const action = asString(event.data[NEXT_ACTION_FIELD]);
  const shape = asString(event.data[REQUEST_SHAPE_FIELD]);
  const body = asString(event.data['requestBody']);
  const carried =
    shape !== undefined && 0 !== shape.length
      ? shape
      : body === undefined || 0 === body.length
        ? undefined
        : body;
  if (action === undefined || 0 === action.length) {
    return carried === undefined ? undefined : { key: carried, carried: true };
  }
  return carried === undefined
    ? { key: action, carried: false }
    : { key: `${action}:${carried}`, carried: true };
}

/** Split calls to one endpoint into the sets that sent the same thing. Callers check first that
 * every identity is known; an unknown one would otherwise pool with every other unknown. */
export function groupByIdentity<T extends { identity: WriteIdentity | undefined }>(
  calls: readonly T[],
): T[][] {
  const byIdentity = new Map<string, T[]>();
  for (const call of calls) {
    const key = call.identity?.key ?? '';
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), call]);
  }
  return [...byIdentity.values()];
}

/**
 * The `net` clause that declares each of these failures, worded as a condition.
 *
 * A designed error path (a 402 paywall, a 429, a 428 confirmation) asserted through the UI it renders
 * gets `ui-advanced-request-failed`, and declaring the failing call in the oracle is what exempts it
 * (`matchesDeclaredFailure`). Nothing in the finding said so, so agents dropped the check or
 * weakened it until it proved nothing (#1418). The clause is built from the call itself, so it is
 * exactly what would match, and it is conditional: the finding is still a finding, and a clause
 * pasted to make a red go away would be the same false green with extra steps.
 *
 * Built from the DISPLAY url, which is redacted, never from `matchUrl`, which is not: the detail is
 * copied into crawl anomalies, and a hint must not put back a token the description took out. A
 * call whose path cannot be named exactly and narrowly gets no clause rather than a loose one: a
 * bare `/` is a substring of every url and would exempt unrelated failures with the same method.
 */
export function declareFailureHint(
  calls: readonly { method: string; url: string; matchUrl?: string; status: number | undefined }[],
): string {
  const clauses = calls.flatMap((c) => {
    const urlContains = narrowPathOf(c);
    if (urlContains === undefined) return [];
    const clause = {
      kind: PredicateKind.NET,
      method: c.method.toUpperCase(),
      urlContains,
      ...(c.status === undefined || 0 === c.status ? { ok: false } : { status: c.status }),
    };
    return [JSON.stringify(clause)];
  });
  if (0 === clauses.length) return '';
  const subject = 1 === clauses.length ? 'this failure is' : 'these failures are';
  return `. If ${subject} the outcome you expect, declare it in the predicate: ${clauses.join(', ')}`;
}

/** Resolves a relative call url so its path can be read; the host is never shown or matched. */
const RELATIVE_URL_BASE = 'http://reticle.invalid';

/**
 * The display url's path, when it is both safe to show and narrow enough to declare one call.
 *
 * Only when it is literally in the url the declaration is matched against: `urlContains` is a
 * substring test, so a path the parser re-encoded, or one the redaction changed, would never match.
 */
function narrowPathOf(call: { url: string; matchUrl?: string }): string | undefined {
  let path: string;
  try {
    path = new URL(call.url, RELATIVE_URL_BASE).pathname;
  } catch {
    return undefined;
  }
  if (0 === path.replace(/\/+$/, '').length) return undefined;
  if (!call.url.includes(path) || !(call.matchUrl ?? call.url).includes(path)) return undefined;
  return path;
}

/** Query parameters that say which page of a list is being asked for. */
const PAGE_PARAMS = ['page', 'offset', 'cursor', 'after', 'start', 'skip', 'from'] as const;

/** "Page 2", "page 2 of 6", "2 / 6", "2 of 6". */
const PAGE_LABEL = /\bpage\s+(\d+)\b|\b(\d+)\s*(?:of|\/)\s*\d+(?:,\d{3})*\b/i;
const RECORD_RANGE_LABEL =
  /\b\d[\d,]*\s*(?:[-–—]|\bto\b)\s*\d[\d,]*\s+of\s+\d[\d,]*\b|\b\d[\d,]*\s+of\s+\d[\d,]*\s+(?:records|items|results)\b/i;

export function pageNumber(text: unknown): number | undefined {
  if ('string' !== typeof text) return undefined;
  if (RECORD_RANGE_LABEL.test(text)) return undefined;
  const match = PAGE_LABEL.exec(text);
  const raw = match?.[1] ?? match?.[2];
  return raw === undefined ? undefined : Number(raw);
}

/** The endpoint, page parameter and remaining query, for a GET that carries a page parameter. */
export function pageRequest(
  event: ReticleEvent,
): { path: string; param: string; value: string; query: string } | undefined {
  if (event.type !== EventType.NET_REQUEST) return undefined;
  const method = event.data['method'];
  if ('string' !== typeof method || 'GET' !== method.toUpperCase()) return undefined;
  const raw = event.data['url'];
  if ('string' !== typeof raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw, 'http://app.invalid');
  } catch {
    return undefined;
  }
  for (const param of PAGE_PARAMS) {
    const value = url.searchParams.get(param);
    if (value !== null) {
      url.searchParams.delete(param);
      // jQuery `cache: false` changes `_` on every otherwise identical GET.
      url.searchParams.delete('_');
      url.searchParams.sort();
      return { path: url.pathname, param, value, query: url.searchParams.toString() };
    }
  }
  return undefined;
}
