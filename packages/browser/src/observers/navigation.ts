import { EventType, NetInitiator } from '@reticlehq/core';
import type { Emit, Teardown } from './types.js';

/**
 * The request that fetched THIS document, reported once at connect.
 *
 * A server-rendered app answers a click with a full document load. The old document is torn down
 * with the SDK inside it, the browser fetches the new one, and the SDK comes back up in a page whose
 * defining request happened before it existed. Nothing patched `fetch` or `XMLHttpRequest` for that
 * request, because the browser made it, so the net channel had no record of it at all.
 *
 * Measured in the field on a Django MPA: a click was verified on route and heading, and the `net`
 * clause naming the destination document MISSED — "after a full page load the SDK reconnects and
 * never sees the document navigation". The verdict came back `unknown`. The request had succeeded;
 * the observer that would have seen it did not exist yet. The same shape covers Rails, Laravel, PHP,
 * plain server-rendered HTML, and any Next.js or Astro route that falls back to a document load.
 *
 * The browser keeps the answer. `PerformanceNavigationTiming` is the new document's own record of
 * how it was fetched — URL, duration, transfer size, and on Chromium the response status. Reading it
 * costs one synchronous call and invents nothing: every field is the browser's measurement of a
 * request it really made.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not synthesise a status. `responseStatus` is absent on
 * browsers that do not implement it and reads 0 for an opaque or cached-without-revalidation load;
 * in those cases the event carries no `status` and no `ok` rather than a plausible 200. A net
 * predicate asserting `status: 200` then stays unproved, which is the correct answer — this file
 * exists to stop a missing observation being read as a missing request, not to start guessing at
 * ones we did not see.
 */

/**
 * Navigation types worth reporting. `prerender` is excluded: the document was fetched speculatively,
 * possibly long before and for a click that may never have happened, so attributing it to the
 * agent's window would be a lie about causation rather than about the request.
 */
const REPORTED_TYPES: ReadonlySet<string> = new Set(['navigate', 'reload', 'back_forward']);

interface NavigationTimingLike {
  readonly type?: string;
  readonly name?: string;
  readonly duration?: number;
  readonly transferSize?: number;
  readonly responseStatus?: number;
}

/** The document's own navigation entry, or undefined where the API is absent or empty. */
function navigationEntry(): NavigationTimingLike | undefined {
  try {
    const [first] = performance.getEntriesByType('navigation');
    return first;
  } catch {
    // Reading performance entries throws in some sandboxed contexts. A missing document event is a
    // blind spot; a thrown one would take every other observer down with it.
    return undefined;
  }
}

export function installNavigation(emit: Emit): Teardown {
  const entry = navigationEntry();
  const type = entry?.type;
  const url = entry?.name;
  if (entry === undefined || 'string' !== typeof url || 0 === url.length) return () => undefined;
  if ('string' !== typeof type || !REPORTED_TYPES.has(type)) return () => undefined;

  // Present and non-zero, or absent entirely — see the note above on not synthesising a status.
  const status = entry.responseStatus;
  const known = 'number' === typeof status && status > 0;
  emit(EventType.NET_REQUEST, {
    id: `doc-${String(Math.round(entry.duration ?? 0))}`,
    method: 'GET',
    url,
    initiator: NetInitiator.DOCUMENT,
    durationMs: Math.round(entry.duration ?? 0),
    ...(known ? { status, ok: status < 400 } : {}),
    // Why the document is here at all, so a reader can tell a click-through from a reload from a
    // back button without going to another channel for it.
    navigationType: type,
    ...('number' === typeof entry.transferSize ? { transferSize: entry.transferSize } : {}),
  });
  // Nothing was patched and nothing subscribed: the entry is read once and the document it describes
  // cannot happen twice in the same document.
  return () => undefined;
}
