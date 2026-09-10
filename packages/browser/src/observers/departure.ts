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
 * CAPTURE PHASE, and deliberately: an app that calls `preventDefault()` in a bubble-phase handler
 * still gets its click recorded here, and the event is a statement about what the anchor pointed at,
 * not a promise that the browser went. A router that intercepts its own links is the common case and
 * is reported by the route channel instead.
 */

/** Schemes that never take the browser anywhere: no departure, nothing to report. */
const NON_NAVIGATING = /^(javascript|mailto|tel|sms|blob|data):/i;

/** The anchor this event landed on, walking up through the nested markup a real link contains. */
function anchorFor(target: EventTarget | null): HTMLAnchorElement | undefined {
  if (!(target instanceof Element)) return undefined;
  const anchor = target.closest('a');
  return anchor instanceof HTMLAnchorElement ? anchor : undefined;
}

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
  const onClick = (event: Event): void => {
    observeSafely(() => {
      const anchor = anchorFor(event.target);
      if (anchor === undefined) return;
      const href = anchor.getAttribute('href') ?? '';
      const here = document.location.href;
      if (!isDeparture(href, anchor.hasAttribute('download'), here)) return;
      seq += 1;
      emit(EventType.NET_PENDING, {
        id: `nav-${String(seq)}`,
        method: 'GET',
        // Resolved, so an assertion can name the provider's host rather than the app's markup.
        url: new URL(href, here).toString(),
        initiator: NetInitiator.NAVIGATION,
        ...(anchor.hasAttribute('download') ? { download: true } : {}),
      });
    });
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
