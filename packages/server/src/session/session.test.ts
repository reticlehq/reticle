import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import {
  IRIS_PROTOCOL_VERSION,
  MessageKind,
  EventType,
  SESSION_HEALTH,
  SESSION_LIFECYCLE,
  SessionState,
  UNSCRIPTABLE_TAB_RECOMMENDATION,
  type HelloMessage,
  type IrisEvent,
} from '@syrin/iris-protocol';
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

describe('SPA navigation keeps session.url live (real-input correlation fix)', () => {
  const routeEvent = (to: string): IrisEvent =>
    ({
      type: EventType.ROUTE_CHANGE,
      data: { from: 'x', to, pathname: '', search: '', hash: '' },
    }) as unknown as IrisEvent;

  it('updates url on a ROUTE_CHANGE event (so CDP page correlation tracks SPA nav)', () => {
    const { session } = makeSession();
    expect(session.url).toBe('http://localhost/');
    session.pushEvent(routeEvent('http://localhost/workspace?script=42'));
    expect(session.url).toBe('http://localhost/workspace?script=42');
    expect(session.info().url).toBe('http://localhost/workspace?script=42');
  });

  it('ignores a route event with a missing/empty/non-string `to` (keeps the last good url)', () => {
    const { session } = makeSession();
    session.pushEvent(routeEvent('http://localhost/a'));
    session.pushEvent({ type: EventType.ROUTE_CHANGE, data: { to: '' } } as unknown as IrisEvent);
    session.pushEvent({ type: EventType.ROUTE_CHANGE, data: {} } as unknown as IrisEvent);
    expect(session.url).toBe('http://localhost/a');
  });
});

describe('session health', () => {
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

describe('server-authoritative liveness', () => {
  it('tracks agent idle time from the injected clock', () => {
    const { session, tick } = makeSession();
    session.markAgentActivity();
    expect(session.agentIdleMs()).toBe(0);
    tick(5000);
    expect(session.agentIdleMs()).toBe(5000);
  });

  it('agentIdleMs resets on the next agent activity', () => {
    const { session, tick } = makeSession();
    tick(10_000);
    session.markAgentActivity();
    expect(session.agentIdleMs()).toBe(0);
  });

  it('defaults idleEndMs and floors a tuned value below the minimum', () => {
    const { session } = makeSession();
    expect(session.idleEndMs()).toBe(SESSION_LIFECYCLE.IDLE_END_MS);
    session.setIdleEndMs(1000); // below the floor
    expect(session.idleEndMs()).toBe(SESSION_LIFECYCLE.IDLE_END_MIN_MS);
    session.setIdleEndMs(30_000);
    expect(session.idleEndMs()).toBe(30_000);
  });

  it('autoEnd marks the session ended', () => {
    const { session } = makeSession();
    session.autoEnd('idle');
    expect(session.isEnded()).toBe(true);
    expect(session.getState()).toBe(SessionState.ENDED);
  });

  it('revives an auto-ended session when the agent acts again (slow-but-alive Claude)', () => {
    const { session } = makeSession();
    session.autoEnd('idle');
    expect(session.getState()).toBe(SessionState.ENDED);
    session.markAgentActivity();
    expect(session.getState()).toBe(SessionState.ACTIVE);
  });

  it('an EXPLICIT end stays terminal even if the agent acts again', () => {
    const { session } = makeSession();
    session.setState(SessionState.ENDED); // human/agent iris_end_session, not the reaper
    session.markAgentActivity();
    expect(session.getState()).toBe(SessionState.ENDED);
  });
});

describe('un-scriptable tab recommendation', () => {
  it('info() carries the recommendation when hidden', () => {
    const { session } = makeSession();
    session.applyHealth(true, false);
    expect(session.info().recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });

  it('info() recommends when stale past the threshold', () => {
    const { session, tick } = makeSession();
    session.touch();
    tick(SESSION_HEALTH.STALE_THRESHOLD_MS + 1);
    expect(session.info().recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });

  it('info() omits recommendation when visible and recently seen', () => {
    const { session, tick } = makeSession();
    session.applyHealth(false, true);
    tick(1000);
    session.touch();
    expect('recommendation' in session.info()).toBe(false);
  });

  it('health() carries the recommendation when throttled', () => {
    const { session } = makeSession();
    session.applyHealth(true, false);
    expect(session.health().recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });
});
