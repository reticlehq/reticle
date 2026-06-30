import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/protocol';
import {
  consoleEmptyHint,
  netEmptyHint,
  reconcileNet,
  projectNetCall,
  projectConsoleLog,
} from './event-filters.js';

function ev(type: EventType, data: Record<string, unknown>, t = 1): ReticleEvent {
  return { t, type, sessionId: 's', data };
}

describe('reconcileNet (in-flight / hung requests)', () => {
  it('keeps a completed request and drops its matching pending (no double-count)', () => {
    const events = [
      ev(EventType.NET_PENDING, { id: 'n1', method: 'GET', url: '/api/x' }, 1),
      ev(EventType.NET_REQUEST, { id: 'n1', method: 'GET', url: '/api/x', status: 200 }, 2),
    ];
    const out = reconcileNet(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe(EventType.NET_REQUEST);
    expect(out[0]?.data['status']).toBe(200);
  });

  it('surfaces a pending with no completion as an in-flight call annotated pending', () => {
    const events = [
      ev(EventType.NET_REQUEST, { id: 'n1', method: 'POST', url: '/api/login', status: 200 }, 1),
      ev(EventType.NET_PENDING, { id: 'n2', method: 'GET', url: '/api/broken/timeout' }, 2),
    ];
    const out = reconcileNet(events);
    expect(out).toHaveLength(2);
    const hung = out.find((e) => e.data['url'] === '/api/broken/timeout');
    expect(hung?.data).toMatchObject({ status: 'pending', pending: true });
  });

  it('orders the reconciled calls by time', () => {
    const events = [
      ev(EventType.NET_PENDING, { id: 'n2', url: '/late' }, 5),
      ev(EventType.NET_REQUEST, { id: 'n1', url: '/early', status: 200 }, 1),
    ];
    const out = reconcileNet(events);
    expect(out.map((e) => e.data['url'])).toEqual(['/early', '/late']);
  });
});

describe('compact projections (token leanness)', () => {
  it('projectNetCall keeps only method/url/status/ms and drops event plumbing', () => {
    const e = ev(EventType.NET_REQUEST, {
      id: 'n1',
      method: 'POST',
      url: '/api/x',
      status: 500,
      ok: false,
      durationMs: 42,
      initiator: 'fetch',
    });
    expect(projectNetCall(e)).toEqual({ method: 'POST', url: '/api/x', status: 500, ms: 42 });
  });

  it('projectNetCall passes through a pending (no-status) request', () => {
    const e = ev(EventType.NET_PENDING, {
      method: 'GET',
      url: '/api/hang',
      status: 'pending',
      pending: true,
    });
    expect(projectNetCall(e)).toEqual({ method: 'GET', url: '/api/hang', status: 'pending' });
  });

  it('projectConsoleLog maps type to level and extracts the message', () => {
    expect(projectConsoleLog(ev(EventType.CONSOLE_ERROR, { message: 'boom' }))).toEqual({
      level: 'error',
      text: 'boom',
    });
    expect(projectConsoleLog(ev(EventType.ERROR_UNCAUGHT, { message: 'uncaught x' }))).toEqual({
      level: 'error',
      text: 'uncaught x',
    });
  });
});

describe('near-miss hint builders', () => {
  it('netEmptyHint: reports total + a most-recent-first sample of present calls', () => {
    const allNet = [
      ev(EventType.NET_REQUEST, { method: 'GET', url: '/a', status: 200 }),
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/b', status: 500 }),
    ];
    const hint = netEmptyHint(allNet);
    expect(hint.totalInWindow).toBe(2);
    expect(hint.present[0]).toEqual({ method: 'POST', url: '/b', status: 500 });
    expect(hint.present[1]).toEqual({ method: 'GET', url: '/a', status: 200 });
  });

  it('netEmptyHint: caps the sample at 5 (keeps the most recent)', () => {
    const allNet = Array.from({ length: 8 }, (_, i) =>
      ev(EventType.NET_REQUEST, { method: 'GET', url: `/u${i}`, status: 200 }),
    );
    const hint = netEmptyHint(allNet);
    expect(hint.totalInWindow).toBe(8);
    expect(hint.present).toHaveLength(5);
    expect(hint.present[0]?.url).toBe('/u7'); // most recent first
  });

  it('netEmptyHint: omits status when the call has none (no undefined leak)', () => {
    const hint = netEmptyHint([ev(EventType.NET_REQUEST, { method: 'GET', url: '/pending' })]);
    expect(hint.present[0]).toEqual({ method: 'GET', url: '/pending' });
    expect('status' in (hint.present[0] ?? {})).toBe(false);
  });

  it('consoleEmptyHint: counts events by level (uncaught counts as error)', () => {
    const all = [
      ev(EventType.CONSOLE_LOG, { message: 'a' }),
      ev(EventType.CONSOLE_LOG, { message: 'b' }),
      ev(EventType.CONSOLE_WARN, { message: 'w' }),
      ev(EventType.CONSOLE_ERROR, { message: 'e' }),
      ev(EventType.ERROR_UNCAUGHT, { message: 'boom' }),
    ];
    const hint = consoleEmptyHint(all);
    expect(hint.totalInWindow).toBe(5);
    expect(hint.byLevel).toEqual({ log: 2, warn: 1, error: 2 });
  });
});
