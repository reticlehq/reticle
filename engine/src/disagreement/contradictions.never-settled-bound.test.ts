import { describe, expect, it } from 'vitest';
import {
  ContradictionKind,
  ContradictionSchema,
  EventType,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import { DETAIL_LIST_LIMIT } from '../bounded-list.js';

/**
 * #2496: on a page with a map, one `request-never-settled` finding listed every pending tile
 * request in its detail. The compact result got so long that the client cut it, and the verdict
 * was hard to find. The detail now names a few calls, and the finding states what it left out.
 */
const APP = 'https://app.example.com';
const TILES = 'https://tile.openstreetmap.org';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data };
}

const pending = (url: string): ReticleEvent =>
  ev(EventType.NET_PENDING, { id: `p${String(seq)}`, method: 'GET', url });

const neverSettled = (events: ReticleEvent[], appOrigin?: string) =>
  findContradictions(events, { actionSince: 0, appOrigin }).find(
    (c) => c.kind === ContradictionKind.REQUEST_NEVER_SETTLED,
  );

const tiles = (count: number): ReticleEvent[] =>
  Array.from({ length: count }, (_, i) =>
    pending(`${APP}/tiles/12/${String(2000 + i)}/${String(1300 + i)}.png`),
  );

describe('request-never-settled keeps its detail bounded (#2496)', () => {
  it('names a few calls and counts the rest when hundreds are pending', () => {
    const found = neverSettled([
      ...tiles(300),
      ev(EventType.ROUTE_CHANGE, { from: '/', to: '/map' }),
    ]);
    expect(found?.counter).toBe('300 request(s) were still in flight');
    expect(found?.truncated).toBe(true);
    expect(found?.omitted).toBe(299);
    // One group: every tile shares an origin and a path prefix.
    expect(found?.detail).toContain(`GET ${APP}/tiles/12/2000/1300.png`);
    expect(found?.detail).toContain(`and 299 more under GET ${APP}/tiles/`);
    expect(found?.detail).not.toContain('2001/1301.png');
    expect(found?.detail.length).toBeLessThan(400);
  });

  it('lists at most the limit of groups, and counts the calls in the groups it leaves out', () => {
    const many = Array.from({ length: DETAIL_LIST_LIMIT + 3 }, (_, i) =>
      pending(`${APP}/api${String(i)}/item`),
    );
    const found = neverSettled([...many, ev(EventType.ROUTE_CHANGE, { to: '/next' })]);
    expect(found?.omitted).toBe(3);
    expect(found?.truncated).toBe(true);
    expect(found?.detail).toContain(`${APP}/api0/item`);
    expect(found?.detail).not.toContain(`${APP}/api${String(DETAIL_LIST_LIMIT)}/item`);
    expect(found?.detail).toContain('and 3 more');
  });

  it('bounds the list of ignored third-party calls too', () => {
    const foreign = Array.from({ length: 200 }, (_, i) =>
      pending(`${TILES}/12/${String(i)}/7.png`),
    );
    const found = neverSettled(
      [...foreign, pending(`${APP}/api/slow`), ev(EventType.ROUTE_CHANGE, { to: '/map' })],
      APP,
    );
    expect(found?.detail).toContain(`GET ${APP}/api/slow`);
    expect(found?.detail).toContain(`and 199 more under ${TILES}/12/`);
    expect(found?.omitted).toBe(199);
    expect(found?.truncated).toBe(true);
    expect(found?.detail.length).toBeLessThan(400);
  });

  it('keeps omitted and truncated through the wire schema of a tool result', () => {
    const found = neverSettled([...tiles(20), ev(EventType.ROUTE_CHANGE, { to: '/map' })]);
    const wire = ContradictionSchema.parse(found);
    expect(wire.omitted).toBe(19);
    expect(wire.truncated).toBe(true);
  });

  it('names the open write even when more than five groups of reads started before it', () => {
    const reads = ['tiles', 'fonts', 'img', 'static', 'assets', 'media'].flatMap((dir) => [
      pending(`${APP}/${dir}/1/x.png`),
      pending(`${APP}/${dir}/2/y.png`),
    ]);
    const write = ev(EventType.NET_PENDING, {
      id: `p${String(seq)}`,
      method: 'POST',
      url: `${APP}/api/save`,
    });
    const found = neverSettled([...reads, write, ev(EventType.ROUTE_CHANGE, { to: '/next' })]);
    expect(found?.detail.startsWith(`POST ${APP}/api/save`)).toBe(true);
    expect(found?.omitted).toBe(8);
    expect(found?.truncated).toBe(true);
  });

  it('clips one very long URL and says the detail is cut', () => {
    const found = neverSettled([
      pending(`${APP}/a?q=${'z'.repeat(20_000)}`),
      ev(EventType.ROUTE_CHANGE, { to: '/next' }),
    ]);
    expect(found?.detail.length).toBeLessThan(400);
    expect(found?.truncated).toBe(true);
    expect(found).not.toHaveProperty('omitted');
  });

  it('keeps a short list whole and says nothing was left out', () => {
    const found = neverSettled([
      pending(`${APP}/api/a`),
      pending(`${APP}/api/b`),
      ev(EventType.ROUTE_CHANGE, { to: '/next' }),
    ]);
    expect(found?.detail).toBe(`GET ${APP}/api/a; GET ${APP}/api/b`);
    expect(found).not.toHaveProperty('omitted');
    expect(found).not.toHaveProperty('truncated');
  });
});
