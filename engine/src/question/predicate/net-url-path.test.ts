/**
 * A `net` check can name one endpoint exactly (#2286).
 *
 * `urlContains` is a substring test. A page calls `/api/items` and the app shell calls
 * `/api/items/count`, so a check for the first also matched the second. `count: 1` then failed on
 * correct code, and the agent had to read `observe` by hand. `urlPath` compares the path of the
 * request, so one endpoint can be counted apart from a longer one that starts the same way.
 */
import { describe, expect, it } from 'vitest';
import { EventType, URL_RAW, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

function call(url: string, extra: Record<string, unknown> = {}): ReticleEvent {
  return {
    type: EventType.NET_REQUEST,
    t: 10,
    data: { method: 'GET', url, status: 200, ok: true, ...extra },
  } as unknown as ReticleEvent;
}

class WindowSession implements PredicateSession {
  constructor(private readonly events: readonly ReticleEvent[]) {}
  command(): Promise<never> {
    return Promise.reject(new Error('no element commands in these tests'));
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

const ITEMS_AND_COUNT = [
  call('http://localhost:5173/api/items'),
  call('http://localhost:5173/api/items/count'),
];

describe('net urlPath', () => {
  it('counts only the call whose path is exactly the one named', async () => {
    const r = await evaluatePredicate(new WindowSession(ITEMS_AND_COUNT), {
      kind: 'net',
      urlPath: '/api/items',
      count: 1,
    });
    expect(r.pass).toBe(true);
  });

  it('is needed: urlContains counts the longer path too', async () => {
    const r = await evaluatePredicate(new WindowSession(ITEMS_AND_COUNT), {
      kind: 'net',
      urlContains: '/api/items',
      count: 1,
    });
    expect(r.pass).toBe(false);
  });

  it('ignores the query string and the fragment', async () => {
    const r = await evaluatePredicate(
      new WindowSession([call('http://localhost:5173/api/items?page=2#top')]),
      { kind: 'net', urlPath: '/api/items', count: 1 },
    );
    expect(r.pass).toBe(true);
  });

  it('reads a relative request URL', async () => {
    const r = await evaluatePredicate(new WindowSession([call('/api/items?page=2')]), {
      kind: 'net',
      urlPath: '/api/items',
    });
    expect(r.pass).toBe(true);
  });

  it('treats a trailing slash as a different path', async () => {
    const r = await evaluatePredicate(
      new WindowSession([call('http://localhost:5173/api/items/')]),
      { kind: 'net', urlPath: '/api/items' },
    );
    expect(r.pass).toBe(false);
  });

  it('matches the encoded and the plain spelling of the same path', async () => {
    const r = await evaluatePredicate(
      new WindowSession([call('http://localhost:5173/api/by%20name')]),
      { kind: 'net', urlPath: '/api/by name' },
    );
    expect(r.pass).toBe(true);
  });

  it('matches the raw path when redaction changed the displayed URL', async () => {
    const r = await evaluatePredicate(
      new WindowSession([
        call('http://localhost:5173/auth/token/[REDACTED]', {
          [URL_RAW]: 'http://localhost:5173/auth/token/refresh',
        }),
      ]),
      { kind: 'net', urlPath: '/auth/token/refresh' },
    );
    expect(r.pass).toBe(true);
  });

  it('works with method and status like the other filters', async () => {
    const session = new WindowSession([
      call('http://localhost:5173/api/items', { method: 'POST', status: 201 }),
      call('http://localhost:5173/api/items/count'),
    ]);
    expect(
      (await evaluatePredicate(session, { kind: 'net', method: 'POST', urlPath: '/api/items' }))
        .pass,
    ).toBe(true);
    expect(
      (await evaluatePredicate(session, { kind: 'net', method: 'GET', urlPath: '/api/items' }))
        .pass,
    ).toBe(false);
  });
});
