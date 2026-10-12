/**
 * The bridge port, checked before the connect wait.
 *
 * The bridge is the channel between the daemon and the SDK in the page. While something else holds
 * that port no session can ever appear, however correct the instrumentation is — so a run that goes
 * ahead spends its entire connect budget and then reports what looks like a wiring problem, sending
 * the reader to the one place that is fine.
 *
 * `serve` refuses a held port too, in prose written for somebody starting a daemon. This is the same
 * fact told to somebody installing, and it has to say what the bridge IS: that sentence is what
 * makes "no session appeared" mean something.
 */
import { PortPresence } from '@/command/daemon/binding/port-presence.js';

/** The refusal to print, or undefined when the port is usable. */
export function bridgeOccupied(
  presence: PortPresence,
  port: number,
  freePort?: number,
): string | undefined {
  // DAEMON is the ordinary case — that is the daemon init is about to use. FREE is fine too: one
  // gets started. Only a stranger is fatal.
  if (PortPresence.FOREIGN !== presence) return undefined;
  return (
    `port ${String(port)} is held by something that is not a Reticle daemon. That is the bridge — ` +
    'the channel between the daemon and the SDK in your page — so no session can ever appear while ' +
    'it is occupied, however correct the wiring is. Free it, or re-run on another port (init moves ' +
    `the config and the page with it): reticle init --port ${freePort === undefined ? '<n>' : String(freePort)}`
  );
}

/** How many ports past the held one are tried before giving up on a suggestion. */
const FREE_PORT_SCAN = 20;

/** The first port after `port` that nothing answers on, or undefined within the scan. */
export async function freePortAfter(
  port: number,
  isOpen: (port: number) => Promise<boolean>,
): Promise<number | undefined> {
  for (let candidate = port + 1; candidate <= port + FREE_PORT_SCAN; candidate++) {
    if (!(await isOpen(candidate))) return candidate;
  }
  return undefined;
}
