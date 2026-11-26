/**
 * An app that calls `connect()` itself, before the build plugin's injected `connect({ projectId })`,
 * lost its project: the second call returned early, HELLO had already gone without an id, and every
 * session of that app went to `unmatched/`. A later call that names a project the page has not
 * announced now announces it again on the live socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageKind } from '@reticlehq/core';
import { Reticle } from './reticle.js';

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

describe('a project id that arrives after the first connect()', () => {
  const sdk = new Reticle();
  afterEach(() => {
    sdk.disconnect();
    vi.unstubAllGlobals();
  });

  it('announces the later id on the live socket', () => {
    vi.stubGlobal('WebSocket', RecordingSocket);
    sdk.connect();
    const socket = RecordingSocket.last;
    if (socket === undefined) throw new Error('connect() opened no socket');
    socket.open();
    expect(socket.hellos().at(-1)?.['projectId']).toBeUndefined();

    sdk.connect({ projectId: 'shop' });

    expect(socket.hellos().at(-1)?.['projectId']).toBe('shop');
  });

  it('announces a project root on the first hello, and a root that arrives later', () => {
    vi.stubGlobal('WebSocket', RecordingSocket);
    sdk.connect({ root: '/remote/app' });
    const socket = RecordingSocket.last;
    if (socket === undefined) {
      throw new Error('connect() opened no socket');
    }
    socket.open();
    expect(socket.hellos().at(-1)?.['root']).toBe('/remote/app');

    sdk.disconnect();
    sdk.connect();
    const second = RecordingSocket.last;
    if (second === undefined) {
      throw new Error('connect() opened no socket');
    }
    second.open();
    expect(second.hellos().at(-1)?.['root']).toBeUndefined();

    sdk.connect({ root: '/remote/later' });

    expect(second.hellos().at(-1)?.['root']).toBe('/remote/later');
  });

  it('keeps the first id when a later call names a different one', () => {
    vi.stubGlobal('WebSocket', RecordingSocket);
    sdk.connect({ projectId: 'shop' });
    const socket = RecordingSocket.last;
    if (socket === undefined) throw new Error('connect() opened no socket');
    socket.open();
    const before = socket.hellos().length;

    sdk.connect({ projectId: 'admin' });

    expect(socket.hellos()).toHaveLength(before);
    expect(socket.hellos().at(-1)?.['projectId']).toBe('shop');
  });
});
