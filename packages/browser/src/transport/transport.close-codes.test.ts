import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RETICLE_PROTOCOL_VERSION, MessageKind, type HelloMessage } from '@reticlehq/core';
import * as nativeConsole from '../timers/native-console.js';
import { Transport } from './transport.js';

/**
 * Two ways a connection can fail HARD rather than transiently:
 *  - `new WebSocket()` throws synchronously (mixed-content SecurityError: ws:// from an https page).
 *    That must not escape connect() into the host app, and must not stop the retry loop.
 *  - the bridge closes with 1008 (policy violation: protocol mismatch, auth). Retrying can't fix it,
 *    so the transport must STOP — not reconnect every second forever — and say why.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static throwOnConstruct = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(public url: string) {
    if (FakeWebSocket.throwOnConstruct) throw new DOMException('insecure', 'SecurityError');
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  closeWith(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
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
  FakeWebSocket.throwOnConstruct = false;
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('transport handles a synchronous WebSocket constructor throw', () => {
  it('does not let the SecurityError escape connect(), and can still reconnect later', () => {
    let becomeVisible: () => void = () => undefined;
    FakeWebSocket.throwOnConstruct = true;
    const t = new Transport({
      url: 'ws://localhost:4400/reticle',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      // The reconnect timer runs on the pre-bound native clock (fake timers don't drive it), so
      // drive the retry deterministically via the foreground path instead.
      onVisible: (handler) => {
        becomeVisible = handler;
        return () => undefined;
      },
    });

    // The cardinal invariant: the SDK never throws into the app it observes.
    expect(() => t.connect()).not.toThrow();
    expect(FakeWebSocket.instances).toHaveLength(0); // the throw was swallowed, not a live socket

    // The transport is not wedged: a later open that succeeds still connects.
    FakeWebSocket.throwOnConstruct = false;
    expect(() => becomeVisible()).not.toThrow();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('transport stops retrying on a 1008 policy-violation close', () => {
  it('does not reconnect after 1008, fires onConnectionLost, and warns with the reason', () => {
    const warn = vi.spyOn(nativeConsole, 'nativeWarn').mockImplementation(() => undefined);
    let lost = 0;
    const t = new Transport({
      url: 'ws://x',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      onConnectionLost: () => {
        lost += 1;
      },
    });
    t.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0]?.closeWith(
      1008,
      'protocol version mismatch — upgrade @reticlehq/browser',
    );

    // No new socket even after many retry windows.
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(lost).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('protocol version mismatch');
  });

  it('still reconnects on an ordinary (non-1008) close', () => {
    let becomeVisible: () => void = () => undefined;
    const t = new Transport({
      url: 'ws://x',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
      onVisible: (handler) => {
        becomeVisible = handler;
        return () => undefined;
      },
    });
    t.connect();
    FakeWebSocket.instances[0]?.closeWith(1006, 'abnormal'); // NOT closed — retryable
    becomeVisible(); // foreground reopen still allowed (only 1008 sets #closed)
    expect(FakeWebSocket.instances.length).toBe(2);
  });
});
