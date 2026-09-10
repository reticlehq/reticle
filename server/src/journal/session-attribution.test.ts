import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  EventType,
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
  type HelloMessage,
  type JournalAction,
  type ReticleEvent,
} from '@reticlehq/core';
import { Session } from '../session/session.js';
import { JournalRecorder, type JournalSink } from './journal-recorder.js';

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

function fakeSink(): JournalSink & { events: ReticleEvent[]; actions: JournalAction[] } {
  const events: ReticleEvent[] = [];
  const actions: JournalAction[] = [];
  return {
    events,
    actions,
    appendEvents(batch) {
      events.push(...batch);
      return Promise.resolve();
    },
    appendAction(action) {
      actions.push(action);
      return Promise.resolve();
    },
  };
}

const noopSocket = { send: () => undefined, close: () => undefined } as unknown as WebSocket;

describe('Session journal attribution (begin/pushEvent/finish)', () => {
  it('mints sequential action ids, attributes events, and records the action', async () => {
    const session = new Session(hello(), noopSocket, () => 0);
    const sink = fakeSink();
    session.setJournal(new JournalRecorder(sink, { now: () => session.elapsed() }));

    const first = session.beginAction('reticle_act', { ref: 'e7' });
    const second = ((): string => {
      session.finishAction();
      return session.beginAction('reticle_act', { ref: 'e8' });
    })();
    expect(first).toBe('a1');
    expect(second).toBe('a2');

    session.pushEvent({ t: 0, seq: 5, type: EventType.NET_REQUEST, sessionId: 'demo', data: {} });
    session.finishAction(undefined, true, 12);
    await session.flushJournal();

    const attributed = sink.events.find((e) => 5 === e.seq);
    expect(attributed?.actionId).toBe('a2');
    expect(attributed?.attribution).toBe('window');

    const a2 = sink.actions.find((a) => 'a2' === a.actionId);
    expect(a2?.seqRange).toEqual({ from: 5, to: 5 });
    expect(a2?.settled).toBe(true);
    expect(a2?.settledInMs).toBe(12);
  });

  it('leaves events unattributed when no action is open', async () => {
    const session = new Session(hello(), noopSocket, () => 0);
    const sink = fakeSink();
    session.setJournal(new JournalRecorder(sink, { now: () => session.elapsed() }));
    session.pushEvent({ t: 0, seq: 0, type: EventType.DOM_ADDED, sessionId: 'demo', data: {} });
    await session.flushJournal();
    expect(sink.events[0]?.actionId).toBeUndefined();
    expect(sink.actions).toHaveLength(0);
  });
});
