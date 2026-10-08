/**
 * Is a leased tab usable right now? The checks `reticle_lease` runs before it may say `ready: true`.
 * Presence in the sessions map is not enough: the tab has to answer, and it has to be visible.
 */

import { ReticleCommand } from '@reticlehq/core';

/**
 * How long a liveness probe waits for the tab to say anything at all.
 *
 * Short on purpose. This is not "finish the work", it is "are you there" — a page executing
 * JavaScript answers a no-argument command in single-digit milliseconds, and a wedged one is not
 * going to answer in two seconds either.
 */
const LEASE_PROBE_TIMEOUT_MS = 1_500;

/** The narrow slice of a session the probe needs. Anything that quacks like this works. */
interface ProbeableSession {
  command?: (name: string, args: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
}

/**
 * Did the SDK report its tab hidden? A hidden tab answers commands while its timers and rAF are
 * throttled, so a lease on it is `ready` by every other test and verifies nothing (#1351).
 *
 * Known gap: this reads the last PAGE_HEALTH, which lands just after HELLO — a check in that gap sees the
 * default `false`. The pool foregrounding the page is what covers the gap; this catches the rest.
 */
export function tabHidden(session: unknown): boolean {
  return (
    null !== session &&
    'object' === typeof session &&
    true === (session as { info?: () => { hidden?: unknown } }).info?.().hidden
  );
}

/**
 * Does this tab still answer?
 *
 * PRESENCE IS NOT LIVENESS. The sessions map still holds a tab that is attached, streaming events,
 * and answering nothing, so `ready` read off a row in that map hands back a lease that `snapshot`,
 * `state` and `console` then reject (#692). It has to mean the tab replied.
 *
 * ANY reply counts, including one that reports the command failed. The question is whether the SDK
 * answers at all, not what it says — so an SDK too old to know the command replies
 * `unknown command '…'`, and that is proof. Only the absence of a reply is evidence of absence:
 * `PendingCommands.track` REJECTS on timeout and on a dropped socket, and resolves on every real
 * answer, so the two cases are already separated for us.
 *
 * `CAPABILITIES` is the probe because it takes no arguments and returns a small fixed list. No new
 * wire command is introduced: this rides an existing round trip.
 *
 * Fails OPEN. A registry entry with no `command` is a shape this code did not put there, and
 * turning a lease that works into a refusal over a probe that could not run would be a worse
 * failure than the one being fixed.
 */
export async function probeLeaseAlive(
  session: ProbeableSession | undefined,
  timeoutMs: number = LEASE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const send = session?.command;
  if (send === undefined) return true;
  try {
    await send.call(session, ReticleCommand.CAPABILITIES, {}, timeoutMs);
    return true;
  } catch {
    return false;
  }
}
