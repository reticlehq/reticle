/**
 * A port that accepts a socket is not a daemon, and the proxy's drop path treated the two as one.
 *
 * `probePresence` exists precisely because "is something listening" and "is a Reticle daemon
 * listening" are different questions, and answering the first while asking the second is what made
 * `reticle status` claim `running: false` about a port a stranger held. Every human-facing command
 * was converted to it. The proxy's reconnect probe was not: it asked `probeDaemon`, a bare TCP
 * connect, and fed the boolean into `onStreamDrop` under the name `daemonListening`.
 *
 * Measured against a plain HTTP server on the bridge port: the proxy reattached, the stream ended
 * immediately, it reattached again, and it kept doing that — nineteen reconnects in forty-eight
 * seconds, each one logged as `reticle_mcp_proxy_reconnected`. Meanwhile `reticle doctor` on the same
 * machine, at the same moment, named the holding pid and told the user exactly what to do.
 *
 * A FOREIGN holder is the one case where reattaching cannot ever work: a daemon cannot bind the port,
 * and the thing that holds it does not speak SSE. Going dormant is what lets the next client request
 * re-probe — and, unlike the spin, it lets the honest sentence reach the agent.
 */

import { describe, expect, it } from 'vitest';
import { OnDrop, onStreamDrop } from './proxy-lifecycle.js';
import { PortPresence } from '../daemon/port-presence.js';

describe('what the proxy does with the port after a drop', () => {
  it('reattaches only to a port that answered as a Reticle daemon', () => {
    expect(onStreamDrop(PortPresence.DAEMON)).toBe(OnDrop.REATTACH);
  });

  it('goes dormant when nothing is listening', () => {
    expect(onStreamDrop(PortPresence.FREE)).toBe(OnDrop.DORMANT);
  });

  it('does not reattach to a stranger holding the port', () => {
    // The spin. TCP-open said "a daemon is there", the stranger ended every stream, and the proxy
    // retried forever without once being able to say what was actually on the port.
    expect(onStreamDrop(PortPresence.FOREIGN)).toBe(OnDrop.DORMANT);
  });
});
