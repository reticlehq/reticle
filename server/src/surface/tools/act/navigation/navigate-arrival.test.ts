/**
 * `confirmed` used to be `false` on every navigation on every app. These prove it now varies with
 * reality — and, just as importantly, that a navigation nobody arrives at still ANSWERS rather than
 * hanging.
 *
 * The clock is injected, so none of this asserts a duration. Per CLAUDE.md: if the property is
 * "cost is bounded", assert the bound — here, that the loop terminates and how many times it looked
 * — never elapsed milliseconds, which is a statement about the machine.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { awaitArrival, idsOpenAtDispatch, type ArrivalScope } from './navigate-arrival.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

/**
 * Sessions by id, shared by `drove` and `fakeSessions` so a tab the navigation was dispatched to is
 * the same object the registry later reports. A HELLO replaces that object even when the page did
 * not reload; `awaitArrival` tells the two apart by the document id sampled before dispatch.
 */
const knownSessions = new Map<string, Session>();
beforeEach(() => knownSessions.clear());

/** A minimal Session-shaped object for the successor logic used by `awaitArrival`. */
function fakeSession(id: string, url: string, openedBefore = false, documentId?: string): Session {
  return {
    id,
    url,
    documentId,
    projectId: undefined,
    // The real Session derives this from the most recent stamped event; the fake reads the slot the
    // moving snapshots overwrite.
    get currentDocumentId(): string | undefined {
      return (this as unknown as { documentId?: string }).documentId;
    },
    staleMs: () => (openedBefore ? 1_000 : 0),
    agentIdleMs: () => 100,
  } as unknown as Session;
}

/**
 * A deterministic SessionManager fake whose snapshots change on each `all()` call.
 *
 * `awaitArrival` normally only needs `all()`, while successor detection additionally needs `get()`.
 * Keeping both here lets these tests exercise the same successor path used by the real manager.
 */
function fakeSessions(urlsOverTime: { id: string; url: string; documentId?: string }[][]): {
  sessions: SessionManager;
  looks: () => number;
} {
  const sessionsById = knownSessions;
  let look = 0;
  let currentSnapshot: Session[] = [];

  const buildSnapshot = (index: number): Session[] => {
    const snapshot = urlsOverTime[Math.min(index, urlsOverTime.length - 1)] ?? [];

    return snapshot.map(({ id, url, documentId }) => {
      const existing = sessionsById.get(id);

      if (existing !== undefined) {
        existing.url = url;
        (existing as unknown as { documentId: string | undefined }).documentId = documentId;
        return existing;
      }

      const session = fakeSession(id, url, false, documentId);
      sessionsById.set(id, session);
      return session;
    });
  };

  const sessions = {
    all: () => {
      currentSnapshot = buildSnapshot(look);
      look++;
      return currentSnapshot;
    },

    get: (id: string) => {
      return currentSnapshot.find((session) => session.id === id);
    },
  } as unknown as SessionManager;

  return {
    sessions,
    looks: () => look,
  };
}

/** A clock that advances only when slept on, so the test is deterministic and instant. */
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

const TARGET = 'http://localhost:3000/dashboard';

/** The navigation drove `id`, and nothing was sitting on the target beforehand. */
function drove(id: string): ArrivalScope {
  let navigatedSession = knownSessions.get(id);
  if (navigatedSession === undefined) {
    navigatedSession = fakeSession(id, 'http://localhost:3000/orders');
    knownSessions.set(id, navigatedSession);
  }
  return {
    navigatedSession,
    navigatedFrom: 'http://localhost:3000/orders',
    priorIds: new Set(),
  };
}

describe('awaitArrival', () => {
  // Renamed: "already at the target" now names the case this must IGNORE — a session that was
  // there BEFORE the navigation. This one is about arriving without having to wait.
  it('confirms on the first look when the arriving session is already present', async () => {
    const { sessions } = fakeSessions([[{ id: 's1', url: TARGET }]]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 5_000, fakeClock(100)),
    ).resolves.toEqual({
      sessionId: 's1',
    });
  });

  it('waits for one that arrives a few polls later', async () => {
    const { sessions } = fakeSessions([[], [], [{ id: 's2', url: TARGET }]]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 5_000, fakeClock(100)),
    ).resolves.toEqual({
      sessionId: 's2',
    });
  });

  it('gives up and returns null rather than hanging when nothing arrives', async () => {
    const { sessions, looks } = fakeSessions([[]]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 500, fakeClock(100)),
    ).resolves.toBeNull();
    // The BOUND, not the duration: a 500ms budget at 100ms per poll looks a handful of times.
    expect(looks()).toBeLessThanOrEqual(7);
  });

  it('ignores a session sitting on a different page', async () => {
    const { sessions } = fakeSessions([
      [
        { id: 'driven', url: 'http://localhost:3000/orders' },
        { id: 'other', url: 'http://localhost:3000/settings' },
      ],
    ]);

    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 300, fakeClock(100)),
    ).resolves.toBeNull();
  });

  /**
   * The app is entitled to rewrite query and hash on arrival — an auth guard appending
   * `?redirect=`, a router normalising a trailing slash. Demanding an exact URL match would report
   * `confirmed:false` for a navigation that plainly worked, which is the same lie in reverse.
   */
  it('confirms arrival when the app added a query string', async () => {
    const { sessions } = fakeSessions([
      [{ id: 's3', url: 'http://localhost:3000/dashboard?redirect=%2F' }],
    ]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 500, fakeClock(100)),
    ).resolves.toEqual({
      sessionId: 's3',
    });
  });

  it('and when only a trailing slash differs', async () => {
    const { sessions } = fakeSessions([[{ id: 's4', url: 'http://localhost:3000/dashboard/' }]]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 500, fakeClock(100)),
    ).resolves.toEqual({
      sessionId: 's4',
    });
  });

  it('ignores a session that was already sitting on the target before the navigation', async () => {
    // The defect. A stale row parked on this origin — in the field report, one belonging to a
    // different app that had previously held the same port — matched the scan and was reported as
    // the session you had arrived at. It was there before the navigation, so it is evidence of
    // nothing about it.
    const { sessions } = fakeSessions([
      [
        { id: 'driven', url: 'http://localhost:3000/orders' },
        { id: 'zombie', url: TARGET },
      ],
    ]);
    const scope: ArrivalScope = {
      ...drove('driven'),
      priorIds: new Set(['zombie']),
    };
    await expect(awaitArrival(sessions, TARGET, scope, 300, fakeClock(100))).resolves.toBeNull();
  });

  it('confirms the driven session even when it was already at the target', async () => {
    // A reload, or a route change that keeps the document: the navigated session is legitimately at
    // the target both before and after, under the same id. Excluding it would report confirmed:false
    // for the navigation most likely to have worked.
    const { sessions } = fakeSessions([[{ id: 'driven', url: TARGET }]]);
    const scope: ArrivalScope = {
      navigatedSession: fakeSession('driven', 'http://localhost:3000/orders'),
      navigatedFrom: 'http://localhost:3000/orders',
      priorIds: new Set(['driven']),
    };
    await expect(awaitArrival(sessions, TARGET, scope, 500, fakeClock(100))).resolves.toEqual({
      sessionId: 'driven',
    });
  });

  it('does not confirm a same-page navigation while the OLD document is still connected', async () => {
    // Navigating to the page already shown (a sign-in flow that redirects to itself) replaces the
    // document. The old document stays connected until the replacement reports, and its presence at
    // the target is not arrival yet — the report's replay started here and lost the document (#1320).
    const { sessions, looks } = fakeSessions([
      [{ id: 'driven', url: TARGET, documentId: 'doc-old' }],
    ]);
    const scope: ArrivalScope = {
      navigatedSession: fakeSession('driven', TARGET, false, 'doc-old'),
      navigatedFrom: TARGET,
      navigatedFromDocumentId: 'doc-old',
      priorIds: new Set(['driven']),
    };
    await expect(awaitArrival(sessions, TARGET, scope, 500, fakeClock(100))).resolves.toBeNull();
    expect(looks()).toBeGreaterThan(1);
  });

  it('confirms a same-page navigation once the replacement document reports', async () => {
    const { sessions, looks } = fakeSessions([
      [{ id: 'driven', url: TARGET, documentId: 'doc-old' }],
      [{ id: 'driven', url: TARGET, documentId: 'doc-old' }],
      [{ id: 'driven', url: TARGET, documentId: 'doc-new' }],
    ]);
    const scope: ArrivalScope = {
      navigatedSession: fakeSession('driven', TARGET, false, 'doc-old'),
      navigatedFrom: TARGET,
      navigatedFromDocumentId: 'doc-old',
      priorIds: new Set(['driven']),
    };
    await expect(awaitArrival(sessions, TARGET, scope, 500, fakeClock(100))).resolves.toEqual({
      sessionId: 'driven',
    });
    expect(looks()).toBeGreaterThan(1);
  });

  it('confirms a same-page navigation that reconnects under a new id', async () => {
    const { sessions } = fakeSessions([[{ id: 'successor', url: TARGET, documentId: 'doc-new' }]]);
    const scope: ArrivalScope = {
      navigatedSession: fakeSession('driven', TARGET, false, 'doc-old'),
      navigatedFrom: TARGET,
      navigatedFromDocumentId: 'doc-old',
      priorIds: new Set(['driven']),
    };
    await expect(awaitArrival(sessions, TARGET, scope, 500, fakeClock(100))).resolves.toEqual({
      sessionId: 'successor',
    });
  });

  it('confirms a fragment navigation without waiting for a document change', async () => {
    // A fragment-only navigation changes the URL without replacing the document, so there is no
    // replacement to wait for — the connected document IS the arrival.
    const { sessions } = fakeSessions([[{ id: 'driven', url: TARGET, documentId: 'doc-old' }]]);
    const scope: ArrivalScope = {
      navigatedSession: fakeSession('driven', `${TARGET}#intro`, false, 'doc-old'),
      navigatedFrom: `${TARGET}#intro`,
      navigatedFromDocumentId: 'doc-old',
      priorIds: new Set(['driven']),
    };
    await expect(awaitArrival(sessions, TARGET, scope, 500, fakeClock(100))).resolves.toEqual({
      sessionId: 'driven',
    });
  });

  it('does not let another tab confirm while the driven document is still connected', async () => {
    // A second tab reaching the target during a same-URL navigation is not the replacement the
    // caller waits for; the still-connected driven document is proof this navigation is in flight.
    const { sessions } = fakeSessions([
      [
        { id: 'driven', url: TARGET, documentId: 'doc-old' },
        { id: 'other-tab', url: TARGET, documentId: 'doc-other' },
      ],
    ]);
    const scope: ArrivalScope = {
      navigatedSession: fakeSession('driven', TARGET, false, 'doc-old'),
      navigatedFrom: TARGET,
      navigatedFromDocumentId: 'doc-old',
      priorIds: new Set(['driven']),
    };
    await expect(awaitArrival(sessions, TARGET, scope, 500, fakeClock(100))).resolves.toBeNull();
  });

  it('reports the session that actually arrived, not the zombie scanned before it', async () => {
    // `sessions.all()` is Map insertion order, so an older stale row is scanned FIRST. That is what
    // made the wrong id the likely answer rather than a coin flip.
    const { sessions } = fakeSessions([
      [
        { id: 'zombie', url: TARGET },
        { id: 'fresh', url: TARGET },
      ],
    ]);
    const scope: ArrivalScope = {
      navigatedSession: fakeSession('driven', 'http://localhost:3000/orders'),
      navigatedFrom: 'http://localhost:3000/orders',
      priorIds: new Set(['zombie']),
    };
    await expect(awaitArrival(sessions, TARGET, scope, 500, fakeClock(100))).resolves.toEqual({
      sessionId: 'fresh',
    });
  });

  it('prefers the driven session over another new arrival on the same page', async () => {
    // Two candidates and one of them is the tab we drove: it is the answer, not a tie to break by
    // scan order.
    const { sessions } = fakeSessions([
      [
        { id: 'bystander', url: TARGET },
        { id: 'driven', url: TARGET },
      ],
    ]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 500, fakeClock(100)),
    ).resolves.toEqual({ sessionId: 'driven' });
  });

  it('does not confirm a same-path page on a different origin', async () => {
    const { sessions } = fakeSessions([[{ id: 'x', url: 'http://localhost:9999/dashboard' }]]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 300, fakeClock(100)),
    ).resolves.toBeNull();
  });

  it('reports where the navigated session landed when the app redirected it', async () => {
    const { sessions } = fakeSessions([[{ id: 'driven', url: 'http://localhost:3000/login' }]]);

    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 500, fakeClock(100)),
    ).resolves.toEqual({
      sessionId: 'driven',
      landedOn: 'http://localhost:3000/login',
    });
  });

  it('reports where a successor session landed when the app redirected it', async () => {
    const { sessions } = fakeSessions([
      [{ id: 'driven', url: 'http://localhost:3000/orders' }],
      [{ id: 'successor', url: 'http://localhost:3000/login' }],
    ]);

    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 500, fakeClock(100)),
    ).resolves.toEqual({
      sessionId: 'successor',
      landedOn: 'http://localhost:3000/login',
    });
  });

  /**
   * `/login` -> navigate to `/checkout` -> the auth guard sends the tab back to `/login`. The page
   * unloaded and reconnected, so this is a redirect even though it ended where the tab started.
   */
  describe('when the app sends the tab back to where it started', () => {
    const FROM = 'http://localhost:3000/login';
    const scopeFor = (navigatedSession: Session): ArrivalScope => {
      // Sampled at dispatch, the way the navigate handler does: later events on this object must
      // not rewrite what "the document we left" means.
      const navigatedFromDocumentId = navigatedSession.currentDocumentId;
      return {
        navigatedSession,
        navigatedFrom: FROM,
        ...(navigatedFromDocumentId === undefined ? {} : { navigatedFromDocumentId }),
        priorIds: new Set(),
      };
    };
    const registryOf = (...live: Session[]): SessionManager =>
      ({
        all: () => live,
        get: (id: string) => live.find((session) => session.id === id),
      }) as unknown as SessionManager;

    it('reports a same-id reconnect in a new document as a redirect', async () => {
      const driven = fakeSession('driven', FROM, false, 'doc-before');
      const reconnected = fakeSession('driven', FROM, false, 'doc-after');

      await expect(
        awaitArrival(registryOf(reconnected), TARGET, scopeFor(driven), 0, fakeClock(100)),
      ).resolves.toEqual({ sessionId: 'driven', landedOn: FROM });
    });

    it('does not call a socket reconnect in the same document a redirect', async () => {
      // The SDK reopens its socket without reloading the page, so the Session object is replaced
      // while the tab is still on the page it started from. The document id does not move.
      const driven = fakeSession('driven', FROM, false, 'doc-before');
      const reconnected = fakeSession('driven', FROM, false, 'doc-before');

      await expect(
        awaitArrival(registryOf(reconnected), TARGET, scopeFor(driven), 300, fakeClock(100)),
      ).resolves.toBeNull();
    });

    it('reports a redirect when the sampled document id is no longer the one connected', async () => {
      // The id is read before dispatch. A later event can stamp a new document onto the session
      // object we still hold, and the sampled id is what says the page unloaded.
      const driven = fakeSession('driven', FROM, false, 'doc-before');
      const scope = scopeFor(driven);
      (driven as unknown as { documentId: string }).documentId = 'doc-after';

      await expect(
        awaitArrival(registryOf(driven), TARGET, scope, 0, fakeClock(100)),
      ).resolves.toEqual({ sessionId: 'driven', landedOn: FROM });
    });

    it('stays unconfirmed when either side has not reported its document yet', async () => {
      const unreported = fakeSession('driven', FROM);
      const known = fakeSession('driven', FROM, false, 'doc-after');
      const knownBefore = fakeSession('driven', FROM, false, 'doc-before');

      await expect(
        awaitArrival(registryOf(known), TARGET, scopeFor(unreported), 0, fakeClock(100)),
      ).resolves.toBeNull();
      await expect(
        awaitArrival(
          registryOf(fakeSession('driven', FROM)),
          TARGET,
          scopeFor(knownBefore),
          0,
          fakeClock(100),
        ),
      ).resolves.toBeNull();
    });

    it('stays unconfirmed with no landedOn when the very same tab never moved', async () => {
      const driven = fakeSession('driven', FROM, false, 'doc-before');

      await expect(
        awaitArrival(registryOf(driven), TARGET, scopeFor(driven), 300, fakeClock(100)),
      ).resolves.toBeNull();
    });

    it('does not hand back another tab that opened on the starting page', async () => {
      // The driven session is gone. This tab opened afterwards, so it is not older than the
      // dispatch, and it is the only one left at the origin — `awaitDocumentSuccessor` will pick
      // it. Sitting on the starting page does not make it this navigation's landing.
      const driven = fakeSession('driven', FROM, false, 'doc-before');
      const stranger = fakeSession('stranger', FROM, false, 'doc-other');
      let live: Session[] = [driven];
      const sessions = {
        all: () => live,
        get: (id: string) => live.find((session) => session.id === id),
      } as unknown as SessionManager;
      let now = 0;
      const clock = {
        now: () => now,
        sleep: (ms: number) => {
          now += ms;
          live = [stranger];
          return Promise.resolve();
        },
      };

      await expect(
        awaitArrival(sessions, TARGET, scopeFor(driven), 100, clock),
      ).resolves.toBeNull();
    });
  });

  it('keeps waiting when the navigated session passes through an intermediate route', async () => {
    const { sessions } = fakeSessions([
      [
        {
          id: 'driven',
          url: 'http://localhost:3000/orders',
        },
      ],
      [
        {
          id: 'driven',
          url: 'http://localhost:3000/auth/check',
        },
      ],
      [
        {
          id: 'driven',
          url: TARGET,
        },
      ],
    ]);

    const result = await awaitArrival(
      sessions,
      TARGET,
      {
        navigatedSession: fakeSession('driven', 'http://localhost:3000/orders'),
        navigatedFrom: 'http://localhost:3000/orders',
        priorIds: new Set(),
      },
      500,
      fakeClock(100),
    );

    expect(result).toEqual({
      sessionId: 'driven',
    });
  });

  it('reports the final redirect after passing through an intermediate route', async () => {
    const { sessions } = fakeSessions([
      [
        {
          id: 'driven',
          url: 'http://localhost:3000/orders',
        },
      ],
      [
        {
          id: 'driven',
          url: 'http://localhost:3000/auth/check',
        },
      ],
      [
        {
          id: 'driven',
          url: 'http://localhost:3000/login',
        },
      ],
    ]);

    const result = await awaitArrival(
      sessions,
      TARGET,
      {
        navigatedSession: fakeSession('driven', 'http://localhost:3000/orders'),
        navigatedFrom: 'http://localhost:3000/orders',
        priorIds: new Set(),
      },
      200,
      fakeClock(100),
    );

    expect(result).toEqual({
      sessionId: 'driven',
      landedOn: 'http://localhost:3000/login',
    });
  });

  it('confirms a cross-origin arrival after the original session disconnects', async () => {
    const driven = fakeSession('driven', 'http://localhost:3000/orders');

    const arriving = fakeSession('arriving', 'http://localhost:5173/dashboard');

    let live: Session[] = [driven];
    let now = 0;

    const sessions = {
      all: () => live,
      get: (id: string) => live.find((session) => session.id === id),
    } as unknown as SessionManager;

    const clock = {
      now: () => now,
      sleep: (ms: number) => {
        now += ms;

        // The original document disappears and the destination document
        // reconnects on a different origin. Arrival detection must keep
        // polling instead of delegating the remaining budget to successor
        // detection, which intentionally only matches the original origin.
        if (now >= 100) {
          live = [arriving];
        }
        return Promise.resolve();
      },
    };

    const result = await awaitArrival(
      sessions,
      'http://localhost:5173/dashboard',
      {
        navigatedSession: driven,
        navigatedFrom: 'http://localhost:3000/orders',
        priorIds: new Set(),
      },
      500,
      clock,
    );

    expect(result).toEqual({
      sessionId: 'arriving',
    });
  });

  it('confirms arrival when another tab is already open on the same origin', async () => {
    const driven = fakeSession('driven', 'http://localhost:3000/orders');

    const otherTab = fakeSession('other-tab', 'http://localhost:3000/settings');

    const arriving = fakeSession('arriving', TARGET);

    let live: Session[] = [driven, otherTab];
    let now = 0;

    const sessions = {
      all: () => live,
      get: (id: string) => live.find((session) => session.id === id),
    } as unknown as SessionManager;

    const clock = {
      now: () => now,
      sleep: (ms: number) => {
        now += ms;

        // The unrelated tab remains alive while the navigated document
        // reconnects under a new id. The arrival poll must see the target
        // instead of treating multiple same-origin sessions as ambiguity.
        if (now >= 100) {
          live = [otherTab, arriving];
        }
        return Promise.resolve();
      },
    };

    const result = await awaitArrival(
      sessions,
      TARGET,
      {
        navigatedSession: driven,
        navigatedFrom: 'http://localhost:3000/orders',
        priorIds: new Set(),
      },
      500,
      clock,
    );

    expect(result).toEqual({
      sessionId: 'arriving',
    });
  });

  it('does not report a successor intermediate route as the final landing URL', async () => {
    const driven = fakeSession('driven', 'http://localhost:3000/orders');

    const loading = fakeSession('loading', 'http://localhost:3000/loading');

    const arriving = fakeSession('arriving', TARGET);

    let live: Session[] = [driven];
    let now = 0;

    const sessions = {
      all: () => live,
      get: (id: string) => live.find((session) => session.id === id),
    } as unknown as SessionManager;

    const clock = {
      now: () => now,
      sleep: (ms: number) => {
        now += ms;

        if (now >= 100 && now < 200) {
          live = [loading];
        } else if (now >= 200) {
          live = [arriving];
        }
        return Promise.resolve();
      },
    };

    const result = await awaitArrival(
      sessions,
      TARGET,
      {
        navigatedSession: driven,
        navigatedFrom: 'http://localhost:3000/orders',
        priorIds: new Set(),
      },
      500,
      clock,
    );

    expect(result).toEqual({
      sessionId: 'arriving',
    });
  });

  it('follows a successor through another document replacement before reporting its final redirect', async () => {
    const driven = fakeSession('driven', 'http://localhost:3000/orders');
    const successorA = fakeSession('successor-a', 'http://localhost:3000/auth/check');
    const successorB = fakeSession('successor-b', 'http://localhost:3000/login');

    let live: Session[] = [driven];
    let now = 0;

    const sessions = {
      all: () => live,
      get: (id: string) => live.find((session) => session.id === id),
    } as unknown as SessionManager;

    const clock = {
      now: () => now,
      sleep: (ms: number) => {
        now += ms;

        // The first document replacement reconnects as successor-a.
        // A second replacement then removes it and reconnects as successor-b.
        // Keeping the transitions inside the clock models the real polling
        // sequence instead of advancing state every time `all()` is called.
        if (now >= 200) {
          live = [successorB];
        } else if (now >= 100) {
          live = [successorA];
        }

        return Promise.resolve();
      },
    };

    const result = await awaitArrival(
      sessions,
      TARGET,
      {
        navigatedSession: driven,
        navigatedFrom: 'http://localhost:3000/orders',
        priorIds: new Set(),
      },
      300,
      clock,
    );

    expect(result).toEqual({
      sessionId: 'successor-b',
      landedOn: 'http://localhost:3000/login',
    });
  });
});

describe('idsOpenAtDispatch', () => {
  it('names every session connected when the navigation is sent, wherever it is', () => {
    const { sessions } = fakeSessions([
      [
        { id: 'here', url: 'http://localhost:3000/dashboard?x=1' },
        { id: 'elsewhere', url: 'http://localhost:3000/settings' },
        { id: 'other-origin', url: 'http://localhost:9999/dashboard' },
      ],
    ]);
    // A tab that was already connected cannot be the new document this navigation makes.
    expect([...idsOpenAtDispatch(sessions)]).toEqual(['here', 'elsewhere', 'other-origin']);
  });
});

/**
 * `reticle_navigate { sessionId: A }` reported another tab when that tab reached the target first.
 * A lease on the same app is the common case: it is connected the whole time, or it reconnects
 * under its own claimed identity.
 */
describe('only the navigated tab, or its new document, is the arrival', () => {
  const LEASE_AT_TARGET = `${TARGET}?__reticle_session=lease-1`;

  it('does not name a tab that was connected at dispatch and reached the target first', async () => {
    const { sessions: atDispatch } = fakeSessions([
      [
        { id: 'A', url: 'http://localhost:3000/orders' },
        { id: 'lease', url: 'http://localhost:3000/faq' },
      ],
    ]);
    const priorIds = idsOpenAtDispatch(atDispatch);
    const { sessions } = fakeSessions([
      [
        { id: 'A', url: 'http://localhost:3000/orders' },
        { id: 'lease', url: TARGET },
      ],
      [
        { id: 'A', url: TARGET },
        { id: 'lease', url: TARGET },
      ],
    ]);
    const scope: ArrivalScope = { ...drove('A'), priorIds };
    await expect(awaitArrival(sessions, TARGET, scope, 500, fakeClock(100))).resolves.toEqual({
      sessionId: 'A',
    });
  });

  it('does not name a lease that reconnects at the target under its own identity', async () => {
    const { sessions } = fakeSessions([
      [
        { id: 'A', url: 'http://localhost:3000/orders' },
        { id: 'lease', url: LEASE_AT_TARGET },
      ],
      [
        { id: 'A', url: TARGET },
        { id: 'lease', url: LEASE_AT_TARGET },
      ],
    ]);
    await expect(awaitArrival(sessions, TARGET, drove('A'), 500, fakeClock(100))).resolves.toEqual({
      sessionId: 'A',
    });
  });
});
