import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RETICLE_PROTOCOL_VERSION, MessageKind, type HelloMessage } from '@reticlehq/core';
import { Transport } from './transport.js';

/**
 * A command the page cannot run must never vanish.
 *
 * Both of these paths used to `return` with no reply at all. The agent then waited out its whole
 * timeout and got "command timed out" — which reads as a hung or suspended page and sends the reader
 * to debug the app, the webview, the window, anything but the real cause. Measured while driving a
 * Tauri shell: the session was connected and streaming events the entire time while commands
 * disappeared, and three rounds of debugging went into the wrong places.
 *
 * A timeout is the one failure that carries no information. These two cases DO know why they failed,
 * so throwing that away is the expensive kind of silence.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(text: string): void {
    this.sent.push(text);
  }
}

const hello = (): HelloMessage => ({
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId: 'live-session',
  url: 'http://localhost/',
  title: 'T',
  adapters: [],
  hasCapabilities: false,
});

function connected(): FakeWebSocket {
  const transport = new Transport({
    url: 'ws://localhost:4400/reticle',
    hello,
    handleCommand: () => Promise.resolve({ ok: true, result: { ran: true } }),
  });
  transport.connect();
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (socket === undefined) throw new Error('no socket');
  socket.readyState = 1;
  socket.onopen?.();
  socket.sent = [];
  return socket;
}

const replies = (socket: FakeWebSocket): Record<string, unknown>[] =>
  socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((m) => m['kind'] === MessageKind.COMMAND_RESULT);

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a command the page will not run still gets an answer', () => {
  it('reports a command addressed to a different session instead of dropping it', async () => {
    const socket = connected();
    socket.onmessage?.({
      data: JSON.stringify({
        kind: MessageKind.COMMAND,
        id: 'c1',
        name: 'snapshot',
        args: {},
        sessionId: 'some-other-session',
      }),
    } as MessageEvent);
    await vi.runAllTimersAsync();

    const [reply] = replies(socket);
    expect(reply, 'a mismatched command must be answered, not silently dropped').toBeDefined();
    expect(reply?.['id']).toBe('c1');
    expect(reply?.['ok']).toBe(false);
    // Both ids belong in the message — the mismatch IS the diagnosis.
    expect(String(reply?.['error'])).toContain('some-other-session');
    expect(String(reply?.['error'])).toContain('live-session');
  });

  it('reports an unparseable command as version skew instead of dropping it', async () => {
    const socket = connected();
    socket.onmessage?.({
      data: JSON.stringify({ kind: MessageKind.COMMAND, id: 'c2' /* no name/args */ }),
    } as MessageEvent);
    await vi.runAllTimersAsync();

    const [reply] = replies(socket);
    expect(reply?.['id']).toBe('c2');
    expect(reply?.['ok']).toBe(false);
    expect(String(reply?.['error'])).toMatch(/version/i);
  });

  it('stays silent for a malformed message carrying no id, which cannot be answered', async () => {
    const socket = connected();
    socket.onmessage?.({ data: JSON.stringify({ kind: MessageKind.COMMAND }) } as MessageEvent);
    await vi.runAllTimersAsync();
    expect(replies(socket)).toHaveLength(0);
  });
});
