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
import { Session } from '../session/session.js';
import { JournalRecorder, type JournalReader, type JournalSink } from './journal-recorder.js';

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
const noopSink: JournalSink = {
  appendEvents: () => Promise.resolve(),
  appendAction: () => Promise.resolve(),
};

function evt(seq: number): ReticleEvent {
  return { t: seq, seq, type: EventType.DOM_ADDED, sessionId: 'demo', data: {} };
}

function newSession(reader: JournalReader): Session {
  const session = new Session(hello(), noopSocket, () => 0);
  session.setJournal(new JournalRecorder(noopSink, { now: () => session.elapsed() }), reader);
  return session;
}

describe('Session.queryEvents', () => {
  it('recovers an evicted event from the journal once the buffer has dropped', async () => {
    let reads = 0;
    const reader: JournalReader = {
      readEvents: () => {
        reads += 1;
        return Promise.resolve([evt(0)]); // seq 0 will be evicted from the buffer
      },
    };
    const session = newSession(reader);
    // Overflow the ring buffer so seq 0 is evicted (count cap) and bufferHealth.dropped > 0.
    for (let i = 0; i <= RING_BUFFER_DEFAULTS.MAX_EVENTS; i += 1) session.pushEvent(evt(i));

    const all = await session.queryEvents({});
    expect(reads).toBe(1);
    expect(all.some((e) => 0 === e.seq)).toBe(true); // survived eviction via the journal
  });

  it('never touches the journal when the buffer has not evicted (fast path)', async () => {
    const reader: JournalReader = {
      readEvents: () => Promise.reject(new Error('journal should not be read on a healthy buffer')),
    };
    const session = newSession(reader);
    session.pushEvent(evt(0));
    session.pushEvent(evt(1));
    const all = await session.queryEvents({});
    expect(all.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('filters by actionId against the merged set', async () => {
    const reader: JournalReader = {
      readEvents: () =>
        Promise.resolve([
          { ...evt(0), actionId: 'a1' },
          { ...evt(1), actionId: 'a2' },
        ]),
    };
    const session = newSession(reader);
    for (let i = 0; i <= RING_BUFFER_DEFAULTS.MAX_EVENTS; i += 1) session.pushEvent(evt(i + 10));
    const a1 = await session.queryEvents({ actionId: 'a1' });
    expect(a1.map((e) => e.seq)).toEqual([0]);
  });
});
