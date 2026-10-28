/**
 * `reticle kill` — free the bridge port without taking the agent's transport with it.
 *
 * The obvious incantation, `lsof -ti tcp:4400 | xargs kill -9`, also kills `reticle mcp`: the proxy
 * holds a CLIENT socket on that port, `-ti` does not filter to listeners, and so the one command
 * people reach for when the bridge is stuck destroys the channel they were trying to fix. What
 * follows is worse than an error — the client gets no reply at all, and nothing reaches the proxy log
 * because the process that writes it is the one that died. That is the mechanism behind most
 * "my MCP disconnected" reports (#114, #110).
 *
 * The safe form was written down, and a documented incantation is a worse answer than a command: it
 * has to be found, remembered, and typed correctly at the moment someone is already stuck. So this is
 * the command, and it signals exactly one pid — the LISTENER.
 *
 * It is not a rename of `stop`. `stop` reads the pid file, which is the right source when the daemon
 * we started is the daemon that is wedged, and no source at all when the pid file is stale, was never
 * written, or belongs to a daemon from another checkout. `kill` asks the PORT, which is the thing the
 * user actually wants freed, and falls back to the pid file only where the lookup cannot run.
 */

import { PortPresence, probePresence } from '@/command/daemon/binding/port-presence.js';
import { isAlive, readPid, removePid } from '@/command/daemon/daemon.js';
import { probeDaemon } from '@/surface/mcp/mcp-proxy.js';
import { log } from '@/log.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { captureLookup, type PortHolder } from './ports/port-holder.js';
import { identifyPortHolder } from '@/command/daemon/port-state.js';
import * as http from 'node:http';
import { LOOPBACK_HOST, SHUTDOWN_PATH } from '@reticlehq/core';
import { storedPairingToken } from '@/portal/bridge/pairing-token.js';

/** What the plan says to do with the port. */
export const KillAction = {
  NOTHING: 'nothing',
  KILL: 'kill',
  REFUSE: 'refuse',
} as const;
export type KillAction = (typeof KillAction)[keyof typeof KillAction];

interface KillPlan {
  action: KillAction;
  /** The single pid to signal. Present only for `kill`. */
  pid?: number;
  /** True when the target was not identifiable as Reticle's and `--force` overrode the refusal. */
  forced: boolean;
  /** False when the listener lookup could not run, so the pid came from our own records instead. */
  identifiedListener: boolean;
  /** Why we will not act, for `refuse`. */
  reason?: string;
  holder?: PortHolder;
}

export const FORCE_FLAG = '--force';

/**
 * Decide what to signal. Pure.
 *
 * `answersStatus` is the strongest evidence available and deliberately outranks the pid file: a
 * daemon started from another checkout owns the port, is a Reticle daemon, and appears nowhere in our
 * records. Refusing it would leave the port held by exactly the process this command exists to clear.
 */
export function planKill(input: {
  /** The listener on the port, from a `-sTCP:LISTEN` lookup. Null when there is none, or no `lsof`. */
  listener: PortHolder | null;
  /** The pid our records hold for this port, or null when there is none or it is dead. */
  recordedPid: number | null;
  /** Whether the port answers `/status`, i.e. whatever holds it is a Reticle daemon. */
  answersStatus: boolean;
  force: boolean;
}): KillPlan {
  const { listener, recordedPid, answersStatus, force } = input;
  if (null === listener) {
    // No listener identified. On Windows and in slim containers that means the lookup could not run
    // rather than that the port is free, so the recorded pid is the best target we have — and the
    // report says which of the two it is rather than implying a lookup we never made.
    if (null === recordedPid)
      return { action: KillAction.NOTHING, forced: false, identifiedListener: false };
    return { action: KillAction.KILL, pid: recordedPid, forced: false, identifiedListener: false };
  }
  // `reticleDaemon`: its command line says so, though it answers nothing and no pid file names it.
  const ours = answersStatus || listener.pid === recordedPid || true === listener.reticleDaemon;
  if (ours || force) {
    return {
      action: KillAction.KILL,
      pid: listener.pid,
      forced: !ours,
      identifiedListener: true,
      holder: listener,
    };
  }
  return {
    action: KillAction.REFUSE,
    forced: false,
    identifiedListener: true,
    holder: listener,
    reason:
      `pid ${String(listener.pid)} ("${listener.command}") is listening, and it is not a Reticle ` +
      `daemon — it never answered /status and it is not the pid Reticle recorded. Killing it would ` +
      `be killing someone else's process. If that is what you meant, \`reticle restart ${FORCE_FLAG}\` ` +
      `stops it and starts Reticle there (\`stop ${FORCE_FLAG}\` never does); or start Reticle on ` +
      `another port.`,
  };
}

/** How long the target gets to exit on SIGTERM before we stop asking politely. */
const GRACEFUL_KILL_MS = 5_000;
/** How long after SIGKILL before we accept the process is not ours to kill and say so. */
const FORCED_KILL_MS = 2_000;
const KILL_POLL_MS = 100;

/** A loopback call: a daemon that does not answer in this time gets the signal instead. */
const SHUTDOWN_REQUEST_TIMEOUT_MS = 1_000;

/**
 * Ask the daemon on `port` to run its own shutdown path. True when it accepted.
 *
 * Asked before any signal, on every OS. On Windows a signal ends the process at once, so the daemon
 * did not close its browser or send its stop event. False for an older daemon without the route, a
 * wrong token, or no answer: the caller then sends the signal as before.
 */
export function requestShutdown(
  port: number,
  token: string | undefined = storedPairingToken(),
): Promise<boolean> {
  if (token === undefined) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: LOOPBACK_HOST,
        port,
        path: SHUTDOWN_PATH,
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        timeout: SHUTDOWN_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve(202 === res.statusCode);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Signal ONE pid and wait for it to go: SIGTERM, then SIGKILL, then give up and say it survived.
 * `asked`: the daemon already accepted a shutdown request, so the SIGTERM is not sent.
 *
 * The escalation is the reason this exists rather than a bare SIGTERM — there is a field report of a
 * daemon that ignored SIGTERM until a human ran `kill -9` by hand, which is the moment the `lsof -ti`
 * pipeline gets typed and the agent's proxy dies with the daemon.
 */
async function terminate(
  pid: number,
  asked = false,
): Promise<{ gone: boolean; escalated: boolean }> {
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(pid, name);
    } catch {
      // Gone between the liveness check and here. The next poll reports it as gone.
    }
  };
  if (!asked) {
    signal('SIGTERM');
  }
  const started = Date.now();
  let escalated = false;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS));
    if (!isAlive(pid)) return { gone: true, escalated };
    const waited = Date.now() - started;
    if (!escalated && waited > GRACEFUL_KILL_MS) {
      escalated = true;
      signal('SIGKILL');
      continue;
    }
    if (waited > GRACEFUL_KILL_MS + FORCED_KILL_MS) return { gone: false, escalated };
  }
}

/**
 * What was NOT touched, said out loud on every kill.
 *
 * The command exists because of a pipeline that killed more than the reader intended and never told
 * them, so a report that lists only the casualty repeats half the mistake. An `reticle mcp` proxy on
 * this port survives, and its own recovery from a dead daemon is good: it goes dormant and restarts
 * one on the next request.
 */
const PROXY_SPARED_NOTE =
  'only the listener was signalled. Any `reticle mcp` proxy on this port holds a client connection, ' +
  'not the port, and was left alone — it goes dormant and starts a fresh daemon on the next tool call.';

/**
 * How long a daemon that holds the port gets to answer before it counts as stuck. A daemon that has
 * just bound answers in far less, so a second look after this does not stop one that is starting.
 */
const WEDGED_GRACE_MS = 2_000;

/**
 * How long the second look waits for `/status`. The usual probe gives up after 1 second, and on a
 * busy machine a healthy daemon took longer than that. A daemon that answers slowly is busy, not
 * stuck, and other agents can use it.
 */
export const WEDGED_STATUS_TIMEOUT_MS = 10_000;

/**
 * Stop a Reticle daemon that holds `port` and does not answer. True when it stopped one (#1937).
 *
 * The MCP proxy used to move to another port when it found one. The app's SDK dials the old port,
 * so the new daemon got no page. Stopping the stuck daemon keeps the port the app dials. The holder
 * must have a Reticle daemon's command line, so a stranger and the proxy itself are never signalled.
 */
export async function stopWedgedDaemon(
  port: number,
  deps: {
    /** `statusTimeoutMs`: how long to wait for `/status`. Absent: the usual short probe. */
    presence: (statusTimeoutMs?: number) => Promise<PortPresence>;
    holder: () => PortHolder | null;
    kill: () => Promise<boolean>;
    wait: (ms: number) => Promise<void>;
  } = {
    presence: (statusTimeoutMs) =>
      probePresence(port, {
        tcpOpen: probeDaemon,
        status: (p) => fetchStatus(p, LOOPBACK_HOST, false, statusTimeoutMs),
      }),
    holder: () => identifyPortHolder(port, captureLookup),
    kill: () => runKill(port, false),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<boolean> {
  if (PortPresence.FOREIGN !== (await deps.presence())) {
    return false;
  }
  const holder = deps.holder();
  if (true !== holder?.reticleDaemon) {
    return false;
  }
  await deps.wait(WEDGED_GRACE_MS);
  if (PortPresence.FOREIGN !== (await deps.presence(WEDGED_STATUS_TIMEOUT_MS))) {
    return false;
  }
  log('reticle_wedged_daemon_stopping', { port, pid: holder.pid });
  return deps.kill();
}

/** `reticle kill` — free the port. Resolves to whether the port is now free. */
export async function runKill(port: number, force: boolean): Promise<boolean> {
  const presence = await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus });
  const recorded = readPid(port);
  const plan = planKill({
    listener: identifyPortHolder(port, captureLookup),
    recordedPid: null !== recorded && isAlive(recorded) ? recorded : null,
    answersStatus: presence === PortPresence.DAEMON,
    force,
  });
  if (KillAction.NOTHING === plan.action) {
    removePid(port);
    log('reticle_kill_nothing_to_do', { port, presence });
    return true;
  }
  if (KillAction.REFUSE === plan.action) {
    log('reticle_kill_refused', { port, reason: plan.reason, holder: plan.holder?.command });
    return false;
  }
  const pid = plan.pid;
  if (pid === undefined) {
    // Unreachable by construction (planKill never returns KILL without a pid, and a test pins that),
    // but the alternative to this branch is a non-null assertion, which this codebase does not use.
    log('reticle_kill_nothing_to_do', { port, presence });
    return true;
  }
  const asked = PortPresence.DAEMON === presence && (await requestShutdown(port));
  const { gone, escalated } = await terminate(pid, asked);
  if (gone) removePid(port);
  log(gone ? 'reticle_killed' : 'reticle_kill_survived', {
    port,
    pid,
    escalated,
    ...(plan.forced ? { forced: true } : {}),
    // Say where the pid came from. Without `lsof` this is the pid we recorded, not the pid we
    // observed listening, and those are different claims.
    listenerIdentified: plan.identifiedListener,
    note: gone
      ? PROXY_SPARED_NOTE
      : `pid ${String(pid)} survived SIGKILL, so it is not yours to kill (permissions) or is an ` +
        `unkillable zombie. The port is still held. ${PROXY_SPARED_NOTE}`,
  });
  return gone;
}
