/**
 * The loop I shipped, and the rule that stops it coming back.
 *
 * Widening the idle rule so an attached-but-unused daemon can exit, while the proxy respawned on
 * every stream drop, meant the replacement daemon was just as idle — so it exited too. Measured
 * against the running system with a 4s grace: FOUR daemon processes in 200 seconds. At the shipped
 * 300s grace that is a fresh process every five minutes, for the many installs that never call a
 * tool, for as long as the editor stays open.
 *
 * Nothing in the gates could see it. Unit tests never start a daemon; the e2e battery starts one and
 * drives it immediately, so it never leaves one idle for a grace window. It took watching pids on a
 * live system. These pin the invariant so the next person does not have to.
 */

import { describe, expect, it } from 'vitest';
import {
  onStreamDrop,
  onClientRequest,
  onReconnectBudgetSpent,
  OnDrop,
  OnRequest,
} from './proxy-lifecycle.js';
import { PortPresence } from '../daemon/port-presence.js';

describe('onStreamDrop — a dropped stream is not demand', () => {
  it('reattaches when a Reticle daemon is already listening', () => {
    expect(onStreamDrop(PortPresence.DAEMON)).toBe(OnDrop.REATTACH);
  });

  it('goes DORMANT when nothing is listening — never spawns', () => {
    // The whole regression in one assertion. Spawning here is what made an idle daemon's own
    // shutdown into a permanent loop.
    expect(onStreamDrop(PortPresence.FREE)).toBe(OnDrop.DORMANT);
  });

  it('has no third answer that could smuggle a spawn back in', () => {
    for (const presence of [PortPresence.DAEMON, PortPresence.FOREIGN, PortPresence.FREE]) {
      expect([OnDrop.REATTACH, OnDrop.DORMANT]).toContain(onStreamDrop(presence));
    }
  });
});

describe('onClientRequest — demand is the only thing that starts a daemon', () => {
  it('sends straight through when connected', () => {
    expect(onClientRequest(true, false)).toBe(OnRequest.SEND);
    expect(onClientRequest(true, true)).toBe(OnRequest.SEND);
  });

  it('WAKES when dormant — this is the one path allowed to spawn', () => {
    expect(onClientRequest(false, true)).toBe(OnRequest.WAKE);
  });

  it('queues when a reconnect is already in flight, rather than spawning a second daemon', () => {
    expect(onClientRequest(false, false)).toBe(OnRequest.QUEUE);
  });
});

/**
 * The two rules together are what make the cycle impossible: the only transition that may start a
 * daemon is reachable only from a client request, so a daemon exiting can never, by itself, cause
 * another to start.
 */
describe('the pair cannot cycle', () => {
  it('no sequence of drops alone ever reaches WAKE', () => {
    const reachableFromDrops = [
      onStreamDrop(PortPresence.DAEMON),
      onStreamDrop(PortPresence.FOREIGN),
      onStreamDrop(PortPresence.FREE),
    ];
    expect(reachableFromDrops).not.toContain(OnRequest.WAKE);
    // And dormancy is terminal until a request arrives: dropping again while dormant is still not demand.
    expect(onStreamDrop(PortPresence.FREE)).toBe(OnDrop.DORMANT);
  });
});

/**
 * The MCP server must never be down. This is the rule that makes that true.
 *
 * The proxy retried a lost daemon with backoff and then, after a fixed budget, called
 * `process.exit(1)`. The comment justified it as "let the agent host respawn the proxy" — but a
 * stdio MCP server that exits is not respawned by Claude Code. It is marked disconnected, its tools
 * vanish from the session, and a HUMAN has to open /mcp and reconnect. That is the single worst
 * experience this product has, and it was a deliberate line of code.
 *
 * Exiting was never necessary either: the dormant path already handles "no daemon" perfectly — the
 * catalog cache answers `tools/list`, the handshake is answered locally, and the next client request
 * WAKES a fresh daemon. Dormant is strictly better than dead in every case exit was meant to cover.
 */
describe('onReconnectBudgetSpent — running out of retries must not end the server', () => {
  it('goes dormant rather than exiting, so the client never loses its tools', () => {
    expect(onReconnectBudgetSpent()).toBe(OnDrop.DORMANT);
  });

  /**
   * The point of the enum: DORMANT is recoverable and reachable by the WAKE path. If this ever
   * returns something that is not one of the two lifecycle answers, the proxy has grown a third
   * behaviour that no test covers — which is how the exit got in.
   */
  it('answers with a lifecycle state the wake path understands', () => {
    const answer: OnDrop = onReconnectBudgetSpent();
    expect([OnDrop.REATTACH, OnDrop.DORMANT]).toContain(answer);
    expect(onClientRequest(false, OnDrop.DORMANT === answer)).toBe(OnRequest.WAKE);
  });
});
