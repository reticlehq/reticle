import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import {
  HumanControlKind,
  RETICLE_PROTOCOL_VERSION,
  MessageKind,
  SessionState,
  type HelloMessage,
} from '@reticlehq/core';
import { Session } from './session.js';
import { buildControlEnvelope } from './control-envelope.js';

const HELLO: HelloMessage = {
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId: 'demo',
  url: 'http://localhost/',
  title: 'Demo',
  adapters: [],
  hasCapabilities: false,
};

const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

function makeSession(): Session {
  return new Session(HELLO, fakeSocket, () => 0);
}

describe('buildControlEnvelope (pure)', () => {
  it('#25 returns undefined for a clean active session', () => {
    const session = makeSession();
    expect(buildControlEnvelope(session)).toBeUndefined();
  });

  it('#26 is defined when paused even if inbox empty', () => {
    const session = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.PAUSE });
    expect(buildControlEnvelope(session)).toEqual({ state: SessionState.PAUSED, guidance: [] });
  });

  it('#27 is defined when active with an inbox message', () => {
    const session = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: 'hi' });
    expect(buildControlEnvelope(session)).toEqual({ state: SessionState.ACTIVE, guidance: ['hi'] });
  });

  it('#28 guidance is the drained inbox text, in order', () => {
    const session = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: 'a' });
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: 'b' });
    expect(buildControlEnvelope(session)?.guidance).toEqual(['a', 'b']);
  });

  it('#29 building the envelope drains the inbox (delivered once)', () => {
    const session = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.MESSAGE, text: 'x' });
    expect(buildControlEnvelope(session)?.guidance).toEqual(['x']);
    expect(buildControlEnvelope(session)).toBeUndefined();
  });

  it('#30 is defined when ended', () => {
    const session = makeSession();
    session.applyHumanControl({ kind: HumanControlKind.END });
    expect(buildControlEnvelope(session)).toEqual({ state: SessionState.ENDED, guidance: [] });
  });
});
