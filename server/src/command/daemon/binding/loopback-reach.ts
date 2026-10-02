/**
 * Which of `localhost`'s two answers can actually reach the bridge.
 *
 * `localhost` is a name with two answers, and Windows Chrome tries the IPv6 one first. The daemon
 * binds `127.0.0.1`, so `loopback-alias.ts` forwards `[::1]:port` to it — best-effort by contract,
 * because a machine with IPv6 off or something already holding `[::1]:port` must not stop the daemon
 * serving. When that alias does not open, the daemon is serving perfectly on IPv4 and the page's
 * documented default URL cannot reach it. The daemon's own view is "the bridge was up for the whole
 * window", and it is right.
 *
 * Nothing said which half was missing. The one record was a field on the `mcp_daemon_started` log
 * line, so the condition that makes `localhost` unreachable on the platform with most of our
 * installs was invisible unless somebody read the daemon's JSON. The install gate's Windows cell
 * reports exactly this shape — `init` exits 1 with "the SDK IS in the page and never dialled", while
 * the page's own console says it could not open a websocket to `ws://localhost:<port>` after three
 * attempts, and the very next boot of the same scaffold connects — and none of the three causes that
 * diagnosis offers is this one.
 *
 * This answers it by connecting, at the moment of the diagnosis, rather than by remembering what
 * happened at startup: a probe is true about now, and a startup flag is true about startup.
 */

import net from 'node:net';
import { LOOPBACK_HOST } from '@reticlehq/core';
import { IPV6_LOOPBACK } from './loopback-alias.js';

/** Long enough for a loopback TCP handshake, short enough to sit inside a diagnosis. */
const REACH_TIMEOUT_MS = 500;

/** Which loopback addresses answered on the bridge port. */
export interface LoopbackReach {
  /** `127.0.0.1` answered — what the daemon binds. */
  readonly v4: boolean;
  /** `[::1]` answered — what `localhost` resolves to first on Windows. */
  readonly v6: boolean;
}

/** Can a TCP connection be opened to this address and port at all. */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(REACH_TIMEOUT_MS, () => settle(false));
    socket.once('connect', () => settle(true));
    // Refused, unreachable, IPv6 disabled entirely — all of them are "this address does not answer",
    // which is the only question being asked. An unhandled 'error' here would take down the caller.
    socket.once('error', () => settle(false));
  });
}

/**
 * Probe both halves of loopback on the bridge port.
 *
 * Both are attempted even when the first answers: the interesting result is the DISAGREEMENT, and
 * learning that v4 works tells you nothing about the address the browser will actually pick.
 */
export async function probeLoopbackReach(port: number): Promise<LoopbackReach> {
  const [v4, v6] = await Promise.all([
    canConnect(LOOPBACK_HOST, port),
    canConnect(IPV6_LOOPBACK, port),
  ]);
  return { v4, v6 };
}

/**
 * True when the bridge is reachable as an IPv4 address and NOT as the name the SDK is told to dial.
 *
 * This is the whole condition worth naming. Both up is healthy; both down is an ordinary "the daemon
 * is not there" that every other check already reports; v6-only cannot happen on a `127.0.0.1` bind.
 */
export function isLocalhostSplit(reach: LoopbackReach): boolean {
  return reach.v4 && !reach.v6;
}
