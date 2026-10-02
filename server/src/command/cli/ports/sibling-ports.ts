/**
 * Well-known Reticle ports other than the one this daemon bound.
 *
 * The remaining half of #261: when the SDK dials 4460 and we listen on 4400, we cannot see the
 * refused inbound — but we CAN notice that a well-known Reticle port other than ours has a
 * listener. That is an observation, not a diagnosis. A neighbour's daemon, another project, or an
 * unrelated process on 4460 all look identical from here, so the sentence that reports it must not
 * conclude that it is the daemon this app wants. Maintainer constraint on the issue: report the
 * observation without the conclusion.
 */

import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';

/**
 * The port the bench fixture's SDK dials.
 *
 * Deliberate, and must not be "fixed" onto the default: `bench/harness/ports.mjs` documents a past
 * incident caused by having more than one source of truth for it. It exists so a default daemon on
 * 4400 and a bench run never collide. Doctor and the no-session diagnosis probe it as a sibling
 * of 4400 for that reason — it is the port the original silent no-connect was on.
 */
export const RETICLE_BENCH_PORT = 4460;

/** Ports a Reticle daemon is known to occupy. Probe every one except the port we ourselves bound. */
export const WELL_KNOWN_RETICLE_PORTS: readonly number[] = [
  RETICLE_DEFAULT_PORT,
  RETICLE_BENCH_PORT,
];

/** Well-known Reticle ports other than `boundPort`. Empty when we are the only well-known occupant. */
export function siblingPorts(
  boundPort: number,
  known: readonly number[] = WELL_KNOWN_RETICLE_PORTS,
): readonly number[] {
  return known.filter((port) => port !== boundPort);
}

/**
 * One sentence for a listener on a sibling Reticle port. `undefined` when there is nothing to say.
 *
 * Wording is load-bearing: it names the observation and refuses the conclusion. A test pins that it
 * does not claim the listener is the daemon this app wants, or that the SDK is dialling it.
 */
export function siblingListenerNote(
  boundPort: number,
  occupiedSiblings: readonly number[],
): string | undefined {
  if (0 === occupiedSiblings.length) return undefined;
  const listed = occupiedSiblings.map((port) => `:${String(port)}`).join(', ');
  return (
    `something is listening on ${listed}, which this daemon is not` +
    ` (this daemon is on :${String(boundPort)}); that may or may not be related.`
  );
}

/**
 * Which well-known siblings currently accept a TCP connection.
 *
 * Pure in the rule, impure at the edge: `isListening` is injected so this can be tested without a
 * socket, and so a lying probe is a separate failure from a lying sentence.
 */
export async function findOccupiedSiblings(
  boundPort: number,
  isListening: (port: number) => Promise<boolean>,
): Promise<readonly number[]> {
  const occupied: number[] = [];
  for (const port of siblingPorts(boundPort)) {
    if (await isListening(port)) occupied.push(port);
  }
  return occupied;
}
