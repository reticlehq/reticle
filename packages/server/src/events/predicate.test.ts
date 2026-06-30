import { describe, it, expect } from 'vitest';
import {
  EventType,
  ReticleCommand,
  type CommandResult,
  type ElementQuery,
  type ReticleEvent,
  type MatchResult,
} from '@reticlehq/protocol';
import { evaluatePredicate, waitForPredicate, type PredicateSession } from './predicate.js';

/** In-memory session: events from an array, MATCH from a supplied matcher. */
class FakeSession implements PredicateSession {
  constructor(
    private readonly events: ReticleEvent[],
    private readonly matcher: (query: ElementQuery) => MatchResult = () => ({
      matched: false,
      count: 0,
      elements: [],
    }),
    private readonly nowMs = 0,
  ) {}

  elapsed(): number {
    return this.nowMs;
  }

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.MATCH) {
      const result = this.matcher(args['query'] ?? {});
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }

  eventsSince(cursor = 0): ReticleEvent[] {
    // Mirror RingBuffer.since: only events at/after the cursor (so the `since` floor is exercised).
    return this.events.filter((e) => e.t >= cursor);
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

function ev(type: EventType, data: Record<string, unknown>, t = 1): ReticleEvent {
  return { t, type, sessionId: 's', data };
}

describe('predicate engine', () => {
  it('matches a network predicate', async () => {
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/order', status: 200 }),
    ]);
    const r = await evaluatePredicate(session, {
      kind: 'net',
      method: 'POST',
      urlContains: '/api/order',
      status: 200,
    });
    expect(r.pass).toBe(true);
  });

  it('net count: exactly-once passes on one match, fails on a double-submit', async () => {
    // The regression class: an action that should fire ONE request fires two (double-submit /
    // useEffect double-fire / a retry storm). Presence-only `net` passes both; `count` catches it.
    const once = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }),
    ]);
    const okPredicate = {
      kind: 'net' as const,
      method: 'POST',
      urlContains: '/api/deploy',
      count: 1,
    };
    expect((await evaluatePredicate(once, okPredicate)).pass).toBe(true);

    const twice = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }),
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }),
    ]);
    const r = await evaluatePredicate(twice, okPredicate);
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('2');
  });

  it('net count: an unmatched url is not counted (count scoped to the matcher)', async () => {
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }),
      ev(EventType.NET_REQUEST, { method: 'GET', url: '/api/other', status: 200 }),
    ]);
    expect(
      (await evaluatePredicate(session, { kind: 'net', urlContains: '/api/deploy', count: 1 }))
        .pass,
    ).toBe(true);
  });

  it('net count: respects the since floor (a prior-action request is not counted)', async () => {
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }, 10),
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/deploy', status: 200 }, 30),
    ]);
    const predicate = { kind: 'net' as const, urlContains: '/api/deploy', count: 1 };
    expect((await evaluatePredicate(session, predicate)).pass).toBe(false); // both counted = 2
    expect((await evaluatePredicate(session, predicate, 20)).pass).toBe(true); // floor drops the stale one
  });

  it('since floor: a stale signal before the cursor does NOT fake a pass', async () => {
    // A signal fired at t=10 (e.g. during a PRIOR act). Asserting after a later act (floor=20)
    // must NOT match it — that is the stale-buffer false-pass the honesty fix closes.
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'validation', data: { score: 68 } }, 10),
    ]);
    const predicate = {
      kind: 'signal' as const,
      name: 'validation',
      dataMatches: { score: 68 },
    };
    expect((await evaluatePredicate(session, predicate)).pass).toBe(true); // no floor → legacy behavior
    expect((await evaluatePredicate(session, predicate, 20)).pass).toBe(false); // floor=20 → stale ignored
  });

  it('since floor: a fresh signal at/after the cursor still matches', async () => {
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'validation', data: { score: 78 } }, 25),
    ]);
    const predicate = {
      kind: 'signal' as const,
      name: 'validation',
      dataMatches: { score: 78 },
    };
    expect((await evaluatePredicate(session, predicate, 20)).pass).toBe(true);
  });

  it('console absent passes when no errors, fails when present', async () => {
    const clean = new FakeSession([ev(EventType.CONSOLE_LOG, { message: 'hi' })]);
    expect(
      (await evaluatePredicate(clean, { kind: 'console', level: 'error', absent: true })).pass,
    ).toBe(true);
    const dirty = new FakeSession([ev(EventType.CONSOLE_ERROR, { message: 'boom' })]);
    expect(
      (await evaluatePredicate(dirty, { kind: 'console', level: 'error', absent: true })).pass,
    ).toBe(false);
  });

  it('allOf requires every sub-predicate, anyOf requires one', async () => {
    const session = new FakeSession([
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/order', status: 200 }),
      ev(EventType.ROUTE_CHANGE, { pathname: '/success' }),
    ]);
    const all = await evaluatePredicate(session, {
      kind: 'allOf',
      predicates: [
        { kind: 'net', urlContains: '/api/order', status: 200 },
        { kind: 'route', pathname: '/success' },
      ],
    });
    expect(all.pass).toBe(true);

    const allFail = await evaluatePredicate(session, {
      kind: 'allOf',
      predicates: [
        { kind: 'net', urlContains: '/api/order', status: 200 },
        { kind: 'route', pathname: '/nope' },
      ],
    });
    expect(allFail.pass).toBe(false);
    expect(allFail.failureReason).toBeTruthy();

    const any = await evaluatePredicate(session, {
      kind: 'anyOf',
      predicates: [
        { kind: 'route', pathname: '/nope' },
        { kind: 'route', pathname: '/success' },
      ],
    });
    expect(any.pass).toBe(true);
  });

  it('not inverts', async () => {
    const session = new FakeSession([]);
    const r = await evaluatePredicate(session, {
      kind: 'not',
      predicate: { kind: 'console', level: 'error' },
    });
    expect(r.pass).toBe(true);
  });

  it('signal predicate matches name + dataMatches with wildcard', async () => {
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'webhook:received', data: { provider: 'stripe', id: 'pi_1' } }),
    ]);
    const r = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'webhook:received',
      dataMatches: { provider: 'stripe', id: '*' },
    });
    expect(r.pass).toBe(true);
  });

  it('signal dataMatches supports operators and array contains', async () => {
    const session = new FakeSession([
      ev(EventType.SIGNAL, {
        name: 'chat:edit-applied',
        data: { count: 2, sections: ['hook', 'beat'] },
      }),
    ]);
    const pass = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'chat:edit-applied',
      dataMatches: { count: { $gte: 1 }, sections: { $contains: 'hook' } },
    });
    expect(pass.pass).toBe(true);
    const fail = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'chat:edit-applied',
      dataMatches: { count: { $gte: 5 } },
    });
    expect(fail.pass).toBe(false);
  });

  it('signal failure reports a near-miss with what actually fired', async () => {
    const session = new FakeSession([
      ev(EventType.SIGNAL, { name: 'section:added', data: { label: '' } }),
    ]);
    const r = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'section:added',
      dataMatches: { label: 'Beat' },
    });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('fired');
    expect(r.evidence).toMatchObject({ nearMiss: [{ label: '' }] });
  });

  it('element predicate reports a near-miss when the name is wrong', async () => {
    const session = new FakeSession([], (query) => {
      // Only a button named "Cancel" exists.
      if (query.role === 'button' && query.name === undefined) {
        return {
          matched: true,
          count: 1,
          elements: [{ ref: 'e1', role: 'button', name: 'Cancel', states: [], visible: true }],
        };
      }
      return { matched: false, count: 0, elements: [] };
    });
    const r = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'button', name: 'Submit' },
    });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('Cancel');
  });

  it('turns a disconnected browser command into a failed wait verdict', async () => {
    const session: PredicateSession = {
      command: () => Promise.reject(new Error('session disconnected')),
      eventsSince: () => [],
      onEvent: () => () => undefined,
      elapsed: () => 0,
    };
    const result = await waitForPredicate(
      session,
      { kind: 'element', query: { text: 'Ready' } },
      100,
    );
    expect(result).toEqual({ pass: false, failureReason: 'session disconnected' });
  });
});

describe('settled predicate (deterministic waiting)', () => {
  it('passes when there has been no network/DOM/animation activity since the floor', async () => {
    // Only a non-activity event (signal) in the buffer → nothing to settle → quiet.
    const session = new FakeSession([ev(EventType.SIGNAL, { name: 'x' }, 100)], undefined, 1000);
    const r = await evaluatePredicate(session, { kind: 'settled' }, 0);
    expect(r.pass).toBe(true);
  });

  it('fails while the last activity is more recent than quietMs', async () => {
    // Last network call at t=900, now=1000 → 100ms quiet < 200ms required.
    const session = new FakeSession(
      [ev(EventType.NET_REQUEST, { url: '/api/x', status: 200 }, 900)],
      undefined,
      1000,
    );
    const r = await evaluatePredicate(session, { kind: 'settled', quietMs: 200 }, 0);
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('not settled');
    expect((r.evidence as { quietForMs: number }).quietForMs).toBe(100);
  });

  it('passes once the quiet gap reaches quietMs (structural DOM mutation long enough ago)', async () => {
    // Last DOM node added at t=500, now=1000 → 500ms quiet ≥ 200ms required.
    const session = new FakeSession([ev(EventType.DOM_ADDED, {}, 500)], undefined, 1000);
    const r = await evaluatePredicate(session, { kind: 'settled', quietMs: 200 }, 0);
    expect(r.pass).toBe(true);
    expect((r.evidence as { quietForMs: number }).quietForMs).toBe(500);
  });

  it('ignores ambient dom.text / animation frames so an animated page can still settle', async () => {
    // A count-up counter + spinner emit a text/anim event EVERY frame — here at t=995/998, only
    // 2-5ms ago. If these counted as activity the page would never go quiet; they must not.
    const session = new FakeSession(
      [
        ev(EventType.DOM_TEXT, { text: '42' }, 995),
        ev(EventType.ANIM_START, { name: 'spin' }, 996),
        ev(EventType.ANIM_END, { name: 'pulse' }, 998),
      ],
      undefined,
      1000,
    );
    const r = await evaluatePredicate(session, { kind: 'settled', quietMs: 200 }, 0);
    expect(r.pass).toBe(true); // settled despite very recent text/anim churn
  });

  it('respects the since floor: activity before the floor does not count', async () => {
    // A burst at t=100, then quiet. Asserting from floor=900 ignores the old burst → settled.
    const session = new FakeSession(
      [ev(EventType.DOM_ADDED, {}, 100), ev(EventType.ANIM_START, { name: 'spin' }, 100)],
      undefined,
      1000,
    );
    expect((await evaluatePredicate(session, { kind: 'settled', quietMs: 200 }, 900)).pass).toBe(
      true,
    );
    // From the start (floor 0) the burst is in scope but it is 900ms old → still settled.
    expect((await evaluatePredicate(session, { kind: 'settled', quietMs: 200 }, 0)).pass).toBe(
      true,
    );
  });

  it('composes inside allOf with a consequence predicate', async () => {
    const session = new FakeSession(
      [
        ev(EventType.SIGNAL, { name: 'deploy:shipped', data: {} }, 600),
        ev(EventType.NET_REQUEST, { url: '/api/deploy', status: 200 }, 600),
      ],
      undefined,
      1000,
    );
    const r = await evaluatePredicate(
      session,
      {
        kind: 'allOf',
        predicates: [
          { kind: 'signal', name: 'deploy:shipped' },
          { kind: 'settled', quietMs: 300 },
        ],
      },
      0,
    );
    expect(r.pass).toBe(true);
  });
});

/** Session whose STATE_READ returns a fixed `{ stores }` map — exercises the state predicate. */
class StateSession implements PredicateSession {
  constructor(private readonly stores: Record<string, unknown>) {}
  elapsed(): number {
    return 0;
  }
  command(name: string): Promise<CommandResult> {
    if (name === ReticleCommand.STATE_READ) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'x',
        ok: true,
        result: { stores: this.stores, storeNames: Object.keys(this.stores) },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
}

describe('state predicate — assert store truth', () => {
  const app = {
    app: {
      deployments: [
        { id: 1, status: 'queued' },
        { id: 2, status: 'live' },
      ],
      count: 2,
    },
  };

  it('passes when a dot-path value equals the expected literal', async () => {
    const r = await evaluatePredicate(new StateSession(app), {
      kind: 'state',
      store: 'app',
      path: 'deployments.0.status',
      equals: 'queued',
    });
    expect(r.pass).toBe(true);
  });

  it('fails legibly when the displayed value lies about the store (desync)', async () => {
    // UI showed "live"; the store says "queued". Asserting equals:'live' must fail and name the truth.
    const r = await evaluatePredicate(new StateSession(app), {
      kind: 'state',
      store: 'app',
      path: 'deployments.0.status',
      equals: 'live',
    });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('queued');
  });

  it('supports operator patterns ($gte, $length)', async () => {
    const session = new StateSession(app);
    expect(
      (
        await evaluatePredicate(session, {
          kind: 'state',
          store: 'app',
          path: 'count',
          equals: { $gte: 2 },
        })
      ).pass,
    ).toBe(true);
    expect(
      (
        await evaluatePredicate(session, {
          kind: 'state',
          store: 'app',
          path: 'deployments',
          equals: { $length: 2 },
        })
      ).pass,
    ).toBe(true);
    expect(
      (
        await evaluatePredicate(session, {
          kind: 'state',
          store: 'app',
          path: 'count',
          equals: { $gte: 5 },
        })
      ).pass,
    ).toBe(false);
  });

  it('presence check passes when equals is omitted and the path resolves', async () => {
    const r = await evaluatePredicate(new StateSession(app), {
      kind: 'state',
      store: 'app',
      path: 'deployments.1.id',
    });
    expect(r.pass).toBe(true);
  });

  it('diagnoses a missing path with the keys that WERE available', async () => {
    const r = await evaluatePredicate(new StateSession(app), {
      kind: 'state',
      store: 'app',
      path: 'deployments.0.nope',
    });
    expect(r.pass).toBe(false);
    expect((r.evidence as { availableKeys?: string[] }).availableKeys).toContain('status');
  });

  it('defaults to the only store when none is named, but flags ambiguity otherwise', async () => {
    const single = await evaluatePredicate(new StateSession({ app: { v: 1 } }), {
      kind: 'state',
      path: 'v',
      equals: 1,
    });
    expect(single.pass).toBe(true);
    const ambiguous = await evaluatePredicate(new StateSession({ app: {}, cart: {} }), {
      kind: 'state',
      path: 'v',
    });
    expect(ambiguous.pass).toBe(false);
    expect(ambiguous.failureReason).toContain('multiple stores');
  });
});
