import { describe, it, expect } from 'vitest';
import {
  EventType,
  IrisCommand,
  type CommandResult,
  type ElementQuery,
  type IrisEvent,
  type MatchResult,
} from '@syrin/iris-protocol';
import { evaluatePredicate, waitForPredicate, type PredicateSession } from './predicate.js';

/** In-memory session: events from an array, MATCH from a supplied matcher. */
class FakeSession implements PredicateSession {
  constructor(
    private readonly events: IrisEvent[],
    private readonly matcher: (query: ElementQuery) => MatchResult = () => ({
      matched: false,
      count: 0,
      elements: [],
    }),
  ) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === IrisCommand.MATCH) {
      const result = this.matcher(args['query'] ?? {});
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }

  eventsSince(cursor = 0): IrisEvent[] {
    // Mirror RingBuffer.since: only events at/after the cursor (so the `since` floor is exercised).
    return this.events.filter((e) => e.t >= cursor);
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

function ev(type: EventType, data: Record<string, unknown>, t = 1): IrisEvent {
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
    };
    const result = await waitForPredicate(
      session,
      { kind: 'element', query: { text: 'Ready' } },
      100,
    );
    expect(result).toEqual({ pass: false, failureReason: 'session disconnected' });
  });
});
