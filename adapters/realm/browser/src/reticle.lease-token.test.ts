/**
 * A lease on a page that ships its own SDK with an old pairing token never connected. The page's
 * SDK dialled first with the token its build baked in, and the bridge refused it. The lease then
 * called `connect()` with the daemon's token, and that call did nothing, because the SDK had
 * already started. Only a call the lease marks may replace the token.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageKind } from '@reticlehq/core';
import { Reticle } from './reticle.js';

/** The close code the bridge sends for a terminal refusal, such as a wrong token. */
const POLICY_VIOLATION = 1008;

class RecordingSocket {
  static readonly OPEN = 1;
  static last: RecordingSocket | undefined;
  readonly sent: Array<Record<string, unknown>> = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    RecordingSocket.last = this;
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = RecordingSocket.OPEN;
    this.onopen?.();
  }
  hellos(): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m['kind'] === MessageKind.HELLO);
  }
}

function lastSocket(): RecordingSocket {
  const socket = RecordingSocket.last;
  if (socket === undefined) {
    throw new Error('connect() opened no socket');
  }
  return socket;
}

describe('a lease on a page whose own SDK has a stale token', () => {
  const sdk = new Reticle();
  afterEach(() => {
    sdk.disconnect();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function refusedPage(): RecordingSocket {
    vi.stubGlobal('WebSocket', RecordingSocket);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sdk.connect({ token: 'stale' });
    const first = lastSocket();
    first.open();
    first.onclose?.({ code: POLICY_VIOLATION, reason: 'wrong pairing token' });
    return first;
  }

  it('dials again with the lease token after the bridge refused the old one', () => {
    const first = refusedPage();

    sdk.connect({ token: 'current', lease: true });

    const second = lastSocket();
    expect(second).not.toBe(first);
    second.open();
    expect(second.hellos().at(-1)?.['token']).toBe('current');
  });

  it('uses the lease token when the refusal arrives after the lease call', () => {
    vi.stubGlobal('WebSocket', RecordingSocket);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sdk.connect({ token: 'stale' });
    const first = lastSocket();
    first.open();

    sdk.connect({ token: 'current', lease: true });
    first.onclose?.({ code: POLICY_VIOLATION, reason: 'wrong pairing token' });

    const second = lastSocket();
    expect(second).not.toBe(first);
    second.open();
    expect(second.hellos().at(-1)?.['token']).toBe('current');
  });

  it('does not let a call the lease did not mark replace the token', () => {
    const first = refusedPage();

    sdk.connect({ token: 'other' });

    expect(lastSocket()).toBe(first);
  });
});
