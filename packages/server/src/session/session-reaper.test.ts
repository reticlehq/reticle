import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import {
  IRIS_PROTOCOL_VERSION,
  MessageKind,
  SESSION_LIFECYCLE,
  SessionState,
  type HelloMessage,
} from '@syrin/iris-protocol';
import { UNDELIVERED_NOTES_LABEL } from '@syrin/iris-protocol';
import { Session, SessionManager } from './session.js';
import {
  reapIdleSessions,
  endAllSessions,
  composeEndedNotice,
  SessionReaper,
} from './session-reaper.js';

const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

function hello(id: string): HelloMessage {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: IRIS_PROTOCOL_VERSION,
    sessionId: id,
    url: 'http://localhost/',
    title: 'Demo',
    adapters: [],
    hasCapabilities: false,
  };
}

function makeManager(): {
  mgr: SessionManager;
  add: (id: string) => Session;
  tick: (ms: number) => void;
} {
  let now = 0;
  const mgr = new SessionManager();
  return {
    mgr,
    add: (id) => {
      const s = new Session(hello(id), fakeSocket, () => now);
      mgr.add(s);
      return s;
    },
    tick: (ms) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reapIdleSessions', () => {
  it('ends a session idle past its window and leaves a fresh one alone', () => {
    const { mgr, add, tick } = makeManager();
    const idle = add('idle');
    const fresh = add('fresh');
    idle.markAgentActivity();
    tick(SESSION_LIFECYCLE.IDLE_END_MS + 1);
    fresh.markAgentActivity(); // fresh just acted

    const ended = reapIdleSessions(mgr);

    expect(ended).toEqual(['idle']);
    expect(idle.isEnded()).toBe(true);
    expect(fresh.isEnded()).toBe(false);
  });

  it('honors a tuned (shorter) idle window', () => {
    const { mgr, add, tick } = makeManager();
    const s = add('s');
    s.setIdleEndMs(10_000);
    s.markAgentActivity();
    tick(11_000);

    expect(reapIdleSessions(mgr)).toEqual(['s']);
  });

  it('skips a session that is already ended', () => {
    const { mgr, add, tick } = makeManager();
    const s = add('s');
    s.setState(SessionState.ENDED);
    tick(SESSION_LIFECYCLE.IDLE_END_MS + 1);

    expect(reapIdleSessions(mgr)).toEqual([]);
  });
});

describe('endAllSessions', () => {
  it('ends every non-ended session (for an MCP-client disconnect)', () => {
    const { mgr, add } = makeManager();
    const a = add('a');
    const b = add('b');
    b.setState(SessionState.ENDED); // already ended explicitly

    const ended = endAllSessions(mgr, 'agent disconnected');

    expect(ended).toEqual(['a']);
    expect(a.isEnded()).toBe(true);
  });
});

describe('composeEndedNotice', () => {
  it('returns the base notice unchanged when nothing is undelivered', () => {
    expect(composeEndedNotice('Session ended.', [])).toBe('Session ended.');
  });

  it('folds undelivered notes into the notice, quoted and labeled', () => {
    expect(composeEndedNotice('Agent stopped.', ['fix the date picker', 'and the footer'])).toBe(
      `Agent stopped. · ${UNDELIVERED_NOTES_LABEL} "fix the date picker", "and the footer"`,
    );
  });
});

describe('endAllSessions surfaces an undelivered panel prompt', () => {
  it('folds a message the agent never read into the end notice instead of dropping it', () => {
    const sent: Record<string, unknown>[] = [];
    const recordingSocket = {
      readyState: 1,
      send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>),
    } as unknown as WebSocket;
    const mgr = new SessionManager();
    const s = new Session(hello('race'), recordingSocket, () => 0);
    mgr.add(s);
    s.pushMessage('also fix the date picker on mobile'); // typed in the death-race

    endAllSessions(mgr, 'Agent stopped — switch to your terminal to continue.');

    const presenter = sent.find(
      (m) => m['name'] === 'presenter' && (m['args'] as { state?: string }).state === 'ended',
    );
    const text = (presenter?.['args'] as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('also fix the date picker on mobile');
    expect(text).toContain(UNDELIVERED_NOTES_LABEL);
    expect(s.inboxSize()).toBe(0); // drained — no duplicate delivery to a returning agent
  });
});

describe('SessionReaper', () => {
  it('sweeps idle sessions on its interval, and stop() halts it', () => {
    vi.useFakeTimers();
    const { mgr, add, tick } = makeManager();
    const s = add('x');
    s.markAgentActivity();
    tick(SESSION_LIFECYCLE.IDLE_END_MS + 1);

    const reaper = new SessionReaper(mgr);
    reaper.start();
    vi.advanceTimersByTime(SESSION_LIFECYCLE.REAP_INTERVAL_MS);
    expect(s.isEnded()).toBe(true);

    reaper.stop();
    const other = add('y');
    other.markAgentActivity();
    tick(SESSION_LIFECYCLE.IDLE_END_MS + 1);
    vi.advanceTimersByTime(SESSION_LIFECYCLE.REAP_INTERVAL_MS * 3);
    expect(other.isEnded()).toBe(false); // stopped → no more sweeps
  });

  it('start() is idempotent', () => {
    vi.useFakeTimers();
    const { mgr } = makeManager();
    const reaper = new SessionReaper(mgr);
    reaper.start();
    expect(() => {
      reaper.start();
    }).not.toThrow();
    reaper.stop();
  });
});
