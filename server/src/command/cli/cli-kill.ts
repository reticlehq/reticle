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

import {
  PortPresence,
  probePresence,
  probePresenceWithStatus,
} from '@/command/daemon/binding/port-presence.js';
import { isAlive, readPid, removePid } from '@/command/daemon/daemon.js';
import { probeDaemon } from '@/surface/mcp/mcp-proxy.js';
import { log } from '@/log.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { captureLookup, findPortHolder, type PortHolder } from './ports/port-holder.js';

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
  /** Whether the user has requested to force the kill. */
  force: boolean;
}): KillPlan {
  const { listener, recordedPid, answersStatus, force } = input;
  if (null === listener) {
    // When the listener lookup is unavailable, /status can confirm that the port belongs to Reticle,
    // but without a trusted process id there is no safe process to terminate.
    if (null !== recordedPid) {
      return {
        action: KillAction.KILL,
        pid: recordedPid,
        forced: false,
        identifiedListener: false,
      };
    }

    // The port is known to be a Reticle daemon, but without a pid there is no safe process to kill.
    if (answersStatus) {
      return {
        action: KillAction.REFUSE,
        forced: false,
        identifiedListener: false,
        reason: PID_UNKNOWN_REFUSAL_REASON,
      };
    }

    return {
      action: KillAction.NOTHING,
      forced: false,
      identifiedListener: false,
    };
  }
  const ours = answersStatus || listener.pid === recordedPid;
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
      `be killing someone else's process. Run it again with ${FORCE_FLAG} if that is what you ` +
      `meant, or start Reticle on another port.`,
  };
}

/** How long the target gets to exit on SIGTERM before we stop asking politely. */
const GRACEFUL_KILL_MS = 5_000;
/** How long after SIGKILL before we accept the process is not ours to kill and say so. */
const FORCED_KILL_MS = 2_000;
const KILL_POLL_MS = 100;

/**
 * Signal ONE pid and wait for it to go: SIGTERM, then SIGKILL, then give up and say it survived.
 *
 * The escalation is the reason this exists rather than a bare SIGTERM — there is a field report of a
 * daemon that ignored SIGTERM until a human ran `kill -9` by hand, which is the moment the `lsof -ti`
 * pipeline gets typed and the agent's proxy dies with the daemon.
 */
async function terminate(
  pid: number,
  kill: (pid: number, signal: NodeJS.Signals) => void = (targetPid, signal) =>
    process.kill(targetPid, signal),
): Promise<{ gone: boolean; escalated: boolean }> {
  const signal = (name: NodeJS.Signals): void => {
    try {
      kill(pid, name);
    } catch {
      // Gone between the liveness check and here. The next poll reports it as gone.
    }
  };
  signal('SIGTERM');
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
const PID_UNKNOWN_REFUSAL_REASON =
  'The port answers /status as a Reticle daemon, but Reticle could not determine its pid. ' +
  'Refusing to report success because the daemon is still running.';

const PID_SURVIVED_KILL_NOTE = (pid: number): string =>
  `pid ${String(pid)} survived SIGKILL, so it is not yours to kill (permissions) or is an ` +
  `unkillable zombie. The port is still held. ${PROXY_SPARED_NOTE}`;

const PID_EXITED_PORT_HELD_NOTE = (pid: number): string =>
  `pid ${String(pid)} exited, but the port is still held. ${PROXY_SPARED_NOTE}`;

/** `reticle kill` — free the port. Resolves to whether the port is now free. */
export async function runKill(
  port: number,
  force: boolean,
  terminateProcess: typeof terminate = terminate,
): Promise<boolean> {
  const probe = await probePresenceWithStatus(port, {
    tcpOpen: probeDaemon,
    status: fetchStatus,
  });
  const { presence } = probe;
  const recorded = readPid(port);
  const plan = planKill({
    listener: findPortHolder(port, captureLookup),
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

  const { gone, escalated } = await terminateProcess(pid);

  if (!gone) {
    log('reticle_kill_survived', {
      port,
      pid,
      escalated,
      ...(plan.forced ? { forced: true } : {}),
      // Say whether the process was identified by the OS as the listener or came from
      // Reticle's recorded pid.
      // observed listening, and those are different claims.
      listenerIdentified: plan.identifiedListener,
      note: PID_SURVIVED_KILL_NOTE(pid),
    });
    return false;
  }

  // A dead process does not by itself prove that the port is free. Another process may still
  // hold the port, so verify the port state before reporting a successful kill.
  const remainingPresence = await probePresence(port, {
    tcpOpen: probeDaemon,
    status: fetchStatus,
  });

  if (remainingPresence !== PortPresence.FREE) {
    log('reticle_kill_survived', {
      port,
      pid,
      escalated,
      ...(plan.forced ? { forced: true } : {}),
      listenerIdentified: plan.identifiedListener,
      note: PID_EXITED_PORT_HELD_NOTE(pid),
    });
    return false;
  }

  removePid(port);

  log('reticle_killed', {
    port,
    pid,
    escalated,
    ...(plan.forced ? { forced: true } : {}),
    // Say where the pid came from. Without `lsof` this is the pid we recorded, not the pid we
    // observed listening, and those are different claims.
    listenerIdentified: plan.identifiedListener,
    note: PROXY_SPARED_NOTE,
  });

  return true;
}
