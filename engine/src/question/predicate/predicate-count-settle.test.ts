import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElementState, EventType, type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { waitForPredicate, type PredicateSession } from './predicate.js';

describe('exact count with settled', () => {
  afterEach(() => vi.useRealTimers());

  it('continues waiting when confirmation finds transient network activity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const events: ReticleEvent[] = [
      {
        t: 500,
        type: EventType.NET_REQUEST,
        sessionId: 's',
        data: { method: 'GET', url: '/target' },
      },
    ];
    const session: PredicateSession = {
      elapsed: () => Date.now(),
      eventsSince: (since = 0) => events.filter((event) => event.t >= since),
      command: (): Promise<CommandResult> =>
        Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} }),
      onEvent: () => () => undefined,
    };
    let resolved = false;
    const verdict = waitForPredicate(
      session,
      {
        kind: 'allOf',
        predicates: [
          { kind: 'net', method: 'GET', urlContains: '/target', count: 1 },
          { kind: 'settled', channel: 'network' },
        ],
      },
      2000,
    ).then((result) => {
      resolved = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(100);
    events.push({
      t: 1100,
      type: EventType.NET_PENDING,
      sessionId: 's',
      data: { id: 'other', url: '/other' },
    });
    await vi.advanceTimersByTimeAsync(100);
    events.push({
      t: 1200,
      type: EventType.NET_REQUEST,
      sessionId: 's',
      data: { id: 'other', method: 'GET', url: '/other' },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await verdict).pass).toBe(true);
  });

  it('ends an absence when its first quiet confirmation finds the element', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let present = false;
    const session: PredicateSession = {
      elapsed: () => Date.now(),
      eventsSince: () => [],
      command: () =>
        Promise.resolve({
          kind: 'command_result',
          id: 'x',
          ok: true,
          result: { matched: present, count: present ? 1 : 0, elements: [] },
        }),
      onEvent: () => () => undefined,
    };
    let result: Awaited<ReturnType<typeof waitForPredicate>> | undefined;
    const verdict = waitForPredicate(
      session,
      { kind: 'element', query: { text: 'warning' }, absent: true },
      2000,
    ).then((r) => {
      result = r;
      return r;
    });
    await vi.advanceTimersByTimeAsync(900);
    present = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(result?.pass).toBe(false);
    present = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect((await verdict).pass).toBe(false);
  });

  it('ends an exact-count confirmation that cannot read another clause', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let sdkVersion = '3.4.0';
    const session: PredicateSession = {
      get sdkVersion() {
        return sdkVersion;
      },
      elapsed: () => Date.now(),
      eventsSince: () => [
        {
          t: 500,
          type: EventType.NET_REQUEST,
          sessionId: 's',
          data: { method: 'GET', url: '/target' },
        },
      ],
      command: () =>
        Promise.resolve({
          kind: 'command_result',
          id: 'x',
          ok: true,
          result: { matched: true, count: 1, elements: [] },
        }),
      onEvent: () => () => undefined,
    };
    let result: Awaited<ReturnType<typeof waitForPredicate>> | undefined;
    const verdict = waitForPredicate(
      session,
      {
        kind: 'allOf',
        predicates: [
          { kind: 'net', method: 'GET', urlContains: '/target', count: 1 },
          { kind: 'element', query: { text: 'ready' }, state: ElementState.PRESSED },
        ],
      },
      2000,
    ).then((r) => {
      result = r;
      return r;
    });
    await vi.advanceTimersByTimeAsync(250);
    sdkVersion = '3.3.0';
    await vi.advanceTimersByTimeAsync(50);
    expect(result?.inconclusive).toContain('3.3.0');
    expect((await verdict).pass).toBe(false);
  });
});
