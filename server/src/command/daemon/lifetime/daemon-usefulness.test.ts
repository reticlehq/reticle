/**
 * Daemons that lived for hours and worked for minutes, and why the existing idle-shutdown could
 * never touch them.
 *
 * `isIdle` is `!agentConnected && sessions === 0 && pool === 0`, and an attached agent keeps
 * `agentConnected` true for a whole editor session — so a daemon spawned in a directory with no web
 * app sat there doing nothing for as long as the editor stayed open, and the shutdown watcher never
 * got a look in. Across a run of sessions the uptime was orders of magnitude larger than the work.
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
  noteSetupHold,
  SETUP_HOLD_MS,
  noteAgentPresence,
} from './daemon-usefulness.js';
import { IdleShutdown } from '../idle-shutdown.js';
import { SESSION_LIFECYCLE } from '@reticlehq/core';

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
 * was unreachable for a whole editor session, which is exactly the long idle with zero busy
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

  // init started this daemon, then waited on a cold desktop build for longer than the idle grace;
  // the daemon exited (`reticle_daemon_idle_exit`) while init was still waiting on it to be dialled.
  it('is never idle while a setup run is holding it, and is again once the hold lapses', () => {
    let now = 1_000;
    const idle = buildIdlePredicate(
      () => false,
      sessions(0, false),
      pool(0),
      () => now,
    );
    noteSetupHold(now);
    expect(idle()).toBe(false);
    now += SETUP_HOLD_MS;
    expect(idle()).toBe(true);
  });

  it('never idle while a session is connected, even with no agent attached', () => {
    expect(buildIdlePredicate(() => false, sessions(1, true), pool(0))()).toBe(false);
  });

  // A client that starts a new MCP proxy for each turn (Codex) detaches between turns. The daemon
  // saw no agent, exited after 5 minutes, and the next turn waited for a cold start.
  it('keeps a used daemon up between the turns of a client that detaches after each turn', () => {
    let now = 1_000_000;
    let attached = true;
    noteToolCall();
    noteAgentPresence(now);
    const idle = buildIdlePredicate(
      () => attached,
      sessions(0, true),
      pool(0),
      () => now,
    );
    let exited = false;
    const watcher = new IdleShutdown({
      graceMs: SESSION_LIFECYCLE.DAEMON_IDLE_SHUTDOWN_MS,
      isIdle: idle,
      agentAttached: () => attached,
      clock: () => now,
      onShutdown: () => {
        exited = true;
      },
    });
    attached = false;
    noteAgentPresence(now);
    for (let minute = 0; minute < 6; minute += 1) {
      now += 60_000;
      watcher.check();
    }
    expect(exited).toBe(false);
    attached = true;
    noteAgentPresence(now);
    watcher.check();
    expect(exited).toBe(false);
  });

  it('still exits once no agent has attached for the whole recent window', () => {
    let now = 1_000_000;
    noteToolCall();
    noteAgentPresence(now);
    const idle = buildIdlePredicate(
      () => false,
      sessions(0, true),
      pool(0),
      () => now,
    );
    now += SESSION_LIFECYCLE.DAEMON_AGENT_RECENT_MS;
    expect(idle()).toBe(true);
  });
});
