/**
 * What holds the bridge port, said the same way by every surface (#1937).
 *
 * A Reticle daemon stuck in its exit held the port and answered nothing. `status` called the port
 * free, the MCP proxy called the holder "not a Reticle daemon", and `restart` refused to stop it.
 * The pid file did not name it, because the next start had replaced that file. Its command line
 * still did.
 */

import {
  captureLookup,
  describeForeignHolder,
  findPortHolder,
  type PortHolder,
} from '@/command/cli/ports/port-holder.js';
import { describePresence, PortPresence } from './binding/port-presence.js';
import { isReticleDaemonCommand } from './daemon-argv.js';
import { readPid } from './daemon.js';

/** The listener on `port`, and whether its command line is a Reticle daemon's. */
export function identifyPortHolder(
  port: number,
  exec: (command: string, args: readonly string[]) => string | null,
): PortHolder | null {
  const holder = findPortHolder(port, exec);
  if (null === holder) {
    return null;
  }
  const commandLine = exec('ps', ['-o', 'command=', '-p', String(holder.pid)]);
  return {
    ...holder,
    reticleDaemon: null !== commandLine && isReticleDaemonCommand(commandLine),
  };
}

/** The sentence for the state of `port`, with the holder named when something holds it. */
export function describePortState(presence: PortPresence, port: number): string {
  if (PortPresence.FOREIGN !== presence) {
    return describePresence(presence, port);
  }
  return describeForeignHolder(port, identifyPortHolder(port, captureLookup), readPid(port));
}
