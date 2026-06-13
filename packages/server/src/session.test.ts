import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import {
  IRIS_PROTOCOL_VERSION,
  MessageKind,
  SESSION_HEALTH,
  type HelloMessage,
} from '@iris/protocol';
import { Session } from './session.js';

const HELLO: HelloMessage = {
  kind: MessageKind.HELLO,
  protocolVersion: IRIS_PROTOCOL_VERSION,
  sessionId: 'demo',
  url: 'http://localhost/',
  title: 'Demo',
  adapters: [],
  hasCapabilities: false,
};

const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

function makeSession(): { session: Session; tick: (ms: number) => void } {
  let now = 0;
  const session = new Session(HELLO, fakeSocket, () => now);
  return {
    session,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe('F2 session health', () => {
  it('throttles when lastSeen exceeds the stale threshold (clock injected)', () => {
    const { session, tick } = makeSession();
    session.touch();
    expect(session.throttled()).toBe(false);
    tick(SESSION_HEALTH.STALE_THRESHOLD_MS + 1);
    expect(session.throttled()).toBe(true);
    expect(session.lastSeenMs()).toBeGreaterThan(SESSION_HEALTH.STALE_THRESHOLD_MS);
  });

  it('throttles immediately when the tab is hidden, regardless of recency', () => {
    const { session } = makeSession();
    session.touch();
    session.applyHealth(true, false);
    expect(session.throttled()).toBe(true);
    expect(session.health().focused).toBe(false);
  });

  it('is not throttled when visible and recently seen', () => {
    const { session, tick } = makeSession();
    session.applyHealth(false, true);
    tick(1000);
    session.touch();
    expect(session.throttled()).toBe(false);
    const h = session.health();
    expect(h.throttled).toBe(false);
    expect(h.focused).toBe(true);
  });

  it('exposes health on info()', () => {
    const { session } = makeSession();
    session.applyHealth(true, false);
    const info = session.info();
    expect(info.hidden).toBe(true);
    expect(info.focused).toBe(false);
    expect(info.throttled).toBe(true);
    expect(typeof info.lastSeenMs).toBe('number');
  });
});
