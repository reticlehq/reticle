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

/**
 * The offline queue drops the OLDEST events once it is full. Those events are gone: they are not in
 * the buffer, not in the journal, and nothing else in the system can notice their absence. A ledger
 * with an unmarked hole reads as "the app did nothing" — the exact false negative TRANSPORT_OVERFLOW
 * exists to prevent. These tests pin that the gap is always declared, exactly once, positioned at the
 * gap rather than at the end of the replay.
 */

/** Controllable WebSocket double that records everything the transport sent, in order. */
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

const OVERFLOW_BY = 3;

const evt = (seq: number): ReticleEvent => ({
  t: seq * 10,
  seq,
  type: EventType.DOM_ADDED,
  sessionId: 's',
  data: {},
});

/**
 * The scheduled reconnect runs on a timer bound before any fake clock, so a test cannot drive it.
 * The foreground path reconnects through the same `#open`, and its visibility source is injectable.
 */
let becomeVisible: () => void = () => undefined;

function makeTransport(): Transport {
  return new Transport({
    url: 'ws://x',
    hello,
    handleCommand: () => Promise.resolve({ ok: true }),
    onVisible: (handler) => {
      becomeVisible = handler;
      return () => undefined;
    },
  });
}

/** Drop the live socket and let the tab come back to the foreground, opening a fresh one. */
function reconnect(): FakeWebSocket | undefined {
  at(FakeWebSocket.instances, -1)?.close();
  becomeVisible();
  return at(FakeWebSocket.instances, -1);
}

/** Every EVENT message the socket received, validated against the real wire schema. */
function eventsOn(ws: FakeWebSocket | undefined): ReticleEvent[] {
  return (ws?.sent ?? []).flatMap((text) => {
    const parsed: unknown = JSON.parse(text);
    const result = EventMessageSchema.safeParse(parsed);
    return result.success ? [result.data.event] : [];
  });
}

const overflowMarkers = (ws: FakeWebSocket | undefined): ReticleEvent[] =>
  eventsOn(ws).filter((e) => e.type === EventType.TRANSPORT_OVERFLOW);

/** Queue `count` events while the socket is still connecting, then open it to flush the backlog. */
function overflowThenOpen(t: Transport, count: number): FakeWebSocket | undefined {
  const ws = at(FakeWebSocket.instances, -1);
  for (let i = 0; i < count; i += 1) t.sendEvent(evt(i));
  ws?.open();
  return ws;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  becomeVisible = () => undefined;
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('transport overflow marker', () => {
  it('declares the gap with a transport.overflow event once the queue has dropped events', () => {
    const t = makeTransport();
    t.connect();
    const ws = overflowThenOpen(t, MAX_QUEUE + OVERFLOW_BY);

    expect(overflowMarkers(ws)).toHaveLength(1);
  });

  it('reports how many events the gap swallowed', () => {
    const t = makeTransport();
    t.connect();
    const ws = overflowThenOpen(t, MAX_QUEUE + OVERFLOW_BY);

    expect(overflowMarkers(ws)[0]?.data['dropped']).toBe(OVERFLOW_BY);
  });

  it('stays silent when nothing was dropped — silence must keep meaning "complete"', () => {
    const t = makeTransport();
    t.connect();
    const ws = overflowThenOpen(t, MAX_QUEUE);

    expect(overflowMarkers(ws)).toHaveLength(0);
  });

  it('coalesces a storm of drops into exactly one marker', () => {
    const t = makeTransport();
    t.connect();
    const ws = overflowThenOpen(t, MAX_QUEUE * 4);

    expect(overflowMarkers(ws)).toHaveLength(1);
    expect(overflowMarkers(ws)[0]?.data['dropped']).toBe(MAX_QUEUE * 3);
  });

  it('never spends a queue slot on the marker — declaring a drop must not cause one', () => {
    const t = makeTransport();
    t.connect();
    const ws = overflowThenOpen(t, MAX_QUEUE + OVERFLOW_BY);

    // The backlog still replays a full queue's worth. A marker routed back through the queue would
    // evict a real event per drop, so each declared gap would silently widen the gap it declares.
    const replayed = eventsOn(ws).filter((e) => e.type !== EventType.TRANSPORT_OVERFLOW);
    expect(replayed).toHaveLength(MAX_QUEUE);
  });

  it('sends the marker before the replayed backlog', () => {
    const t = makeTransport();
    t.connect();
    const ws = overflowThenOpen(t, MAX_QUEUE + OVERFLOW_BY);

    expect(eventsOn(ws)[0]?.type).toBe(EventType.TRANSPORT_OVERFLOW);
  });

  it('tombstones the marker with the first dropped event so it sorts at the gap, not at the end', () => {
    const t = makeTransport();
    t.connect();
    const ws = overflowThenOpen(t, MAX_QUEUE + OVERFLOW_BY);
    const marker = overflowMarkers(ws)[0];
    const survivors = eventsOn(ws).filter((e) => e.type !== EventType.TRANSPORT_OVERFLOW);

    // The server orders a session by `seq`. A marker minted at reconnect would carry the HIGHEST seq
    // and land in the last segment — attributing the gap to a window that never had one. Reusing the
    // seq of an event it displaced (never delivered, so never a duplicate) puts it at the boundary.
    //
    // It is the FIRST drop, not the last. Under the plain FIFO this test was written against the two
    // were interchangeable and the last was tighter. Churn-aware eviction retired that: the queue can
    // now sacrifice a churn event NEWER than a signal event that survives, and a marker carrying the
    // last drop would sort AFTER a survivor — claiming a hole over events delivered in the same
    // replay. The oldest drop is the honest floor. The assertion below is the invariant that matters;
    // it held under FIFO and it still holds.
    const firstDropped = evt(0);
    expect(marker?.seq).toBe(firstDropped.seq);
    expect(marker?.t).toBe(firstDropped.t);
    expect(marker?.seq).toBeLessThan(survivors[0]?.seq ?? 0);
  });

  it('counts a second gap on its own, without re-reporting the first', () => {
    const t = makeTransport();
    t.connect();
    overflowThenOpen(t, MAX_QUEUE + OVERFLOW_BY);

    const second = reconnect(); // the bridge drops again, then comes back
    for (let i = 0; i < MAX_QUEUE + 1; i += 1) t.sendEvent(evt(i));
    second?.open();

    expect(overflowMarkers(second)).toHaveLength(1);
    expect(overflowMarkers(second)[0]?.data['dropped']).toBe(1);
  });

  it('does not re-announce a settled gap on a later reconnect', () => {
    const t = makeTransport();
    t.connect();
    overflowThenOpen(t, MAX_QUEUE + OVERFLOW_BY);

    const second = reconnect();
    second?.open(); // reconnects clean, nothing dropped in between

    expect(overflowMarkers(second)).toHaveLength(0);
  });
});
