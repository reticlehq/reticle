import { takeSnapshot, type SnapshotOptions } from './snapshot.js';

export type { Snapshot, Change, FileFact } from './snapshot.js';
export { ChangeKind, diffSnapshots, takeSnapshot, EXCLUDED_BY_DEFAULT } from './snapshot.js';

/**
 * A place the subject can leave something behind, and a way to look at it twice.
 *
 * A PORT, and a SEPARATE one from `Supervisor` rather than a method on it. The two answer
 * different questions -- what did the process do, and what is on disk -- and a realm that watches
 * a workspace without spawning anything is a perfectly sensible thing that should not have to
 * implement `run`.
 *
 * It is OPTIONAL on the realm, which is the substance rather than the convenience: a realm with no
 * workspace declares no artifact channel, so `couldEverProve` is false and it says so at startup.
 * Declaring a channel and then having nothing to report on it is the lie that makes every claim
 * come back `unknown` while the implementation looks capable.
 */
export interface WorkspacePort {
  /** What is watched. Named so coverage can say what was outside it. */
  readonly roots: readonly string[];
  /** What is there now. Called twice per window: once before the action, once after. */
  snapshot(): import('./snapshot.js').Snapshot;
}

/** The port over a real filesystem. */
export function nodeWorkspace(
  roots: readonly string[],
  options: SnapshotOptions = {},
): WorkspacePort {
  return { roots, snapshot: () => takeSnapshot(roots, options) };
}
