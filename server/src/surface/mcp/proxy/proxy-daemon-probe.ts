import * as net from 'node:net';
import { LOOPBACK_HOST } from '@reticlehq/core';
import {
  describePresence,
  presenceIsUsable,
  probePresence,
  PortPresence,
} from '@/command/daemon/binding/port-presence.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';

const DEFAULT_DAEMON_READY_TIMEOUT_MS = 10_000;
/**
 * How long to wait for the spawned daemon's port to accept connections before giving up. The default
 * suits a normal machine; a slow CI/VM (heavy headless-browser launch) can raise it via the
 * RETICLE_DAEMON_READY_TIMEOUT_MS env var. Invalid/absent values fall back to the default.
 */
const envDaemonReadyTimeoutMs = Number(process.env['RETICLE_DAEMON_READY_TIMEOUT_MS']);
const DAEMON_READY_TIMEOUT_MS =
  Number.isFinite(envDaemonReadyTimeoutMs) && envDaemonReadyTimeoutMs > 0
    ? envDaemonReadyTimeoutMs
    : DEFAULT_DAEMON_READY_TIMEOUT_MS;
const DAEMON_POLL_INTERVAL_MS = 100;
const DAEMON_POLL_MAX_INTERVAL_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function daemonPollDelayMs(attempt: number): number {
  return Math.min(DAEMON_POLL_INTERVAL_MS * attempt, DAEMON_POLL_MAX_INTERVAL_MS);
}

/**
 * Returns true if something is already listening on the reticle port.
 * Uses a plain TCP probe so we don't create a side-effectful SSE session
 * inside the daemon just to check reachability.
 *
 * `host` defaults to loopback, which is every caller's actual target — except `bootSession`
 * (reticlehq/reticle#1165 review), whose Bridge can bind a non-default host via `RETICLE_HOST`.
 * Hardcoding loopback here made that preflight check the wrong address.
 */
export function probeDaemon(port: number, host: string = LOOPBACK_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/**
 * Poll until a Reticle daemon is SERVING on `port`, or the deadline passes.
 *
 * "Accepts a TCP connection" is not the question. A daemon wedged mid-start accepts and never
 * serves, and so does a stranger holding the port — `port-presence.ts` calls both FOREIGN for
 * exactly this reason, and every other decision point in the codebase was migrated onto it. This
 * one was not, so the wake path spawned a daemon, waited on a bare connect, and dialled a corpse.
 *
 * Probes are injected (defaulting to the real pair) so the rule is testable without a socket, which
 * is the same shape `probePresence`'s own callers use.
 */
export async function waitForDaemon(
  port: number,
  probes: {
    tcpOpen: (port: number) => Promise<boolean>;
    status: (port: number) => Promise<unknown>;
  } = { tcpOpen: probeDaemon, status: fetchStatus },
): Promise<void> {
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
  let attempt = 0;
  let presence: PortPresence = PortPresence.FREE;
  while (Date.now() < deadline) {
    presence = await probePresence(port, probes);
    if (presenceIsUsable(presence)) return;
    attempt++;
    await delay(daemonPollDelayMs(attempt));
  }
  // The state we timed out in is the whole diagnosis — FREE means the daemon never came up, FOREIGN
  // means something is squatting the port. Reporting only the timeout sent readers hunting the
  // wrong one.
  throw new Error(
    `reticle daemon did not become ready on port ${String(port)} within ` +
      `${String(DAEMON_READY_TIMEOUT_MS)}ms — ${describePresence(presence, port)}`,
  );
}

/** How long a spawned daemon gets to bind before `serve`, `restart` or `init` gives up on it. */
const BIND_TIMEOUT_MS = 15_000;
const BIND_POLL_MS = 150;

/**
 * Poll until `/status` on `port` answers as a Reticle daemon; false once the bound passes.
 *
 * One rule for the three commands that start a daemon. `init` used to borrow `waitForDaemon`'s
 * shorter reconnect budget, and on a cold fresh HOME it printed "could not start the Reticle
 * daemon" over a daemon that bound seconds later. Bounded polling, never a fixed sleep.
 */
export async function waitForDaemonBind(port: number): Promise<boolean> {
  const deadline = Date.now() + BIND_TIMEOUT_MS;
  for (;;) {
    const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
    if (presence === PortPresence.DAEMON) return true;
    if (Date.now() >= deadline) return false;
    await delay(BIND_POLL_MS);
  }
}
