/**
 * What a request IS, which requests are OURS, and how to say one out loud.
 *
 * Split out of `contradictions.ts` when that file crossed the line cap — and the seam was already
 * there rather than invented for the occasion. Everything here answers a question ABOUT NETWORK
 * EVIDENCE: what did this event mean, was it a write, did a retry rescue it, is it the toolchain's
 * own traffic rather than the app's, is this cadence a poll. Nothing here knows what a
 * contradiction is.
 *
 * The rules next door read this vocabulary and decide what disagrees. Keeping the two apart means a
 * new rule cannot quietly redefine what "in flight" or "ours" means for itself, which is how two
 * rules end up disagreeing about the same window.
 */

import {
  EventType,
  MUTATING_METHODS,
  asNumber,
  asString,
  isDevToolingUrl,
  isThirdPartyUrl,
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
 * Split the window into the app's traffic and the dev toolchain's own (see `DevToolingChannel`).
 *
 * NOTHING below may judge the toolchain. Reported from a real drive: a correct Next.js navigation
 * graded `verified: "no"` because the dev overlay was resolving a source map for an unrelated React
 * key warning, and that in-flight `POST /__nextjs_original-stack-frames` read as "the UI advanced
 * over a request that never settled". Every app that logs one dev warning got a false negative on
 * every action. The overlay's own 404s and duplicate fetches are the same story on other checks,
 * which is why the split happens ONCE here rather than in the one check that reported it.
 */
export function splitForeignTraffic(
  events: readonly ReticleEvent[],
  appOrigin: string | undefined,
): {
  app: readonly ReticleEvent[];
  ignored: string[];
} {
  const ignored: string[] = [];
  const app = events.filter((e) => {
    if (!NET_TYPES.has(e.type)) return true;
    const url = asString(e.data['url']);
    // Somebody else's code, twice over: the toolchain's own channel, and any site that is not the
    // app under test. Neither can answer the question every rule below asks.
    if (!isDevToolingUrl(url) && !isThirdPartyUrl(url, appOrigin)) return true;
    if (url !== undefined && !ignored.includes(url)) ignored.push(url);
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
