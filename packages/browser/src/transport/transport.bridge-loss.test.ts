import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RETICLE_PROTOCOL_VERSION,
  EventType,
  MessageKind,
  type HelloMessage,
} from '@reticlehq/core';
import { Transport } from './transport.js';
import { at } from '../test-support/array-at.js';

/**
 * A controllable WebSocket double. Construction is captured so the test can drive open/close and
 * assert reconnect behavior. Time is driven by an injected clock on the Transport.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(text: string): void {
    this.sent.push(text);
  }
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

let now = 0;
/**
 * Retries the transport scheduled, run deliberately.
 *
 * `vi.advanceTimersByTime` drives nothing here: the transport schedules on `nativeSetTimeout`, bound
 * to the real timer at module load so a frozen `reticle_clock` cannot deadlock the SDK. Without
 * running these, the loops below re-closed one DEAD socket and only looked like repeated
 * reconnects — the first test's own comment says "drive several failed reconnects", which is
 * exactly what it believed and exactly what was not happening.
 */
const pending: (() => void)[] = [];

beforeEach(() => {
  FakeWebSocket.instances = [];
  now = 0;
  pending.length = 0;
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('transport bridge-loss self-end', () => {
  it('fires onConnectionLost after a continuous outage past BRIDGE_LOST_MS', () => {
    let lost = 0;
    const t = new Transport({
      url: 'ws://x',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      now: () => now,
      schedule: (fn) => void pending.push(fn),
      onConnectionLost: () => {
        lost += 1;
      },
    });
    t.connect();

    // First socket never opens; it closes → schedules reconnect. Drive several failed reconnects
    // while advancing the injected clock past the loss threshold.
    for (let i = 0; i < 20; i += 1) {
      at(FakeWebSocket.instances, -1)?.close();
      now += 1000;
      pending.shift()?.(); // the retry runs and opens a NEW socket to fail next round
    }

    expect(lost).toBeGreaterThanOrEqual(1);
  });

  it('offline queue drops the OLDEST on overflow, keeping the newest (ring)', () => {
    const t = new Transport({
      url: 'ws://x',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      now: () => now,
      schedule: (fn) => void pending.push(fn),
    });
    t.connect();
    const ws = at(FakeWebSocket.instances, -1);
    // Socket not open yet → events queue. Send MAX_QUEUE (500) + 3 so 3 must be dropped.
    for (let i = 0; i < 503; i += 1) {
      t.sendEvent({ t: i, type: EventType.DOM_ADDED, sessionId: 's', data: { seq: i } });
    }
    ws?.open(); // flush the queued messages
    const events = (ws?.sent ?? []).filter((m) => m.includes('"seq":'));
    expect(events).toHaveLength(500);
    expect(events[0]).toContain('"seq":3}'); // 0,1,2 dropped (oldest)
    expect(at(events, -1)).toContain('"seq":502}'); // newest kept
  });

  it('does NOT fire onConnectionLost when reconnection succeeds quickly', () => {
    let lost = 0;
    const t = new Transport({
      url: 'ws://x',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      now: () => now,
      schedule: (fn) => void pending.push(fn),
      onConnectionLost: () => {
        lost += 1;
      },
    });
    t.connect();

    at(FakeWebSocket.instances, -1)?.close(); // brief blip
    now += 1000;
    pending.shift()?.();
    at(FakeWebSocket.instances, -1)?.open(); // reconnected well within the window

    expect(lost).toBe(0);
  });

  it('fires onConnectionLost only once per outage', () => {
    let lost = 0;
    const t = new Transport({
      url: 'ws://x',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      now: () => now,
      schedule: (fn) => void pending.push(fn),
      onConnectionLost: () => {
        lost += 1;
      },
    });
    t.connect();

    for (let i = 0; i < 40; i += 1) {
      at(FakeWebSocket.instances, -1)?.close();
      now += 1000;
      pending.shift()?.(); // the retry runs and opens a NEW socket to fail next round
    }

    expect(lost).toBe(1);
  });
});
