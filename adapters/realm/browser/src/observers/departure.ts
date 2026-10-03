import { EventType, NetInitiator } from '@reticlehq/core';
import { observeSafely, type Emit, type Teardown } from './types.js';

/**
 * Where the browser is about to GO, recorded before it goes.
 *
 * Two journeys were unprovable for the same reason: the SDK dies with the document, so the one fact
 * worth asserting was gone before anything could read it.
 *
 * - **An OAuth handoff.** `act_and_wait` on a "Sign in with <provider>" link returned
 *   `observation_lost` the moment the tab left the instrumented origin. The checkable claim is
 *   narrow — does the app hand the browser to the expected provider, with the expected parameters?
 *   Nobody expects Reticle to verify the provider's own pages. That modest claim came back as
 *   `unknown`, and the reporter fell back to reading the local endpoint's 302 by hand.
 * - **A native download.** `<a download href="/api/export.pdf">` produces no fetch and no new
 *   document, so a 20-second window recorded zero network activity while `curl` showed the same URL
 *   answering 200. The export could not be proved green even though the server was fine.
 *
 * The anchor knows the answer at click time. `a.href` is resolved against the document by the DOM,
 * so a relative href arrives absolute and a `javascript:` or in-page `#hash` link is distinguishable
 * from a real departure.
 *
 * WHY A PENDING RATHER THAN A COMPLETED REQUEST. We observe an intention, not an outcome — the
 * response is delivered to a document this SDK will not live to see. `NET_PENDING` is precisely "a
 * request started and its result is unknown", so the honest event already existed. `reconcileNet`
 * renders an unmatched pending as `{status: 'pending'}`, which means a `urlContains` assertion
 * matches it and a `status: 200` assertion correctly does not. Emitting a completed request with a
 * synthesised 200 would have made every outbound link a false green.
 *
 * CAPTURE PHASE, and deliberately: a handler that calls `stopPropagation()` must not be able to hide
 * the click from us, so the listener has to be the first one to see it.
 *
 * DECIDED AT THE END OF DISPATCH, and equally deliberately. The record used to be written in the
 * capture handler, where `defaultPrevented` is always false because no app handler has run yet — so
 * a link a client-side router cancels and handles in-document was recorded as a request the browser
 * had gone off to make. It never started, so it never settled, and a pending that cannot settle is
 * read downstream as a request still in flight: clicking a tab that only changes `?tab=` carried a
 * "request never settled" contradiction on every step, and the declared consequences holding could
 * not save the verdict. Cancelling the anchor is the router SAYING the browser is not going, and it
 * is the only statement of that fact available at click time. One microtask after dispatch is where
 * it can be read, and it is still before the browser acts on a click it did not cancel.
 *
 * The cost of this is narrow and taken knowingly: an app that cancels the anchor and then navigates
 * by hand (`location.href = ...`) loses its departure record. It gets one from the new document's
 * navigation timing instead, and inventing a departure for every cancelled click to cover it is what
 * produced the false positive above.
 */

/** Schemes that never take the browser anywhere: no departure, nothing to report. */
const NON_NAVIGATING = /^(javascript|mailto|tel|sms|blob|data):/i;

/**
 * The sliver of the Navigation API we read. `window.navigation` is undefined in Firefox and
 * older Chromiums, so the anchor-click path below stays the fallback — and TypeScript's DOM
 * lib does not name these types everywhere this package compiles, hence the structural shape.
 */
interface NavigationDestinationLike {
  readonly url: string;
  /** True for in-page transitions (fragment, history pushState): the document survives. */
  readonly sameDocument: boolean;
}

interface NavigateEventLike extends Event {
  readonly destination: NavigationDestinationLike;
  readonly defaultPrevented: boolean;
}

/** The Navigation API root, when the browser exposes it. */
function navigationOf(): EventTarget | undefined {
  if ('undefined' === typeof window) return undefined;
  const nav = (window as Window & { navigation?: unknown }).navigation;
  return nav instanceof EventTarget ? nav : undefined;
}

/** The anchor this event landed on, walking up through the nested markup a real link contains. */
function anchorFor(target: EventTarget | null): HTMLAnchorElement | undefined {
  if (!(target instanceof Element)) return undefined;
  const anchor = target.closest('a');
  return anchor instanceof HTMLAnchorElement ? anchor : undefined;
}

/**
 * How long a recorded departure suppresses a matching Navigation API event for the same URL.
 *
 * Following an anchor fires BOTH the click listener and `navigate`; without this, one departure
 * is recorded as two unmatched NET_PENDINGs, which reads downstream as two in-flight requests.
 */
const DUPLICATE_WINDOW_MS = 1000;

/** True when following this anchor leaves the page the SDK is instrumenting. */
export function isDeparture(href: string, downloadAttr: boolean, here: string): boolean {
  if (0 === href.length || NON_NAVIGATING.test(href)) return false;
  // A download never navigates, so it is a departure in the only sense that matters: the response
  // goes somewhere this SDK cannot follow.
  if (downloadAttr) return true;
  try {
    const target = new URL(href, here);
    const current = new URL(here);
    // A same-origin link that only moves the fragment stays in THIS document — no departure, and
    // reporting one would put a phantom pending on every in-page anchor.
    if (target.origin === current.origin) {
      return target.pathname !== current.pathname || target.search !== current.search;
    }
    return true;
  } catch {
    return false;
  }
}

export function installDeparture(emit: Emit): Teardown {
  if ('undefined' === typeof document) return () => undefined;
  let seq = 0;
  /** The most recent departure recorded, so a `navigate` for the same traversal is not a second. */
  let lastRecorded: { url: string; at: number } | undefined;
  const record = (url: string, download: boolean): void => {
    const now = Date.now();
    if (
      lastRecorded !== undefined &&
      lastRecorded.url === url &&
      now - lastRecorded.at < DUPLICATE_WINDOW_MS
    ) {
      return;
    }
    lastRecorded = { url, at: now };
    seq += 1;
    emit(EventType.NET_PENDING, {
      id: `nav-${String(seq)}`,
      method: 'GET',
      url,
      initiator: NetInitiator.NAVIGATION,
      ...(download ? { download: true } : {}),
    });
  };
  const onClick = (event: Event): void => {
    observeSafely(() => {
      const anchor = anchorFor(event.target);
      if (anchor === undefined) return;
      const href = anchor.getAttribute('href') ?? '';
      const here = document.location.href;
      const download = anchor.hasAttribute('download');
      if (!isDeparture(href, download, here)) return;
      // Resolved now, against the document as it was when the click happened: an assertion names the
      // provider's host rather than the app's markup, and a handler that rewrites the href while it
      // runs cannot change what we say the user clicked.
      const url = new URL(href, here).toString();
      queueMicrotask(() => {
        observeSafely(() => {
          if (event.defaultPrevented) return;
          record(url, download);
        });
      });
    });
  };
  /**
   * Programmatic navigations never produce a click: `location.assign('/login')` on mount leaves
   * the daemon seeing only the socket close, and the reason lumped in with closed tabs (#1256).
   *
   * The Navigation API fires `navigate` on the OLD document while it is still alive, and
   * `destination.url` is resolved by the browser — which `pagehide` cannot supply (`location.href`
   * still names the departing page there). Same-document transitions keep this document, so they
   * are not departures; a cancelled navigation never leaves either, and reporting one would plant
   * a pending that cannot settle. The microtask reads `defaultPrevented` the way the click path
   * does — decided at the end of dispatch, still before the browser acts.
   */
  const onNavigate = (event: Event): void => {
    observeSafely(() => {
      const destination = (event as NavigateEventLike).destination;
      if (destination === undefined || destination.sameDocument) return;
      const url = destination.url;
      if (!isDeparture(url, false, document.location.href)) return;
      queueMicrotask(() => {
        observeSafely(() => {
          if ((event as NavigateEventLike).defaultPrevented) return;
          record(url, false);
        });
      });
    });
  };
  const navigation = navigationOf();
  if (navigation !== undefined) navigation.addEventListener('navigate', onNavigate);
  document.addEventListener('click', onClick, true);
  return () => {
    document.removeEventListener('click', onClick, true);
    if (navigation !== undefined) navigation.removeEventListener('navigate', onNavigate);
  };
}
