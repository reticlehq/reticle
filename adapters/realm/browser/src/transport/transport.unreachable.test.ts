import { describe, it, expect, beforeEach } from 'vitest';
import { RETICLE_PROTOCOL_VERSION, MessageKind, type HelloMessage } from '@reticlehq/core';
import { Transport } from './transport.js';
import { at } from '../test-support/array-at.js';

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
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  /**
   * Idempotent, like the real thing: a WebSocket fires `onclose` ONCE.
   *
   * It did not, and that is what hid the vacuity. `failNTimes` re-closed the same socket ten times
   * and collected ten failures without a single retry running, so the spec passed against a
   * reconnect loop that had been deleted outright.
   */
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

/**
 * Retries are RUN, not waited for.
 *
 * This spec used to call `vi.useFakeTimers()` and `advanceTimersByTime(1000)`, which drove nothing:
 * the transport schedules through `nativeSetTimeout`, bound to the real timer at module load so a
 * frozen `reticle_clock` cannot deadlock the SDK. So the clock never advanced anything, no retry
 * ever ran, and `failNTimes` was re-closing the SAME socket — a sequence a real WebSocket cannot
 * produce, since `onclose` fires once.
 *
 * Proven vacuous by mutation: disabling reconnect entirely (`#scheduleReopen` returning immediately)
 * left all three tests GREEN. They asserted the failure COUNTER, never the retry loop it counts.
 *
 * The injected `schedule` seam records each pending retry so it can be run deliberately, which also
 * makes each failure a genuinely new socket.
 */
const pending: (() => void)[] = [];
beforeEach(() => {
  pending.length = 0;
});

function failNTimes(n: number): void {
  for (let i = 0; i < n; i += 1) {
    at(FakeWebSocket.instances, -1)?.close();
    // Run the retry the transport scheduled. Without this the next iteration re-closes a socket
    // that is already closed, which is what made this spec pass against a broken retry loop.
    pending.shift()?.();
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
      schedule: (fn) => void pending.push(fn),
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
      schedule: (fn) => void pending.push(fn),
    });
    t.connect();

    at(FakeWebSocket.instances, -1)?.close(); // 1 blip
    pending.shift()?.(); // the retry runs and opens a NEW socket
    at(FakeWebSocket.instances, -1)?.open(); // connected before the 3rd failure

    expect(calls).toHaveLength(0);
  });

  it('does NOT fire for a session that connected then later dropped (that is onConnectionLost)', () => {
    const calls: unknown[] = [];
    const t = new Transport({
      url: 'ws://x',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      onUnreachable: (d) => calls.push(d),
      schedule: (fn) => void pending.push(fn),
    });
    t.connect();

    at(FakeWebSocket.instances, -1)?.open(); // a real connection happened
    failNTimes(10); // now the bridge goes away for a long time

    expect(calls).toHaveLength(0); // never an "unreachable" — it WAS reachable
  });
});
