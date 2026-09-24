import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  type FlowFile,
  type ReticleEvent,
} from '@reticlehq/core';
import { startPathMismatchHint } from './flow-replay-run.js';

const flow = (startPath?: string): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'checkout',
  createdAt: 1,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'pay' } }],
  ...(startPath === undefined ? {} : { startPath }),
});

const onRoute = (pathname: string): { eventsSince(c: number): ReticleEvent[] } => ({
  eventsSince: () => [{ t: 1, type: EventType.ROUTE_CHANGE, sessionId: 's', data: { pathname } }],
});

const noRoute = (): { eventsSince(c: number): ReticleEvent[] } => ({ eventsSince: () => [] });

describe('startPathMismatchHint — wrong-page drift becomes an actionable next move', () => {
  it('names the navigate target when the tab is on a different route', () => {
    const hint = startPathMismatchHint(flow('/cart'), onRoute('/home'));
    expect(hint).toContain('/cart');
    expect(hint).toContain('reticle_navigate');
  });

  it('is silent when the tab is already on the start page', () => {
    expect(startPathMismatchHint(flow('/cart'), onRoute('/cart'))).toBeUndefined();
  });

  it('is silent when the flow has no startPath (back-compat)', () => {
    expect(startPathMismatchHint(flow(), onRoute('/home'))).toBeUndefined();
  });

  it('never false-alarms when the current route is unobservable', () => {
    expect(startPathMismatchHint(flow('/cart'), noRoute())).toBeUndefined();
  });

  it('falls back to the session URL when no route event was observed (hard-loaded tab)', () => {
    const session = { url: 'http://localhost:3000/reset-password', eventsSince: () => [] };
    const hint = startPathMismatchHint(flow('/login'), session);
    expect(hint).toContain('/login');
    expect(hint).toContain('/reset-password');
  });

  it('is silent when the session URL already sits on the start page', () => {
    const session = { url: 'http://localhost:3000/login?next=%2F', eventsSince: () => [] };
    expect(startPathMismatchHint(flow('/login'), session)).toBeUndefined();
  });

  it('treats a trailing slash as the same page, not as elsewhere', () => {
    const session = { url: 'http://localhost:3000/login/', eventsSince: () => [] };
    expect(startPathMismatchHint(flow('/login'), session)).toBeUndefined();
  });
});

/**
 * On a hash router the document pathname is `/` on every page, and BOTH sides of this comparison
 * read only the pathname — so `samePath('/', '/')` was always true and the hint never fired,
 * whatever route the tab had drifted to. Symmetrically blind, so it produced no WRONG hint; it
 * produced no hint at all, on the router a packaged Electron/Tauri renderer uses by default.
 *
 * `startPath` has to stay NAVIGABLE — the hint tells the caller to `reticle_navigate` to it — so the
 * value is `pathname + hash`, not the bare router path.
 */
const onHashRoute = (hash: string): { eventsSince(c: number): ReticleEvent[] } => ({
  eventsSince: () => [
    { t: 1, type: EventType.ROUTE_CHANGE, sessionId: 's', data: { pathname: '/', hash } },
  ],
});

describe('startPathMismatchHint sees a hash router', () => {
  it('fires when the tab drifted to a different hash route', () => {
    const hint = startPathMismatchHint(flow('/#/cart'), onHashRoute('#/home'));
    expect(hint).toContain('/#/cart');
    expect(hint).toContain('/#/home');
  });

  it('stays quiet when the tab is on the recorded hash route', () => {
    expect(startPathMismatchHint(flow('/#/cart'), onHashRoute('#/cart'))).toBeUndefined();
  });

  // A path-routed app must behave exactly as before.
  it('leaves a path-routed app alone', () => {
    expect(startPathMismatchHint(flow('/cart'), onRoute('/home'))).toContain('/cart');
    expect(startPathMismatchHint(flow('/cart'), onRoute('/cart'))).toBeUndefined();
  });
});

/**
 * A `startPath` carrying a query string is not permanently "elsewhere" (#1059).
 *
 * Reported on Next.js 16 and traced by the reporter: `currentPathOf` compares `pathname` + `hash`
 * while `startPath` keeps the query, so the two never match. A flow starting at
 * `/admin/events/<id>?tab=wrap` therefore re-navigated on EVERY replay even with the tab already
 * exactly where the flow starts, and the re-navigation killed the session mid-flow - the next
 * command came back `query timed out after 8000ms`, or `could not run in a leased context`.
 *
 * The reporter offered two fixes and preferred stripping the query before comparing. That one is
 * subtly wrong in the direction that matters: the query is usually load-bearing for what the page
 * renders, which is why they also rejected dropping it at RECORD time. Strip it only for the
 * comparison and a tab sitting on `?tab=summary` reads as "already at `?tab=wrap`", so the replay
 * starts on the wrong page and nothing says so.
 *
 * The asymmetry was the whole defect: one side carried the query and the other did not. Both sides
 * carry it now, which keeps a genuine difference visible AND stops the false one.
 */
describe('a startPath with a query string', () => {
  const onUrl = (url: string): { url: string; eventsSince(c: number): ReticleEvent[] } => ({
    url,
    eventsSince: () => [],
  });

  it('is silent when the tab is already on that exact query', () => {
    expect(
      startPathMismatchHint(
        flow('/admin/events/7?tab=wrap'),
        onUrl('http://localhost:3000/admin/events/7?tab=wrap'),
      ),
      'the tab is exactly where the flow starts, so re-navigating kills the session for nothing',
    ).toBeUndefined();
  });

  it('still fires when the query genuinely differs, because the query decides what renders', () => {
    const hint = startPathMismatchHint(
      flow('/admin/events/7?tab=wrap'),
      onUrl('http://localhost:3000/admin/events/7?tab=summary'),
    );
    expect(hint).toContain('tab=wrap');
  });

  it('still fires when the pathname differs and both carry a query', () => {
    expect(
      startPathMismatchHint(
        flow('/admin/events/7?tab=wrap'),
        onUrl('http://localhost:3000/admin/events/8?tab=wrap'),
      ),
    ).toContain('/admin/events/7');
  });

  /*
   * And the case I got wrong before the existing suite corrected me.
   *
   * A `startPath` with no query is not a demand for a BARE url. The flow never asked about the
   * query, so a tab carrying one is not elsewhere - `?next=%2F` on a login page and the identity
   * params Reticle puts on a leased tab are both that shape, and navigating to strip them costs a
   * session for nothing. `startPath` is the specification, and it decides what counts.
   */
  it('ignores a query the flow never asked about', () => {
    expect(
      startPathMismatchHint(flow('/cart'), onUrl('http://localhost:3000/cart?coupon=X')),
      'the flow said /cart and the tab is on /cart; the coupon is not the flow being elsewhere',
    ).toBeUndefined();
  });
});
