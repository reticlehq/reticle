import { describe, expect, it } from 'vitest';
import { EventType, type IrisEvent } from '@syrin/iris-protocol';
import { consoleEmptyHint, netEmptyHint } from './event-filters.js';

function ev(type: EventType, data: Record<string, unknown>, t = 1): IrisEvent {
  return { t, type, sessionId: 's', data };
}

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
