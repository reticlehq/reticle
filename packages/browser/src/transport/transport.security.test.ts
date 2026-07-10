import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandResultSchema,
  EventType,
  RETICLE_PROTOCOL_VERSION,
  MessageKind,
  TRANSPORT_LIMITS,
  type HelloMessage,
} from '@reticlehq/core';
import { Transport } from './transport.js';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  sent: string[] = [];

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}

const hello = (): HelloMessage => ({
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId: 'session-a',
  url: 'http://localhost/',
  title: 'Test',
  adapters: [],
});

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
});

describe('Transport security', () => {
  it('preserves the SDK-owned pairing token in HELLO', () => {
    const transport = new Transport({
      url: 'ws://localhost/reticle',
      hello: () => ({ ...hello(), token: 'shared-secret' }),
      handleCommand: () => Promise.resolve({ ok: true }),
    });
    transport.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    expect(JSON.parse(socket?.sent[0] ?? '{}')).toMatchObject({ token: 'shared-secret' });
  });

  it('ignores malformed and cross-session commands', async () => {
    let handled = 0;
    const transport = new Transport({
      url: 'ws://localhost/reticle',
      hello,
      handleCommand: () => {
        handled += 1;
        return Promise.resolve({ ok: true });
      },
    });
    transport.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    socket?.receive({ kind: MessageKind.COMMAND, id: '', name: 'snapshot', args: {} });
    socket?.receive({
      kind: MessageKind.COMMAND,
      id: 'c1',
      sessionId: 'session-b',
      name: 'snapshot',
      args: {},
    });
    await Promise.resolve();
    expect(handled).toBe(0);
  });

  it('redacts and serializes arbitrary command results', async () => {
    const value: Record<string, unknown> = { password: 'secret', count: 2n };
    value['self'] = value;
    const transport = new Transport({
      url: 'ws://localhost/reticle',
      hello,
      handleCommand: () => Promise.resolve({ ok: true, result: value }),
    });
    transport.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    socket?.receive({
      kind: MessageKind.COMMAND,
      id: 'c1',
      sessionId: 'session-a',
      name: 'state_read',
      args: {},
    });
    await Promise.resolve();
    await Promise.resolve();
    const response = JSON.parse(socket?.sent.at(-1) ?? '{}') as {
      result?: Record<string, unknown>;
    };
    expect(response.result).toEqual({
      password: '[REDACTED]',
      count: '2',
      self: '[CIRCULAR]',
    });
  });

  it('omits absent optional event fields instead of sending null', () => {
    const transport = new Transport({
      url: 'ws://localhost/reticle',
      hello,
      handleCommand: () => Promise.resolve({ ok: true }),
    });
    transport.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    transport.sendEvent({
      t: 1,
      type: EventType.PAGE_HEALTH,
      sessionId: 'session-a',
      ref: undefined,
      data: { hidden: false, focused: true, reason: 'initial' },
    });
    const event = JSON.parse(socket?.sent.at(-1) ?? '{}') as {
      event?: Record<string, unknown>;
    };
    expect(event.event).not.toHaveProperty('ref');
  });

  it('keeps thrown command errors within the wire schema limit', async () => {
    const transport = new Transport({
      url: 'ws://localhost/reticle',
      hello,
      handleCommand: () => {
        throw new Error('x'.repeat(TRANSPORT_LIMITS.MAX_ERROR_LENGTH + 100));
      },
    });
    transport.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    socket?.receive({
      kind: MessageKind.COMMAND,
      id: 'c1',
      sessionId: 'session-a',
      name: 'state_read',
      args: {},
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(() => CommandResultSchema.parse(JSON.parse(socket?.sent.at(-1) ?? '{}'))).not.toThrow();
  });
});
