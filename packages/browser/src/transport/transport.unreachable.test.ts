import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RETICLE_PROTOCOL_VERSION, MessageKind, type HelloMessage } from '@reticlehq/protocol';
import { Transport } from './transport.js';

/**
 * The "unreachable" first-connect warning: when the very first connection never opens (wrong port,
 * container network boundary), the transport fires onUnreachable ONCE — instead of retrying silently
 * forever. A live connection that later drops must NEVER trip it.
 */
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

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});
afterEach(() => {
  vi.useRealTimers();
});

function failNTimes(n: number): void {
  for (let i = 0; i < n; i += 1) {
    FakeWebSocket.instances.at(-1)?.close();
    vi.advanceTimersByTime(1000);
  }
}

describe('transport unreachable (first-connect) warning', () => {
  it('fires onUnreachable once after repeated initial failures, with the url + attempts', () => {
    const calls: { url: string; attempts: number }[] = [];
    const t = new Transport({
      url: 'ws://localhost:4400/reticle',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      onUnreachable: (d) => calls.push(d),
    });
    t.connect();

    failNTimes(10);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('ws://localhost:4400/reticle');
    expect(calls[0]?.attempts).toBeGreaterThanOrEqual(3);
  });

  it('does NOT fire if the connection opens before the threshold', () => {
    const calls: unknown[] = [];
    const t = new Transport({
      url: 'ws://x',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      onUnreachable: (d) => calls.push(d),
    });
    t.connect();

    FakeWebSocket.instances.at(-1)?.close(); // 1 blip
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances.at(-1)?.open(); // connected before the 3rd failure

    expect(calls).toHaveLength(0);
  });

  it('does NOT fire for a session that connected then later dropped (that is onConnectionLost)', () => {
    const calls: unknown[] = [];
    const t = new Transport({
      url: 'ws://x',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      onUnreachable: (d) => calls.push(d),
    });
    t.connect();

    FakeWebSocket.instances.at(-1)?.open(); // a real connection happened
    failNTimes(10); // now the bridge goes away for a long time

    expect(calls).toHaveLength(0); // never an "unreachable" — it WAS reachable
  });
});
