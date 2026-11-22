/**
 * Where a Back or Forward move arrived (#1844).
 *
 * A URL navigation knows its target, so `awaitArrival` matches sessions against it. A history move
 * does not: the entry it lands on is the browser's, not the caller's. So arrival here is "the
 * navigated tab is now somewhere else", and these tests hold the two ways that can show:
 *   - the same document moved (an SPA's popstate updates `session.url` through `route.change`);
 *   - a new document connected for the same tab (same id with a new document id, or a new id).
 *
 * The clock is injected, so nothing here asserts a duration: only what was found and how often the
 * loop looked.
 */

import { describe, expect, it } from 'vitest';
import { awaitHistoryArrival, awaitLeaseBack, type HistoryScope } from './history-arrival.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

const ORDERS = 'http://localhost:3000/orders';
const CART = 'http://localhost:3000/cart';
const LEASED_ORDERS = 'http://localhost:3000/orders?__reticle_session=lease-1';
const CHECKOUT = 'http://localhost:3000/checkout';
const LOGIN = 'http://localhost:3000/login';

interface Row {
  id: string;
  url: string;
  documentId?: string;
  /** A new Session object under the same id: the SDK reopened its socket or a new document said HELLO. */
  replaced?: boolean;
}

function session(row: Row): Session {
  return { id: row.id, url: row.url, currentDocumentId: row.documentId } as unknown as Session;
}

/**
 * A registry whose rows change on each `all()`. The same id keeps the same Session object (and has
 * its url and document id moved in place, as a route change does) unless a row says `replaced`.
 */
function registry(
  first: Session,
  later: Row[][],
): { sessions: SessionManager; looks: () => number } {
  const live = new Map<string, Session>([[first.id, first]]);
  let look = 0;
  const sessions = {
    all: () => {
      const rows = later[Math.min(look, later.length - 1)] ?? [];
      look++;
      return rows.map((row) => {
        const existing = live.get(row.id);
        if (existing === undefined || true === row.replaced) {
          const fresh = session(row);
          live.set(row.id, fresh);
          return fresh;
        }
        const moving = existing as unknown as {
          url: string;
          currentDocumentId: string | undefined;
        };
        moving.url = row.url;
        moving.currentDocumentId = row.documentId;
        return existing;
      });
    },
  } as unknown as SessionManager;
  return { sessions, looks: () => look };
}

function fakeClock(step: number): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: () => {
      t += step;
      return Promise.resolve();
    },
  };
}

function scopeFor(driven: Session, priorIds: string[] = [driven.id]): HistoryScope {
  return {
    navigatedSession: driven,
    navigatedFrom: driven.url,
    ...(driven.currentDocumentId === undefined
      ? {}
      : { navigatedFromDocumentId: driven.currentDocumentId }),
    priorIds: new Set(priorIds),
  };
}

describe('awaitHistoryArrival', () => {
  it('confirms a same-document move when the tab reports a new URL (an SPA popstate)', async () => {
    const driven = session({ id: 's1', url: CART, documentId: 'd1' });
    const { sessions } = registry(driven, [
      [{ id: 's1', url: CART, documentId: 'd1' }],
      [{ id: 's1', url: ORDERS, documentId: 'd1' }],
    ]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven), 5_000, fakeClock(100)),
    ).resolves.toEqual({ sessionId: 's1', url: ORDERS, settled: true });
  });

  it('confirms a move to another document that reconnects under the same id', async () => {
    const driven = session({ id: 's1', url: CART, documentId: 'd1' });
    const { sessions } = registry(driven, [
      [],
      [{ id: 's1', url: ORDERS, documentId: 'd2', replaced: true }],
    ]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven), 5_000, fakeClock(100)),
    ).resolves.toEqual({ sessionId: 's1', url: ORDERS, settled: true });
  });

  it('confirms a move to another document at the SAME URL, from its new document id', async () => {
    // Back after a form posted to its own page: the entry has the same URL and a new document.
    // Only the document id can show the tab moved.
    const driven = session({ id: 's1', url: ORDERS, documentId: 'd1' });
    const { sessions } = registry(driven, [
      [{ id: 's1', url: ORDERS, documentId: 'd1' }],
      [{ id: 's1', url: ORDERS, documentId: 'd2', replaced: true }],
    ]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven), 5_000, fakeClock(100)),
    ).resolves.toEqual({ sessionId: 's1', url: ORDERS, settled: true });
  });

  it('confirms a new document that reconnects under a new id once the old one is gone', async () => {
    const driven = session({ id: 's1', url: CART, documentId: 'd1' });
    const { sessions } = registry(driven, [[], [{ id: 's2', url: ORDERS, documentId: 'd2' }]]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven), 5_000, fakeClock(100)),
    ).resolves.toEqual({ sessionId: 's2', url: ORDERS, settled: true });
  });

  it('reports where a route guard sent the tab, not the entry it passed through', async () => {
    // Back to /checkout, and the SPA's guard replaces it with /login. The tab reports two route
    // changes. The first move seen is not the answer: the answer is where the tab stopped.
    const driven = session({ id: 's1', url: CART, documentId: 'd1' });
    const { sessions } = registry(driven, [
      [{ id: 's1', url: CART, documentId: 'd1' }],
      [{ id: 's1', url: CHECKOUT, documentId: 'd1' }],
      [{ id: 's1', url: LOGIN, documentId: 'd1' }],
    ]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven), 5_000, fakeClock(100)),
    ).resolves.toEqual({ sessionId: 's1', url: LOGIN, settled: true });
  });

  it('reports a new document redirected after it connected, at where it stopped', async () => {
    const driven = session({ id: 's1', url: CART, documentId: 'd1' });
    const { sessions } = registry(driven, [
      [],
      [{ id: 's2', url: CHECKOUT, documentId: 'd2' }],
      [{ id: 's2', url: LOGIN, documentId: 'd2' }],
    ]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven), 5_000, fakeClock(100)),
    ).resolves.toEqual({ sessionId: 's2', url: LOGIN, settled: true });
  });

  it('says the tab had not stopped when the budget ends while it is still moving', async () => {
    // Moved on the first look, moved again on the last one. Where it was last seen is reported,
    // and `settled:false` says it was still moving, so the caller does not read it as the end.
    const driven = session({ id: 's1', url: CART, documentId: 'd1' });
    const { sessions } = registry(driven, [
      [{ id: 's1', url: CHECKOUT, documentId: 'd1' }],
      [{ id: 's1', url: LOGIN, documentId: 'd1' }],
    ]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven), 100, fakeClock(100)),
    ).resolves.toEqual({ sessionId: 's1', url: LOGIN, settled: false });
  });

  it('does not name a newcomer while the navigated document is still connected and unmoved', async () => {
    // A new session elsewhere could be a second tab. The navigated tab has not moved, so nothing
    // says this newcomer is its new document. It counts once the old document has gone.
    const driven = session({ id: 's1', url: CART, documentId: 'd1' });
    const { sessions, looks } = registry(driven, [
      [
        { id: 's1', url: CART, documentId: 'd1' },
        { id: 's2', url: ORDERS, documentId: 'd2' },
      ],
      [
        { id: 's1', url: CART, documentId: 'd1' },
        { id: 's2', url: ORDERS, documentId: 'd2' },
      ],
      [{ id: 's2', url: ORDERS, documentId: 'd2' }],
    ]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven), 5_000, fakeClock(100)),
    ).resolves.toEqual({ sessionId: 's2', url: ORDERS, settled: true });
    // Three looks until the old document left, and one more that saw the newcomer had not moved.
    expect(looks()).toBe(4);
  });

  it('does not name a tab that was connected at dispatch, wherever it goes', async () => {
    const driven = session({ id: 's1', url: CART, documentId: 'd1' });
    const { sessions } = registry(driven, [[{ id: 'other', url: ORDERS, documentId: 'd9' }]]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven, ['s1', 'other']), 300, fakeClock(100)),
    ).resolves.toBeNull();
  });

  it('does not name a lease that connects under its own identity', async () => {
    const driven = session({ id: 's1', url: CART, documentId: 'd1' });
    const { sessions } = registry(driven, [
      [{ id: 'lease-1', url: LEASED_ORDERS, documentId: 'd9' }],
    ]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven), 300, fakeClock(100)),
    ).resolves.toBeNull();
  });

  it('does not read a socket reopened on the same page as a move', async () => {
    // The SDK reopens its socket in place and replaces the Session object. Same URL, and no
    // document id on either side: nothing shows the tab moved, so this is not an arrival.
    const driven = session({ id: 's1', url: CART });
    const { sessions } = registry(driven, [[{ id: 's1', url: CART, replaced: true }]]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven), 300, fakeClock(100)),
    ).resolves.toBeNull();
  });

  it('gives up and returns null, not hanging, when the tab never moves', async () => {
    const driven = session({ id: 's1', url: CART, documentId: 'd1' });
    const { sessions, looks } = registry(driven, [[{ id: 's1', url: CART, documentId: 'd1' }]]);
    await expect(
      awaitHistoryArrival(sessions, scopeFor(driven), 500, fakeClock(100)),
    ).resolves.toBeNull();
    // One look at the start and one after each of the five sleeps: bounded by the budget.
    expect(looks()).toBe(6);
  });
});

describe('awaitLeaseBack', () => {
  // A lease with no SDK was moved through the browser. Its SDK reattaches under the lease's id
  // when the page it reached is the app, and the same settle rule applies.
  const absent = session({ id: 'gone', url: 'about:blank' });

  it('confirms the lease once its SDK has reattached and stopped', async () => {
    const { sessions } = registry(absent, [
      [],
      [{ id: 'lease-1', url: CHECKOUT, documentId: 'd2' }],
      [{ id: 'lease-1', url: LOGIN, documentId: 'd2' }],
    ]);
    await expect(awaitLeaseBack(sessions, 'lease-1', 5_000, fakeClock(100))).resolves.toEqual({
      sessionId: 'lease-1',
      url: LOGIN,
      settled: true,
    });
  });

  it('does not take another session for the lease', async () => {
    const { sessions } = registry(absent, [[{ id: 'other', url: ORDERS, documentId: 'd9' }]]);
    await expect(awaitLeaseBack(sessions, 'lease-1', 300, fakeClock(100))).resolves.toBeNull();
  });

  it('gives up and returns null when the SDK never reattaches', async () => {
    const { sessions, looks } = registry(absent, [[]]);
    await expect(awaitLeaseBack(sessions, 'lease-1', 500, fakeClock(100))).resolves.toBeNull();
    expect(looks()).toBe(6);
  });
});
