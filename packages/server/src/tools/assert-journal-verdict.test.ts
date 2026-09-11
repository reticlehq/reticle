import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  EventType,
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
  Verified,
  type HelloMessage,
  type JournalAction,
  type ReticleEvent,
} from '@reticlehq/core';
import { JournalRecorder, type JournalSink } from '../journal/journal-recorder.js';
import { provenFromJournal } from '../runs/run-context.js';
import { Session, type SessionManager } from '../session/session.js';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';

/**
 * `reticle_assert` produces a verdict, and for as long as it journalled nothing that proof was
 * invisible to `reticle_context`. An agent that proved something here and then compacted was told
 * nothing had been proven — the exact re-prove-or-assume failure the run context exists to prevent,
 * in the tool most used for pure assertion.
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

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

/** A live session with a journal attached, plus the deps the assert handler resolves it through. */
function journalledSession(): {
  session: Session;
  deps: ToolDeps;
  sink: ReturnType<typeof fakeSink>;
} {
  const session = new Session(hello(), noopSocket, () => 0);
  const sink = fakeSink();
  session.setJournal(new JournalRecorder(sink, { now: () => session.elapsed(), flushAt: 100 }));
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return { session, deps: { sessions: sessions as SessionManager } as unknown as ToolDeps, sink };
}

const SIGNAL_NAME = 'todo:added';
const assertSignal = { predicate: { kind: 'signal', name: SIGNAL_NAME }, timeout_ms: 0 };

function signalEvent(): ReticleEvent {
  return { t: 1, seq: 1, type: EventType.SIGNAL, sessionId: 'demo', data: { name: SIGNAL_NAME } };
}

describe('reticle_assert journals its verdict', () => {
  it('lands an action record carrying the verdict effect', async () => {
    const { session, deps, sink } = journalledSession();
    session.pushEvent(signalEvent());
    await tool(ReticleTool.ASSERT).handler(deps, assertSignal);
    await session.flushJournal();
    const action = sink.actions.find((a) => ReticleTool.ASSERT === a.tool);
    expect(action).toBeDefined();
    expect(
      action?.seqRange,
      'an assert opens no window, so it attributes no events',
    ).toBeUndefined();
  });

  it('does not open an attribution window — a later event is not stamped with it', async () => {
    const { session, deps, sink } = journalledSession();
    session.pushEvent(signalEvent());
    await tool(ReticleTool.ASSERT).handler(deps, assertSignal);
    session.pushEvent({ t: 2, seq: 2, type: EventType.NET_REQUEST, sessionId: 'demo', data: {} });
    await session.flushJournal();
    const ambient = sink.events.find((e) => 2 === e.seq);
    expect(ambient?.actionId).toBeUndefined();
    expect(ambient?.attribution).toBeUndefined();
  });

  it('leaves an act_and_wait window in flight untouched', async () => {
    const { session, deps, sink } = journalledSession();
    const windowId = session.beginAction(ReticleTool.ACT_AND_WAIT, {});
    session.pushEvent(signalEvent());
    await tool(ReticleTool.ASSERT).handler(deps, assertSignal);
    session.pushEvent({ t: 2, seq: 2, type: EventType.NET_REQUEST, sessionId: 'demo', data: {} });
    session.finishAction(undefined, true);
    await session.flushJournal();
    expect(sink.events.find((e) => 2 === e.seq)?.actionId).toBe(windowId);
    expect(sink.actions.find((a) => a.actionId === windowId)?.seqRange).toEqual({ from: 1, to: 2 });
  });

  it('writes the same verdict shape act_and_wait writes, so proven folds it', async () => {
    const { session, deps, sink } = journalledSession();
    session.pushEvent(signalEvent());
    await tool(ReticleTool.ASSERT).handler(deps, assertSignal);
    await session.flushJournal();
    const proven = provenFromJournal(sink.actions, sink.events);
    expect(proven).toHaveLength(1);
    expect(proven[0]?.claim).toContain(SIGNAL_NAME);
    expect(proven[0]?.verified).toBe(Verified.YES);
  });
});
