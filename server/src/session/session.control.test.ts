import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import {
  EventType,
  HumanControlKind,
  RETICLE_PROTOCOL_VERSION,
  ReticleCommand,
  MessageKind,
  SessionState,
  type CommandResult,
  type HelloMessage,
} from '@reticlehq/core';
import { Session } from './session.js';

const HELLO: HelloMessage = {
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId: 'demo',
  url: 'http://localhost/',
  title: 'Demo',
  adapters: [],
  hasCapabilities: false,
};

interface CapturedMessage {
  kind: string;
  name?: string;
  id?: string;
  args?: Record<string, unknown>;
}

function makeSession(): {
  session: Session;
  tick: (ms: number) => void;
  sent: CapturedMessage[];
  presenterPushes: () => CapturedMessage[];
} {
  let now = 0;
  const sent: CapturedMessage[] = [];
  const fakeSocket = {
    readyState: 1, // OPEN
    send: (raw: string): void => {
      sent.push(JSON.parse(raw) as CapturedMessage);
    },
  } as unknown as WebSocket;
  const session = new Session(HELLO, fakeSocket, () => now);
  return {
    session,
    tick: (ms: number) => {
      now += ms;
    },
    sent,
    presenterPushes: () =>
      sent.filter((m) => m.kind === MessageKind.COMMAND && m.name === ReticleCommand.PRESENTER),
  };
}

describe('Live-control state machine — valid transitions', () => {
  it('#1 a new session defaults to active', () => {
    const { session } = makeSession();
    expect(session.getState()).toBe(SessionState.ACTIVE);
  });

  it('#2 pause moves active to paused', () => {
    const { session } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.PAUSE });
    expect(session.getState()).toBe(SessionState.PAUSED);
  });

  it('#3 resume returns paused to active', () => {
    const { session } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.PAUSE });
    session.applyHumanControl({ kind: HumanControlKind.RESUME });
    expect(session.getState()).toBe(SessionState.ACTIVE);
  });

  it('#4 pause/resume/pause cycles and pushes presenter each real transition', () => {
    const { session, presenterPushes } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.PAUSE });
    session.applyHumanControl({ kind: HumanControlKind.RESUME });
    session.applyHumanControl({ kind: HumanControlKind.PAUSE });
    expect(session.getState()).toBe(SessionState.PAUSED);
    expect(presenterPushes()).toHaveLength(3);
  });

  it('#5 end moves to ended', () => {
    const { session } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.END });
    expect(session.getState()).toBe(SessionState.ENDED);
  });
});

describe('Live-control state machine — terminal / no-op edges', () => {
  it('#6 ended is terminal under resume', () => {
    const { session } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.END });
    session.applyHumanControl({ kind: HumanControlKind.RESUME });
    expect(session.getState()).toBe(SessionState.ENDED);
  });

  it('#7 ended is terminal under pause', () => {
    const { session } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.END });
    session.applyHumanControl({ kind: HumanControlKind.PAUSE });
    expect(session.getState()).toBe(SessionState.ENDED);
  });

  it('#8 end is idempotent and pushes exactly one presenter command', () => {
    const { session, presenterPushes } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.END });
    session.applyHumanControl({ kind: HumanControlKind.END });
    expect(session.getState()).toBe(SessionState.ENDED);
    expect(presenterPushes()).toHaveLength(1);
  });

  it('#9 resume on an active session is a no-op (no presenter push)', () => {
    const { session, presenterPushes } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.RESUME });
    expect(session.getState()).toBe(SessionState.ACTIVE);
    expect(presenterPushes()).toHaveLength(0);
  });

  it('#10 pause twice pushes exactly once', () => {
    const { session, presenterPushes } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.PAUSE });
    session.applyHumanControl({ kind: HumanControlKind.PAUSE });
    expect(session.getState()).toBe(SessionState.PAUSED);
    expect(presenterPushes()).toHaveLength(1);
  });
});

describe('Live-control PRESENTER push accounting', () => {
  it('#11 each real transition pushes exactly one presenter command with the state', () => {
    const { session, presenterPushes } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.PAUSE });
    const pushes = presenterPushes();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.name).toBe(ReticleCommand.PRESENTER);
    expect(pushes[0]?.args).toEqual({ state: SessionState.PAUSED });
  });

  it('#12 the presenter push carries the current state', () => {
    const { session, presenterPushes } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.END });
    expect(presenterPushes()[0]?.args?.['state']).toBe(SessionState.ENDED);
  });

  it('#13 the presenter push is fire-and-forget and does not poison pending commands', async () => {
    const { session, sent } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.PAUSE });
    // a subsequent real command must still round-trip cleanly
    const promise = session.command(ReticleCommand.SNAPSHOT, {});
    const real = sent.find(
      (m) => m.kind === MessageKind.COMMAND && m.name === ReticleCommand.SNAPSHOT,
    );
    expect(real?.id).toBeDefined();
    const result: CommandResult = {
      kind: MessageKind.COMMAND_RESULT,
      id: real?.id ?? '',
      ok: true,
    };
    session.handleResult(result);
    await expect(promise).resolves.toEqual(result);
  });
});

describe('Live-control inbox', () => {
  it('#14 message pushes to the inbox with the injected elapsed t', () => {
    const { session, tick } = makeSession();
    tick(120);
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: 'hi' });
    expect(session.drainInbox()).toEqual([{ text: 'hi', t: 120 }]);
  });

  it('#15 message with empty text is ignored', () => {
    const { session } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: '' });
    expect(session.inboxSize()).toBe(0);
  });

  it('#16 message with whitespace-only text is ignored', () => {
    const { session } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: '   ' });
    expect(session.inboxSize()).toBe(0);
  });

  it('#17 message trims surrounding whitespace', () => {
    const { session } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: '  go  ' });
    expect(session.drainInbox()[0]?.text).toBe('go');
  });

  it('#18 message does not change state and pushes no presenter command', () => {
    const { session, presenterPushes } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: 'hi' });
    expect(session.getState()).toBe(SessionState.ACTIVE);
    expect(presenterPushes()).toHaveLength(0);
  });

  it('#19 message while paused stays paused and queues', () => {
    const { session } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.PAUSE });
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: 'do x' });
    expect(session.getState()).toBe(SessionState.PAUSED);
    expect(session.inboxSize()).toBe(1);
  });

  it('#20 drainInbox returns all then empties', () => {
    const { session } = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: 'a' });
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: 'b' });
    const drained = session.drainInbox();
    expect(drained.map((m) => m.text)).toEqual(['a', 'b']);
    expect(session.drainInbox()).toEqual([]);
  });

  it('#21 drainInbox on an empty inbox returns []', () => {
    const { session } = makeSession();
    expect(session.drainInbox()).toEqual([]);
  });
});

describe('Live-control unknown / invalid control via pushEvent', () => {
  function controlEvent(data: Record<string, unknown>): Parameters<Session['pushEvent']>[0] {
    return { t: 0, type: EventType.HUMAN_CONTROL, sessionId: 'demo', data };
  }

  it('#22 unknown control kind is ignored (no throw, no mutation, no push)', () => {
    const { session, presenterPushes } = makeSession();
    expect(() => session.pushEvent(controlEvent({ kind: 'frobnicate' }))).not.toThrow();
    expect(session.getState()).toBe(SessionState.ACTIVE);
    expect(session.inboxSize()).toBe(0);
    expect(presenterPushes()).toHaveLength(0);
  });

  it('#23 missing kind is ignored', () => {
    const { session } = makeSession();
    expect(() => session.pushEvent(controlEvent({}))).not.toThrow();
    expect(session.getState()).toBe(SessionState.ACTIVE);
    expect(session.inboxSize()).toBe(0);
  });

  it('#24 a valid HUMAN_CONTROL event is still buffered (visible in observe/timeline)', () => {
    const { session, tick } = makeSession();
    tick(50);
    session.pushEvent(controlEvent({ kind: HumanControlKind.PAUSE }));
    expect(session.getState()).toBe(SessionState.PAUSED);
    const buffered = session.eventsSince(0).filter((e) => e.type === EventType.HUMAN_CONTROL);
    expect(buffered).toHaveLength(1);
    expect(buffered[0]?.t).toBe(50);
  });
});
