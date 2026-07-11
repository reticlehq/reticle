import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RETICLE_PROTOCOL_VERSION, MessageKind, type HelloMessage } from '@reticlehq/core';
import { Transport } from './transport.js';

/** Controllable WebSocket double — captures every instance so the test can count reconnects. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
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

let becomeVisible: () => void = () => undefined;
let unsubscribed = 0;

function makeTransport(): Transport {
  return new Transport({
    url: 'ws://x',
    hello,
    handleCommand: () => Promise.resolve({ ok: true }),
    // Inject the visibility source so the test drives "tab returned to foreground" directly.
    onVisible: (handler) => {
      becomeVisible = handler;
      return () => {
        unsubscribed += 1;
      };
    },
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  becomeVisible = () => undefined;
  unsubscribed = 0;
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('transport reconnect-on-focus', () => {
  it('reconnects immediately on foreground, WITHOUT waiting for the throttled timer', () => {
    const t = makeTransport();
    t.connect();
    FakeWebSocket.instances.at(-1)?.open(); // connected
    FakeWebSocket.instances.at(-1)?.close(); // bridge blip while (soon) hidden
    expect(FakeWebSocket.instances).toHaveLength(1); // timer NOT advanced → no retry yet

    becomeVisible(); // tab returns to foreground
    expect(FakeWebSocket.instances).toHaveLength(2); // reconnected right away, no timer wait
  });

  it('does not open a duplicate when already connected', () => {
    const t = makeTransport();
    t.connect();
    FakeWebSocket.instances.at(-1)?.open();
    becomeVisible(); // focus while healthy
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not open a duplicate when the throttled timer fires after a focus reconnect', () => {
    const t = makeTransport();
    t.connect();
    FakeWebSocket.instances.at(-1)?.close(); // down
    becomeVisible(); // focus reconnect beats the timer
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1000); // the throttled reconnect timer now fires
    expect(FakeWebSocket.instances).toHaveLength(2); // guarded — still just the one new socket
  });

  it('stops reconnecting on foreground once closed (unsubscribes)', () => {
    const t = makeTransport();
    t.connect();
    FakeWebSocket.instances.at(-1)?.open();
    t.close();
    expect(unsubscribed).toBe(1);
    becomeVisible(); // a late visibility event after teardown
    expect(FakeWebSocket.instances).toHaveLength(1); // no revival
  });
});
