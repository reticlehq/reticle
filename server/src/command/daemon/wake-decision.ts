/**
 * What a woken MCP proxy may do with whatever is sitting on its port.
 *
 * Pulled out as a pure function because the wake path lives inside a long side-effecting closure in
 * `mcp-command.ts`, and the decision it was getting wrong is three lines of reasoning that deserve a
 * test of their own.
 *
 * `resolveMcpPort` asks the identity question at BOOT and relocates rather than adopting a stranger.
 * The wake path asked only whether a daemon answered, so after an idle exit freed the port and
 * another project's daemon bound it, a dormant proxy could reattach to a daemon that was not its
 * own — and then serve an agent verdicts about a different application. `adoptable` is the same rule
 * boot uses; this is just the wake path finally asking it.
 */

import { PortPresence } from './binding/port-presence.js';
import { join } from 'node:path';
import { adoptable } from './daemon-resolve.js';

export const WakeAction = {
  /** A daemon we may use is already here. */
  USE: 'use',
  /** Nothing is listening: start one. */
  SPAWN: 'spawn',
  /** Somebody else's. Go dormant with a reason rather than pretend the wake succeeded. */
  REFUSE: 'refuse',
} as const;
export type WakeAction = (typeof WakeAction)[keyof typeof WakeAction];

/**
 * Identity is asked only of a port that actually holds a daemon.
 *
 * A FREE port must stay spawnable whatever the registry says about it, because a stale entry is the
 * registry's ordinary state for the moment after any daemon exits — and refusing there would turn
 * every idle retirement into a permanent lockout, which is the failure this whole path exists to
 * prevent.
 */
export function decideWake(
  presence: PortPresence,
  daemonProjectId: string | undefined,
  callerProjectId: string | undefined,
  /** The daemon runs inside the caller's project folder: see `daemonInsideProject`. */
  daemonInside = false,
): WakeAction {
  if (PortPresence.FREE === presence) {
    return WakeAction.SPAWN;
  }
  if (PortPresence.DAEMON !== presence) {
    return WakeAction.REFUSE;
  }
  return adoptable(daemonProjectId, callerProjectId, daemonInside)
    ? WakeAction.USE
    : WakeAction.REFUSE;
}

/** What the refusal knows about the two sides. */
export interface OtherProjectSides {
  port: number;
  /** The project the agent's `.reticle.json` names. */
  callerProjectId: string | undefined;
  /** The folder that holds that `.reticle.json`, when it was found. */
  callerConfigDir?: string | undefined;
  /** The project the daemon on the port serves, and the folder it was started for. */
  daemonProjectId?: string | undefined;
  daemonCwd?: string | undefined;
}

/**
 * Why a proxy will not use the daemon on its port, with both sides named and the two ways out.
 *
 * Reported from the field: after `init` wired a monorepo app, the agent's proxies at the repo root
 * refused every call with "belongs to a different project ... start this project on its own port".
 * The root's `.reticle.json` named another project. The refusal was right, and it named neither
 * side, so the agent wrote its own HTTP client to get past it.
 */
export function otherProjectRefusal(sides: OtherProjectSides): string {
  const mine =
    sides.callerProjectId === undefined ? 'another project' : `"${sides.callerProjectId}"`;
  const config =
    sides.callerConfigDir === undefined
      ? '.reticle.json'
      : join(sides.callerConfigDir, '.reticle.json');
  if (sides.daemonProjectId === undefined || sides.daemonCwd === undefined) {
    return (
      `the daemon on port ${String(sides.port)} serves a different project than ${config} names (${mine}), ` +
      'so this agent will not use it: its tabs are another app. Stop it with `reticle stop`, or start ' +
      'this project on its own port.'
    );
  }
  return (
    `the daemon on port ${String(sides.port)} serves project "${sides.daemonProjectId}" (started for ` +
    `${sides.daemonCwd}), and ${config} names project ${mine}. This agent will not use it: its tabs ` +
    `are another app. To verify that app, run the agent from ${sides.daemonCwd}, or copy ` +
    `${join(sides.daemonCwd, '.reticle.json')} to ${config}. To keep ${mine}, stop that daemon with ` +
    '`reticle stop`, or give one of the apps its own port.'
  );
}
