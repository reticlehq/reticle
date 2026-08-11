import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  EventType,
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
  RING_BUFFER_DEFAULTS,
  type HelloMessage,
  type ReticleEvent,
} from '@reticlehq/core';
import { Session } from './session.js';

/**
 * `Session.bufferHealth()` must report what the ring buffer actually dropped.
 *
 * This one-line delegation carries the honesty signal that reaches every verdict. From a live drive:
 *
 *   "buffer": { "held": 2000, "dropped": 4422,
 *               "note": "event buffer evicted older events (age/size cap) — a negative result here
 *                        may be a false negative; the evidence may have expired." }
 *
 * That note is what stops an agent trusting `{ kind:'console', absent:true }` after a long flow. If
 * `dropped` silently read 0 the note disappears and a negative result reads as clean — the precise
 * false green this product exists to prevent, produced by the layer meant to prevent it.
 *
 * Found by mutation: forcing `dropped: 0` here failed ZERO tests in the repo. The two neighbours are
 * both well covered and neither touches this seam — `ring-buffer.test.ts` asserts the buffer's own
 * counter, and every tool test STUBS `bufferHealth` on a fake session. So the buffer was tested, the
 * consumers were tested, and the wire between them was not.
 */
function hello(): HelloMessage {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: 'demo',
    url: 'http://localhost/',
    title: 'Demo',
    adapters: [],
  };
}

const noopSocket = { send: () => undefined, close: () => undefined } as unknown as WebSocket;

function evt(seq: number): ReticleEvent {
  return { t: seq, seq, type: EventType.DOM_ADDED, sessionId: 'demo', data: {} };
}

describe('Session.bufferHealth reports real eviction', () => {
  it('is silent on a fresh session — absence must keep meaning "nothing was lost"', () => {
    const session = new Session(hello(), noopSocket, () => 0);
    session.pushEvent(evt(0));
    expect(session.bufferHealth().dropped).toBe(0);
    expect(session.bufferHealth().total).toBeGreaterThan(0);
  });

  it('reports the drop once the buffer has evicted', () => {
    const session = new Session(hello(), noopSocket, () => 0);
    // One past the count cap: the oldest event is evicted and the counter must say so.
    for (let i = 0; i <= RING_BUFFER_DEFAULTS.MAX_EVENTS; i += 1) session.pushEvent(evt(i));
    expect(session.bufferHealth().dropped).toBeGreaterThan(0);
  });

  it('keeps counting as eviction continues, rather than latching at one', () => {
    // A counter that reported "1" forever would still satisfy the test above while understating the
    // gap by any margin. The disclosure is only useful if it tracks how much went missing.
    const session = new Session(hello(), noopSocket, () => 0);
    for (let i = 0; i <= RING_BUFFER_DEFAULTS.MAX_EVENTS; i += 1) session.pushEvent(evt(i));
    const first = session.bufferHealth().dropped;
    for (let i = 0; i < 50; i += 1) session.pushEvent(evt(RING_BUFFER_DEFAULTS.MAX_EVENTS + i));
    expect(session.bufferHealth().dropped).toBe(first + 50);
  });
});
