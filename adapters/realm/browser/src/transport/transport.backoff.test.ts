import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RETICLE_PROTOCOL_VERSION, MessageKind, type HelloMessage } from '@reticlehq/core';
import { Transport, nextReconnectDelay, RECONNECT_MAX_DELAY_MS } from './transport.js';
import { at } from '../test-support/array-at.js';

/**
 * Reconnect backs off instead of retrying every second forever.
 *
 * Every close path scheduled a reopen at a flat 1000ms with no growth and no cap, so a tab left open
 * against a stopped daemon made ~600 failed WebSocket opens in ten minutes — CPU, and a devtools
 * console full of ERR_CONNECTION_REFUSED.
 *
 * The delays are asserted through an INJECTED scheduler rather than a fake clock. The real one is
 * `nativeSetTimeout`, bound to the true timer at module load on purpose so a frozen `reticle_clock`
 * cannot deadlock the SDK — which also means `vi.useFakeTimers()` cannot see it. (The existing
 * unreachable spec passes without any reconnect occurring at all: it re-closes the same socket.)
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  /** Idempotent, like the real thing: a WebSocket fires `onclose` ONCE. */
  close(): void {
    if (3 === this.readyState) return;
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' });
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

const hello = (): HelloMessage => ({
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId: 's',
  url: 'http://localhost/',
  title: 'T',
  adapters: [],
  hasCapabilities: false,
});

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

/** A transport whose retries are recorded instead of timed, and run only when we say. */
function harness(onVisibleRef?: { fire: () => void }) {
  const delays: number[] = [];
  const pending: (() => void)[] = [];
  const t = new Transport({
    url: 'ws://localhost:4400/reticle',
    hello,
    handleCommand: () => Promise.resolve({ ok: true }),
    schedule: (fn, ms) => {
      delays.push(ms);
      pending.push(fn);
    },
    ...(onVisibleRef === undefined
      ? {}
      : {
          onVisible: (handler: () => void) => {
            onVisibleRef.fire = handler;
            return () => undefined;
          },
        }),
  });
  t.connect();
  /** Drop the live socket, then run the retry it scheduled. */
  const failAndRetry = (): void => {
    at(FakeWebSocket.instances, -1)?.close();
    pending.shift()?.();
  };
  return { t, delays, failAndRetry };
}

describe('nextReconnectDelay', () => {
  it('doubles', () => {
    expect(nextReconnectDelay(1000)).toBe(2000);
    expect(nextReconnectDelay(2000)).toBe(4000);
  });

  it('clamps at the ceiling and stays there', () => {
    expect(nextReconnectDelay(RECONNECT_MAX_DELAY_MS)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(nextReconnectDelay(RECONNECT_MAX_DELAY_MS * 10)).toBe(RECONNECT_MAX_DELAY_MS);
  });
});

describe('reconnect backoff', () => {
  it('retries the FIRST failure promptly — a restarting daemon must not cost 30s', () => {
    const { delays, failAndRetry } = harness();
    failAndRetry();
    expect(delays[0]).toBe(1000);
  });

  it('grows the delay while the outage persists', () => {
    const { delays, failAndRetry } = harness();
    for (let i = 0; i < 4; i += 1) failAndRetry();
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
  });

  it('caps, so an overnight tab keeps retrying without hammering', () => {
    const { delays, failAndRetry } = harness();
    for (let i = 0; i < 20; i += 1) failAndRetry();
    expect(Math.max(...delays)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(at(delays, -1)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it('resets after a successful connection, so one bad night does not slow the next drop', () => {
    const { delays, failAndRetry } = harness();
    for (let i = 0; i < 5; i += 1) failAndRetry();
    at(FakeWebSocket.instances, -1)?.open(); // recovered
    at(FakeWebSocket.instances, -1)?.close(); // and drops again later
    expect(at(delays, -1), 'the drop after a recovery is prompt again').toBe(1000);
  });

  it('resets when the human comes back to the tab — what makes the 30s ceiling safe', () => {
    const visible = { fire: () => undefined };
    const { delays, failAndRetry } = harness(visible);
    for (let i = 0; i < 5; i += 1) failAndRetry();
    expect(at(delays, -1)).toBeGreaterThan(1000);
    visible.fire(); // foregrounded: opens immediately
    at(FakeWebSocket.instances, -1)?.close();
    expect(at(delays, -1), 'foregrounding restarts the ladder').toBe(1000);
  });

  it('never schedules once the transport is closed', () => {
    const { t, delays } = harness();
    t.close();
    const before = delays.length;
    at(FakeWebSocket.instances, -1)?.close();
    expect(delays.length).toBe(before);
  });

  it('does not retry a 1008 policy violation at all — backoff must not resurrect it', () => {
    // The pre-existing terminal-refusal rule. A backoff that kept retrying a version mismatch
    // would be strictly worse than the flat loop it replaced.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { delays } = harness();
    at(FakeWebSocket.instances, -1)?.onclose?.({
      code: 1008,
      reason: 'upgrade @reticlehq/browser',
    });
    expect(delays).toHaveLength(0);
    warn.mockRestore();
  });
});
