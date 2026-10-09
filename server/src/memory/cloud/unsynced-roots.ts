/**
 * `.reticle` folders whose runs never reached the platform, and why.
 *
 * The daemon skipped every root without a link and said nothing: one repo held 31 runs nobody sent
 * while the log repeated `reticle_cloud_unlinked` about a different folder. Counted here, from run
 * ids on disk against the ids the platform accepted, so `reticle sync`, `doctor`, the HUD and the
 * platform report can each name the folder and the one command that fixes it.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { readCloudState } from './sync-disk.js';

export interface UnsyncedRoot {
  root: string;
  /** Runs on disk the platform has not accepted. */
  runs: number;
  /** Whether this folder holds a link. False is the case nothing will ever send. */
  linked: boolean;
}

const RUN_SUFFIX = '.json';

/**
 * Run files in `root` the platform never accepted. Ids only — a run file is named by its id — so
 * this costs a directory listing, never a payload read. Never throws.
 */
export function unsentRunCount(root: string): number {
  try {
    const dir = join(root, ReticleDir.RUNS_SUBDIR);
    if (!existsSync(dir)) return 0;
    const state = readCloudState(root);
    const sent = new Set([...Object.keys(state.sentRunHashes ?? {}), ...(state.sentRunIds ?? [])]);
    return readdirSync(dir)
      .filter((file) => file.endsWith(RUN_SUFFIX))
      .filter((file) => !sent.has(file.slice(0, -RUN_SUFFIX.length))).length;
  } catch {
    return 0;
  }
}

/** Every root here with runs the platform does not have. Roots are deduped; order is kept. */
export async function unsyncedRoots(
  roots: readonly string[],
  isLinked: (root: string) => Promise<boolean>,
): Promise<UnsyncedRoot[]> {
  const out: UnsyncedRoot[] = [];
  for (const root of new Set(roots)) {
    const runs = unsentRunCount(root);
    if (0 === runs) continue;
    out.push({ root, runs, linked: await isLinked(root).catch(() => false) });
  }
  return out;
}

/** One line a person can act on: where the runs are, and the command that sends them. */
export function describeUnsynced(entry: UnsyncedRoot, from: string): string {
  const where = relative(from, entry.root) || entry.root;
  return entry.linked
    ? `${String(entry.runs)} run(s) in ${where} are waiting to be sent: run \`reticle sync\` there`
    : `${String(entry.runs)} run(s) in ${where} were never sent: run \`reticle link\` there`;
}
