/**
 * A field below the top level of a body or a signal payload can be asserted by its dotted path.
 *
 * `bodyMatches` was top-level only, and a nested object without an operator is compared WHOLE, so on
 * an API that wraps its answer — `{ "data": { "status": "completed", "id": 7, ... } }`, which is most
 * of them — there was no way to say "this field holds this value". The only reach left was
 * `bodyContains`, the substring the `completedAt: null` false green in
 * predicate-response-body.test.ts already fooled once.
 *
 * The grammar is the one `state.path` already speaks (`selectPath`): dot-separated own keys and
 * canonical array indices. A key that literally contains a dot still matches as written first.
 */
import { describe, it, expect } from 'vitest';
import { EventType, REDACTED_VALUE, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

function netEvent(data: Record<string, unknown>): ReticleEvent {
  return {
    type: EventType.NET_REQUEST,
    t: 10,
    data: { method: 'POST', url: 'https://app.test/api/jobs', status: 200, ok: true, ...data },
  } as unknown as ReticleEvent;
}

function signalEvent(name: string, data: unknown): ReticleEvent {
  return { type: EventType.SIGNAL, t: 10, data: { name, data } } as unknown as ReticleEvent;
}

class WindowSession implements PredicateSession {
  constructor(private readonly events: readonly ReticleEvent[]) {}
  command(): Promise<never> {
    return Promise.reject(new Error('no page commands in these tests'));
  }
  eventsSince(): ReticleEvent[] {
    return [...this.events];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 100;
  }
}

const WRAPPED = JSON.stringify({
  data: { status: 'queued', id: 7, total: 12, completedAt: null },
  items: [{ id: 'a1' }, { id: 'b2' }],
});

async function response(body: string, bodyMatches: Record<string, unknown>) {
  return evaluatePredicate(new WindowSession([netEvent({ responseBody: body })]), {
    kind: 'net',
    urlContains: '/api/jobs',
    bodyMatches,
  });
}

describe('bodyMatches reaches a nested field by its dotted path', () => {
  it('passes on the nested value', async () => {
    expect((await response(WRAPPED, { 'data.status': 'queued' })).pass).toBe(true);
  });

  it('fails on a different nested value, and names the path and what it held', async () => {
    const r = await response(WRAPPED, { 'data.status': 'completed' });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.failureReason).toContain('"data.status" is "queued"');
  });

  it('indexes into an array', async () => {
    expect((await response(WRAPPED, { 'items.1.id': 'b2' })).pass).toBe(true);
    expect((await response(WRAPPED, { 'items.1.id': 'a1' })).pass).toBe(false);
  });

  it('applies operators at any depth', async () => {
    expect((await response(WRAPPED, { 'data.total': { $gte: 10 } })).pass).toBe(true);
    expect((await response(WRAPPED, { 'items.length': 2 })).pass).toBe(true);
    expect((await response(WRAPPED, { 'data.total': { $gt: 12 } })).pass).toBe(false);
  });

  it('treats a missing path as absent, so `*` fails, and lists the keys where it stopped', async () => {
    const r = await response(WRAPPED, { 'data.state': '*' });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('"data.state" is missing');
    expect(r.failureReason).toContain('status');
  });

  it('never reads an inherited property as a field', async () => {
    expect((await response(WRAPPED, { 'data.constructor': '*' })).pass).toBe(false);
  });

  it('matches a key that literally contains a dot as written, before walking', async () => {
    const body = JSON.stringify({ 'a.b': 1, a: { b: 2 } });
    expect((await response(body, { 'a.b': 1 })).pass).toBe(true);
  });

  it('keeps a nested literal object a WHOLE-object comparison, and says how to match one field', async () => {
    const r = await response(WRAPPED, { data: { status: 'queued' } });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('"data.status"');
  });

  it('calls a redacted nested field unjudgeable, not different', async () => {
    const body = JSON.stringify({ user: { token: REDACTED_VALUE, id: 1 } });
    const r = await response(body, { 'user.token': 'abc' });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('"user.token"');
  });

  it('calls a field under a redacted parent unjudgeable too', async () => {
    const body = JSON.stringify({ secrets: REDACTED_VALUE });
    const r = await response(body, { 'secrets.apiKey': '*' });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
  });
});

describe('requestBodyMatches and signal.dataMatches share the same grammar', () => {
  it('matches a nested request field and names it on a miss', async () => {
    const session = new WindowSession([
      netEvent({ requestBody: JSON.stringify({ filter: { status: 'manual_review' } }) }),
    ]);
    const hit = await evaluatePredicate(session, {
      kind: 'net',
      urlContains: '/api/jobs',
      requestBodyMatches: { 'filter.status': 'manual_review' },
    });
    expect(hit.pass).toBe(true);
    const miss = await evaluatePredicate(session, {
      kind: 'net',
      urlContains: '/api/jobs',
      requestBodyMatches: { 'filter.status': 'approved' },
    });
    expect(miss.pass).toBe(false);
    expect(miss.failureReason).toContain('"filter.status" is "manual_review"');
  });

  it('matches a nested signal payload field and names it on a miss', async () => {
    const session = new WindowSession([signalEvent('order:placed', { order: { total: 40 } })]);
    const hit = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'order:placed',
      dataMatches: { 'order.total': 40 },
    });
    expect(hit.pass).toBe(true);
    const miss = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'order:placed',
      dataMatches: { 'order.total': 41 },
    });
    expect(miss.pass).toBe(false);
    expect(miss.observed).toContain('"order.total" is 40');
  });
});

describe('a redacted signal field is unknown, never present', () => {
  // The transport sanitizer writes the marker for every sensitive key, whatever it held — undefined
  // included — so `*` over a redacted field used to pass on a value nobody saw.
  it('does not let `*` pass on a redacted nested field', async () => {
    const session = new WindowSession([signalEvent('login', { user: { token: REDACTED_VALUE } })]);
    const r = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'login',
      dataMatches: { 'user.token': '*' },
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('"user.token"');
  });

  it('does not let `*` pass on a redacted top-level field either', async () => {
    const session = new WindowSession([signalEvent('login', { token: REDACTED_VALUE })]);
    const r = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'login',
      dataMatches: { token: '*' },
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
  });

  it('cannot count signals whose deciding field was redacted', async () => {
    const session = new WindowSession([
      signalEvent('login', { token: 'visible' }),
      signalEvent('login', { token: REDACTED_VALUE }),
    ]);
    const r = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'login',
      dataMatches: { token: 'visible' },
      count: 1,
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
  });

  it('still passes on a readable payload beside a redacted one', async () => {
    const session = new WindowSession([
      signalEvent('login', { token: REDACTED_VALUE }),
      signalEvent('login', { token: 'visible' }),
    ]);
    const r = await evaluatePredicate(session, {
      kind: 'signal',
      name: 'login',
      dataMatches: { token: 'visible' },
    });
    expect(r.pass).toBe(true);
  });
});

describe('a literal dotted key is read as written, redaction included', () => {
  it('judges a literal "a.b" beside a redacted "a"', async () => {
    const body = JSON.stringify({ 'a.b': 1, a: REDACTED_VALUE });
    const r = await response(body, { 'a.b': 1 });
    expect(r.pass).toBe(true);
    expect(r.inconclusive).toBeUndefined();
  });
});
