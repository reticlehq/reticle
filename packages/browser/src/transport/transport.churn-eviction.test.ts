import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RETICLE_PROTOCOL_VERSION,
  EventMessageSchema,
  EventType,
  MessageKind,
  type HelloMessage,
  type ReticleEvent,
} from '@reticlehq/core';
import { MAX_QUEUE, Transport } from './transport.js';
import { at } from '../test-support/array-at.js';

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

const churnEvt = (seq: number): ReticleEvent => ({
  t: seq * 10,
  seq,
  type: EventType.DOM_TEXT,
  sessionId: 's',
  data: {},
});

const signalEvt = (seq: number): ReticleEvent => ({
  t: seq * 10,
  seq,
  type: EventType.NET_REQUEST,
  sessionId: 's',
  data: {},
});

function makeTransport(): Transport {
  return new Transport({
    url: 'ws://x',
    hello,
    handleCommand: () => Promise.resolve({ ok: true }),
    onVisible: () => () => undefined,
  });
}

function eventsOn(ws: FakeWebSocket | undefined): ReticleEvent[] {
  return (ws?.sent ?? []).flatMap((text) => {
    const parsed: unknown = JSON.parse(text);
    const result = EventMessageSchema.safeParse(parsed);
    return result.success ? [result.data.event] : [];
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('transport churn-aware eviction', () => {
  it('evicts churn before signal events when the queue overflows', () => {
    const t = makeTransport();
    t.connect();
    const ws = at(FakeWebSocket.instances, -1);

    t.sendEvent(signalEvt(0));
    for (let i = 1; i < MAX_QUEUE + 10; i += 1) t.sendEvent(churnEvt(i));

    ws?.open();
    const replayed = eventsOn(ws).filter((e) => e.type !== EventType.TRANSPORT_OVERFLOW);
    const signalEvents = replayed.filter((e) => e.type === EventType.NET_REQUEST);
    expect(signalEvents).toHaveLength(1);
    expect(signalEvents[0]?.seq).toBe(0);
  });

  it('falls back to signal FIFO when the churn queue is empty', () => {
    const t = makeTransport();
    t.connect();
    const ws = at(FakeWebSocket.instances, -1);

    for (let i = 0; i < MAX_QUEUE + 5; i += 1) t.sendEvent(signalEvt(i));

    ws?.open();
    const replayed = eventsOn(ws).filter((e) => e.type !== EventType.TRANSPORT_OVERFLOW);
    expect(replayed).toHaveLength(MAX_QUEUE);
    expect(replayed[0]?.seq).toBe(5);
  });

  it('preserves temporal insertion order across both queues on replay', () => {
    const t = makeTransport();
    t.connect();
    const ws = at(FakeWebSocket.instances, -1);

    t.sendEvent(signalEvt(1));
    t.sendEvent(churnEvt(2));
    t.sendEvent(signalEvt(3));
    t.sendEvent(churnEvt(4));
    t.sendEvent(signalEvt(5));

    ws?.open();
    const replayed = eventsOn(ws);
    const seqs = replayed.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('still emits a gap marker when churn events are evicted', () => {
    const t = makeTransport();
    t.connect();
    const ws = at(FakeWebSocket.instances, -1);

    for (let i = 0; i < MAX_QUEUE + 3; i += 1) t.sendEvent(churnEvt(i));

    ws?.open();
    const markers = eventsOn(ws).filter((e) => e.type === EventType.TRANSPORT_OVERFLOW);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.data['dropped']).toBe(3);
  });

  it('a signal event arriving into a full churn queue survives', () => {
    const t = makeTransport();
    t.connect();
    const ws = at(FakeWebSocket.instances, -1);

    for (let i = 0; i < MAX_QUEUE - 1; i += 1) t.sendEvent(churnEvt(i));
    t.sendEvent(signalEvt(MAX_QUEUE));

    ws?.open();
    const replayed = eventsOn(ws).filter((e) => e.type !== EventType.TRANSPORT_OVERFLOW);
    const signalEvents = replayed.filter((e) => e.type === EventType.NET_REQUEST);
    expect(signalEvents).toHaveLength(1);
  });

  it('stamps the gap marker with the OLDEST drop, never ahead of a surviving event', () => {
    // Churn-first eviction can sacrifice an event NEWER than a signal event that survives. If the
    // marker carried the latest drop it would claim a hole covering events the bridge is about to
    // receive in the same replay — a truncation marker that over-reports what is missing.
    const t = makeTransport();
    t.connect();
    const ws = at(FakeWebSocket.instances, -1);

    t.sendEvent(signalEvt(500)); // t = 5000, survives — and is NEWER than every churn event below
    for (let i = 1; i <= MAX_QUEUE + 5; i += 1) t.sendEvent(churnEvt(i)); // t = 10..

    ws?.open();
    const sent = eventsOn(ws);
    const marker = sent.find((e) => e.type === EventType.TRANSPORT_OVERFLOW);
    const survivors = sent.filter((e) => e.type !== EventType.TRANSPORT_OVERFLOW);
    const oldestSurvivorT = Math.min(...survivors.map((e) => e.t));

    expect(marker).toBeDefined();
    expect(marker?.t).toBe(10); // the first churn event evicted, not the last
    expect(marker?.t).toBeLessThanOrEqual(oldestSurvivorT);
  });
});
