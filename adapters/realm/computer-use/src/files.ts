/**
 * A file that was written again with the same bytes.
 *
 * The snapshot of a watched folder compares what each file holds. An application that writes the
 * same bytes again did write, and the snapshot shows no change. The time of the write shows it.
 * The realm and the peer both need this, so it is here once.
 */
import { statSync } from 'node:fs';

import type { Snapshot } from '@reticlehq/cli-realm';

/** The kind of a write that left the same bytes. The snapshot has no word for it. */
export const REWRITTEN = 'rewritten';

export type WriteTimeOf = (path: string) => number | undefined;
export type WriteTimes = ReadonlyMap<string, number | undefined>;

export const writeTimeOnDisk: WriteTimeOf = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

/** When each file of a snapshot was last written. */
export function writeTimesOf(snapshot: Snapshot, timeOf: WriteTimeOf): WriteTimes {
  return new Map([...snapshot.files.keys()].map((path) => [path, timeOf(path)]));
}

/**
 * The files that are in both looks with no change that the snapshot shows, and a new write time.
 * `changed` holds the paths that the snapshot already reports, so that no file is said twice.
 */
export function rewrittenSince(
  times: WriteTimes,
  after: Snapshot,
  changed: ReadonlySet<string>,
  timeOf: WriteTimeOf,
): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  for (const [path, was] of times) {
    const fact = after.files.get(path);
    if (fact === undefined || changed.has(path)) {
      continue;
    }
    const now = timeOf(path);
    if (now !== undefined && now !== was) {
      out.push({ path, size: fact.size });
    }
  }
  return out;
}
