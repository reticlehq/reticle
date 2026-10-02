import { EventType, urlForMatch, type ReticleEvent } from '@reticlehq/core';

/**
 * A request the page made for Reticle's OWN code, which the journal declines to keep.
 *
 * Measured over this repo's twenty recorded sessions: `net.request` is 64.6% of every journal byte
 * and `net.detail` a further 17.6%, and the bulk of that is the browser fetching the SDK's module
 * graph over and over as the dev server hot-reloads. Those bytes are Reticle watching itself arrive.
 * They can never be evidence about the app under test, because the app did not ask for them — the
 * instrumentation did, and it did so before the app had done anything worth verifying.
 *
 * The DOM side has drawn this line for a long time (`isReticleUi`), and the transport side draws it
 * on the bridge socket's own path. This is the same line on the network channel.
 *
 * Identity, not resemblance. A request qualifies only when its PATH names our npm scope, which is
 * the one thing about a URL that nobody else can be: `@reticlehq` is a registry scope we own, so a
 * path segment under it is a file from one of our packages however it is being served — from
 * `node_modules`, from a CDN, or through Vite's dep optimizer, which flattens the scope to
 * `@reticlehq_browser.js`. A user's own file is never addressed that way.
 *
 * What this deliberately does NOT do is guess from shape. `/core/dist/index.js` and
 * `/adapters/realm/browser/dist/index.js` are what this repo's own linked checkout serves, and
 * matching those would collapse most of the bytes measured above — but they are ordinary paths that
 * somebody else's app is entitled to serve, and a filter that drops a user's request to save our own
 * bytes is the trade this project has already measured the cost of. So a source-linked checkout of
 * Reticle itself keeps journaling its own SDK, and that is the correct side to be wrong on.
 *
 * Only the query string can carry a scope-shaped string that is really app data (a search for
 * `@reticlehq/browser`), so the decision is taken on `pathname` alone.
 */

/** The npm scope directory, as it appears when the package is served from a tree. */
const SCOPE_PATH = '/@reticlehq/';

/**
 * The same scope after Vite's dependency optimizer flattens `@scope/name` to one filename. Anchored
 * at a segment boundary so it cannot match in the middle of somebody's filename.
 */
const SCOPE_FLATTENED = '/@reticlehq_';

/**
 * Every event kind that carries a request URL — all of them, on purpose.
 *
 * `reconcileNet` pairs a NET_PENDING with its NET_REQUEST by id and reports an unpaired pending as a
 * HUNG request. Dropping one half of a pair would therefore manufacture a finding out of a request
 * that completed perfectly. The rule is a pure function of the URL, so both halves of a pair always
 * get the same answer and no pair can be split.
 */
const NET_TYPES: ReadonlySet<string> = new Set([
  EventType.NET_REQUEST,
  EventType.NET_PENDING,
  EventType.NET_DETAIL,
  EventType.NET_STREAM,
]);

/** A base for parsing relative URLs. Never dereferenced — only the path is read. */
const RELATIVE_BASE = 'http://reticle.invalid';

function pathOf(url: string): string {
  try {
    return new URL(url, RELATIVE_BASE).pathname;
  } catch {
    return url;
  }
}

/** True when this event is the page fetching Reticle's own code rather than doing anything. */
export function isSelfObservation(event: ReticleEvent): boolean {
  if (!NET_TYPES.has(event.type)) return false;
  const path = pathOf(urlForMatch(event.data));
  return path.includes(SCOPE_PATH) || path.includes(SCOPE_FLATTENED);
}
