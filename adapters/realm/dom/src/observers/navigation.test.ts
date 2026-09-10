/**
 * A full document navigation must leave a record in the net channel.
 *
 * Field case, on a Django MPA: a click was verified on route and heading, and the `net` clause
 * naming the destination document MISSED — "after a full page load the SDK reconnects and never sees
 * the document navigation" — so the verdict came back `unknown`. The request had succeeded; the
 * observer that would have seen it did not exist yet, because the old document was torn down with
 * the SDK inside it.
 *
 * The rule this file pins is narrower than "report the navigation": report what the browser
 * MEASURED, and stay silent where it measured nothing. A synthesised `status: 200` would turn a
 * blind spot into a false green, which is a worse defect than the one being fixed.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventType, NetInitiator } from '@reticlehq/core';
import { installNavigation } from './navigation.js';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

/** Stub `performance.getEntriesByType('navigation')` with one entry, or make it throw. */
function withEntry(entry: unknown, throws = false): Captured[] {
  const events: Captured[] = [];
  const spy = vi.spyOn(performance, 'getEntriesByType').mockImplementation(((kind: string) => {
    if (throws) throw new Error('blocked in this context');
    return 'navigation' === kind && entry !== undefined ? [entry] : [];
  }) as typeof performance.getEntriesByType);
  installNavigation((type, data) => events.push({ type, data }));
  spy.mockRestore();
  return events;
}

const NAV = {
  type: 'navigate',
  name: 'http://127.0.0.1:8000/openworker/',
  duration: 412.7,
  transferSize: 14203,
  responseStatus: 200,
};

afterEach(() => vi.restoreAllMocks());

describe('the document request is reported from the browser own record', () => {
  it('emits the navigation as a net request', () => {
    const [event] = withEntry(NAV);
    expect(event?.type).toBe(EventType.NET_REQUEST);
    expect(event?.data).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:8000/openworker/',
      status: 200,
      ok: true,
      initiator: NetInitiator.DOCUMENT,
      navigationType: 'navigate',
      transferSize: 14203,
    });
  });

  it('rounds the duration the browser measured rather than inventing one', () => {
    expect(withEntry(NAV)[0]?.data['durationMs']).toBe(413);
  });

  it('marks a document request as its own initiator, never as a fetch the app made', () => {
    expect(withEntry(NAV)[0]?.data['initiator']).toBe(NetInitiator.DOCUMENT);
    expect(withEntry(NAV)[0]?.data['initiator']).not.toBe('fetch');
  });

  it.each(['reload', 'back_forward'])('reports a %s too — it is still a document fetch', (type) => {
    expect(withEntry({ ...NAV, type })[0]?.data['navigationType']).toBe(type);
  });

  it('says nothing for a prerender, which was not caused by the action being verified', () => {
    expect(withEntry({ ...NAV, type: 'prerender' })).toHaveLength(0);
  });
});

describe('it never claims a status the browser did not report', () => {
  it.each([
    ['absent (browser does not implement responseStatus)', undefined],
    ['zero (opaque or served from cache without revalidation)', 0],
  ])('omits status and ok when responseStatus is %s', (_label, responseStatus) => {
    const [event] = withEntry({ ...NAV, responseStatus });
    expect(event, 'the request still happened and is still worth reporting').toBeDefined();
    expect(event?.data['status'], 'a plausible 200 here would be a false green').toBeUndefined();
    expect(event?.data['ok']).toBeUndefined();
    expect(event?.data['url']).toBe(NAV.name);
  });

  it('reports ok:false for a real error status', () => {
    const [event] = withEntry({ ...NAV, responseStatus: 500 });
    expect(event?.data).toMatchObject({ status: 500, ok: false });
  });
});

describe('it cannot take the page down', () => {
  it.each([
    ['there is no navigation entry', undefined],
    ['the entry carries no url', { type: 'navigate', name: '' }],
    ['the entry carries no type', { name: 'http://x/', duration: 1 }],
  ])('stays silent when %s', (_label, entry) => {
    expect(withEntry(entry)).toHaveLength(0);
  });

  it('stays silent when reading performance entries throws', () => {
    expect(withEntry(NAV, true)).toHaveLength(0);
  });

  it('returns a teardown that is safe to call', () => {
    expect(() => installNavigation(() => undefined)()).not.toThrow();
  });
});
