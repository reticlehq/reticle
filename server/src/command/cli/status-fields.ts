import { statusNextAction } from './answers/status-next-action.js';
import {
  daemonsServingProjectElsewhere,
  resolveDaemonForProject,
  splitBrainNote,
  wrongDaemonNote,
} from '../daemon/daemon-resolve.js';
import { isAlive, reticleStateHome } from '../daemon/daemon.js';
import { hasProjectConnectedBefore } from '../../memory/recall/prior/connection-memory.js';

/**
 * The two optional blocks `status` adds to its payload, out of cli.ts because that file hit the
 * 1000-line cap and the rule is to split rather than raise it.
 *
 * They belong together: both answer "is there anything else the reader needs to know", both are
 * absent when the answer is no, and both are the reason a healthy `status` reads as healthy.
 */

/** `{ nextAction }` when there is one, `{}` when a session is connected — so the success case is silent. */
export function withNextAction(facts: {
  running: boolean;
  sessionCount: number;
  previouslyConnected: boolean;
  projectPreviouslyConnected: boolean;
  initialized: boolean;
  devServerPorts?: readonly number[];
}): { nextAction?: string } {
  const next = statusNextAction(facts);
  return next === undefined ? {} : { nextAction: next };
}

/**
 * What `status` says about a project whose daemons have split in two.
 *
 * Both halves in one place because they are one condition asked from two positions, and a command
 * can be standing on either. Silent — no key at all — when there is nothing to report, so a healthy
 * run reads exactly as it did.
 */
export function splitBrainFields(
  port: number,
  projectId: string | undefined,
): { splitBrain?: string } {
  const home = reticleStateHome();
  const elsewhere = splitBrainNote(
    port,
    daemonsServingProjectElsewhere(projectId, port, home, isAlive, (other: number) =>
      hasProjectConnectedBefore(home, other, projectId),
    ),
  );
  const note =
    elsewhere ?? wrongDaemonNote(port, resolveDaemonForProject(projectId, home, isAlive));
  return note === undefined ? {} : { splitBrain: note };
}
