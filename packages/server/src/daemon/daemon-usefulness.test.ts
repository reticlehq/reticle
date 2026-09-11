/**
 * The 0.04% duty cycle, and why the existing idle-shutdown could never touch it.
 *
 * `isIdle` is `!agentConnected && sessions === 0 && pool === 0`, and an attached agent keeps
 * `agentConnected` true for a whole editor session — so a daemon spawned in a directory with no web
 * app sat there for a median of 28 minutes doing nothing, and the shutdown watcher never got a look
 * in. Measured across 98 sessions: 10,816 minutes of uptime, 4.6 minutes of work.
 *
 * These pin the conservatism. Every clause is a LIFETIME fact, because a window-based rule would
 * fire during a thinking pause and kill a daemon somebody was about to use.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  isUselessDaemon,
  buildIdlePredicate,
  noteToolCall,
  everServedToolCall,
  resetDaemonUsefulness,
} from './daemon-usefulness.js';

beforeEach(() => resetDaemonUsefulness());

describe('isUselessDaemon', () => {
  it('a daemon that has served nothing and seen nothing is useless', () => {
    expect(isUselessDaemon({ servedToolCall: false, everConnected: false, activeLeases: 0 })).toBe(
      true,
    );
  });

  it('ONE tool call, ever, makes it useful — even if nothing came of it', () => {
    expect(isUselessDaemon({ servedToolCall: true, everConnected: false, activeLeases: 0 })).toBe(
      false,
    );
  });

  it('a browser that connected once makes it useful, even after disconnecting', () => {
    // The app may reload; the daemon is the thing it reconnects TO. Killing it mid-reload would
    // turn a refresh into a lost session.
    expect(isUselessDaemon({ servedToolCall: false, everConnected: true, activeLeases: 0 })).toBe(
      false,
    );
  });

  it('an active pool lease keeps it alive — somebody is mid-flight with no session yet', () => {
    expect(isUselessDaemon({ servedToolCall: false, everConnected: false, activeLeases: 1 })).toBe(
      false,
    );
  });
});

describe('noteToolCall — the lifetime latch', () => {
  it('starts false and latches on the first call', () => {
    expect(everServedToolCall()).toBe(false);
    noteToolCall();
    expect(everServedToolCall()).toBe(true);
  });

  it('never unlatches — usefulness is not something a daemon loses', () => {
    noteToolCall();
    noteToolCall();
    expect(everServedToolCall()).toBe(true);
  });
});

/**
 * The predicate as the daemon actually wires it.
 *
 * The clause that matters is the one that was missing: an agent IS attached (so the original
 * `!agentConnected` is false) and the daemon has still never done anything. Without it the watcher
 * was unreachable for a whole editor session, which is exactly the 28-minute median with zero busy
 * time the telemetry shows.
 */
describe('buildIdlePredicate', () => {
  const sessions = (count: number, ever: boolean) => ({
    count: () => count,
    everConnected: () => ever,
  });
  const pool = (active: number) => ({ activeCount: () => active });

  it('an attached agent that has never called a tool no longer immunises the daemon', () => {
    const idle = buildIdlePredicate(() => true, sessions(0, false), pool(0));
    expect(idle()).toBe(true);
  });

  it('but one tool call keeps it alive for as long as the agent stays', () => {
    const idle = buildIdlePredicate(() => true, sessions(0, false), pool(0));
    noteToolCall();
    expect(idle()).toBe(false);
  });

  it('a connected browser keeps it alive regardless', () => {
    expect(buildIdlePredicate(() => true, sessions(1, true), pool(0))()).toBe(false);
  });

  it('a browser that connected and left keeps it alive — it is what the app reconnects TO', () => {
    expect(buildIdlePredicate(() => true, sessions(0, true), pool(0))()).toBe(false);
  });

  it('the original rule still holds: no agent, no session, no lease is idle', () => {
    expect(buildIdlePredicate(() => false, sessions(0, false), pool(0))()).toBe(true);
  });

  it('never idle while a session is connected, even with no agent attached', () => {
    expect(buildIdlePredicate(() => false, sessions(1, true), pool(0))()).toBe(false);
  });
});
