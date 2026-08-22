import { describe, it, expect } from 'vitest';
import { EventType } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';
import { evalNet } from './predicate-eval.js';
import { PredicateKind } from './predicate.js';

/**
 * A request Reticle cannot see must not be graded as a request that did not happen.
 *
 * The observer patches `fetch` and `XMLHttpRequest` only, so anything the DOCUMENT initiates —
 * `<link rel=icon>`, `<link rel=manifest>`, a stylesheet, a font, `<img src>` — is never recorded.
 * Reported from the field (#447): after a hard reload of an app whose `index.html` declares all
 * three, an `allOf` over `/favicon.ico`, `/site.webmanifest` and `/apple-touch-icon.png` returned
 * `verified:"no"`, `verifiedReason:"assertion_failed"`, while curl against the same server at the
 * same moment answered 200 for every one of them.
 *
 * That is a false RED from the layer whose whole job is not to produce one, and a false negative is
 * worse than an unknown here: an agent that trusts it goes and "fixes" working code. `inconclusive`
 * is the existing seam for exactly this — `decideVerified` handles it ahead of the failure clause,
 * so the verdict lands on `unknown` instead of blaming the app.
 */
function netEvent(t: number, data: Record<string, unknown>): ReticleEvent {
  return { type: EventType.NET_REQUEST, t, data } as ReticleEvent;
}

const API_CALL = netEvent(10, {
  method: 'GET',
  url: '/api/auth/get-session',
  status: 500,
  ok: false,
});

describe('evalNet — requests the document initiates', () => {
  it.each([
    '/favicon.ico',
    '/site.webmanifest',
    '/apple-touch-icon.png',
    '/assets/app.css',
    '/fonts/inter.woff2',
  ])('reports %s as inconclusive rather than failed', (urlContains) => {
    const r = evalNet([API_CALL], { kind: PredicateKind.NET, urlContains, status: 200 });

    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
    expect(r.inconclusive).toContain('fetch and XMLHttpRequest');
  });

  it('ignores a query string and a fragment, since favicon.ico?v=2 is the same asset', () => {
    const r = evalNet([API_CALL], { kind: PredicateKind.NET, urlContains: '/favicon.ico?v=2' });

    expect(r.inconclusive).toBeDefined();
  });

  it('still fails an ordinary XHR target that genuinely never fired', () => {
    // The behaviour this must not weaken: a missing API call is a real finding.
    const r = evalNet([API_CALL], { kind: PredicateKind.NET, urlContains: '/api/save' });

    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
  });

  it('does not downgrade .js or .json, which are routinely fetched', () => {
    for (const urlContains of ['/assets/index.js', '/api/config.json']) {
      expect(
        evalNet([API_CALL], { kind: PredicateKind.NET, urlContains }).inconclusive,
      ).toBeUndefined();
    }
  });

  it('does not downgrade a filter that merely contains a suffix mid-pattern', () => {
    // `.css` here is part of a query, not the target: still an ordinary XHR.
    const r = evalNet([API_CALL], { kind: PredicateKind.NET, urlContains: '/api/assets.css/list' });

    expect(r.inconclusive).toBeUndefined();
  });

  it('leaves a matching subresource call passing when one WAS observed', () => {
    // An XHR to a .png is observable, and an observed match must still pass untouched.
    const icon = netEvent(20, {
      method: 'GET',
      url: '/apple-touch-icon.png',
      status: 200,
      ok: true,
    });

    expect(
      evalNet([icon], { kind: PredicateKind.NET, urlContains: '/apple-touch-icon.png' }).pass,
    ).toBe(true);
  });

  it('downgrades a zero-match count assertion over the same class', () => {
    const r = evalNet([API_CALL], {
      kind: PredicateKind.NET,
      urlContains: '/favicon.ico',
      count: 1,
    });

    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
  });

  it('still fails a count assertion that saw the wrong number of OBSERVED calls', () => {
    const icon = netEvent(20, {
      method: 'GET',
      url: '/apple-touch-icon.png',
      status: 200,
      ok: true,
    });

    const r = evalNet([icon, icon], {
      kind: PredicateKind.NET,
      urlContains: '/apple-touch-icon.png',
      count: 1,
    });

    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
  });
});

describe('evalNet — the unobserved-channel downgrade is gated on observer liveness', () => {
  /**
   * Once the browser SDK observes document-initiated loads (resource timing), a miss over these
   * suffixes stops being unknowable: a live observer would have seen the favicon load, so seeing
   * none is real evidence. The downgrade must therefore fire ONLY when nothing proves the observer
   * ran at all. Liveness is read off the same events being judged: any NET_REQUEST whose initiator
   * names a document channel (link/css/img/script/manifest/other) proves the channel works.
   */
  // A stylesheet load as the resource-timing observer reports it: proof of liveness.
  const STYLESHEET = netEvent(5, {
    method: 'GET',
    url: '/assets/app.css',
    initiator: 'link',
    status: 200,
    ok: true,
  });

  it('a missing favicon where the observer IS running grades no, not unknown', () => {
    const r = evalNet([STYLESHEET], {
      kind: PredicateKind.NET,
      urlContains: '/favicon.ico',
      status: 200,
    });

    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.failureReason).toBeDefined();
  });

  it('a zero-match count assertion over the same class grades no too', () => {
    const r = evalNet([STYLESHEET], {
      kind: PredicateKind.NET,
      urlContains: '/site.webmanifest',
      count: 1,
    });

    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
  });

  it('a page with no document-initiated record keeps the honest unknown', () => {
    // Only an XHR in the stream: nothing proves the PerformanceObserver exists here.
    const r = evalNet([API_CALL], { kind: PredicateKind.NET, urlContains: '/favicon.ico' });

    expect(r.inconclusive).toBeDefined();
  });

  it('an observed subresource still passes untouched under the gate', () => {
    const icon = netEvent(20, {
      method: 'GET',
      url: '/apple-touch-icon.png',
      initiator: 'link',
      status: 200,
      ok: true,
    });

    expect(
      evalNet([STYLESHEET, icon], { kind: PredicateKind.NET, urlContains: '/apple-touch-icon.png' })
        .pass,
    ).toBe(true);
  });
});
