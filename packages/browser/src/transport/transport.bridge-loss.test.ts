import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RETICLE_PROTOCOL_VERSION, MessageKind, type HelloMessage } from '@reticlehq/protocol';
import { Transport } from './transport.js';

/**
 * A controllable WebSocket double. Construction is captured so the test can drive open/close and
 * assert reconnect behavior. Time is driven by an injected clock on the Transport.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
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

beforeEach(() => {
  FakeWebSocket.instances = [];
  now = 0;
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
      onConnectionLost: () => {
        lost += 1;
      },
    });
    t.connect();

    // First socket never opens; it closes → schedules reconnect. Drive several failed reconnects
    // while advancing the injected clock past the loss threshold.
    for (let i = 0; i < 20; i += 1) {
      FakeWebSocket.instances.at(-1)?.close();
      now += 1000;
      vi.advanceTimersByTime(1000);
    }

    expect(lost).toBeGreaterThanOrEqual(1);
  });

  it('does NOT fire onConnectionLost when reconnection succeeds quickly', () => {
    let lost = 0;
    const t = new Transport({
      url: 'ws://x',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      now: () => now,
      onConnectionLost: () => {
        lost += 1;
      },
    });
    t.connect();

    FakeWebSocket.instances.at(-1)?.close(); // brief blip
    now += 1000;
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances.at(-1)?.open(); // reconnected well within the window

    expect(lost).toBe(0);
  });

  it('fires onConnectionLost only once per outage', () => {
    let lost = 0;
    const t = new Transport({
      url: 'ws://x',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      now: () => now,
      onConnectionLost: () => {
        lost += 1;
      },
    });
    t.connect();

    for (let i = 0; i < 40; i += 1) {
      FakeWebSocket.instances.at(-1)?.close();
      now += 1000;
      vi.advanceTimersByTime(1000);
    }

    expect(lost).toBe(1);
  });
});
