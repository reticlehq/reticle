/**
 * `.reticle` folders whose runs never reached the platform, and why.
 *
 * The daemon skipped every root without a link and said nothing: one repo held 31 runs nobody sent
 * while the log repeated `reticle_cloud_unlinked` about a different folder. Counted here, from run
 * ids on disk against the ids the platform accepted, so `reticle sync`, `doctor`, the HUD and the
 * platform report can each name the folder and the one command that fixes it.
 */
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { DRIVE_RECORD_SUFFIX, UNMATCHED_SUBDIR } from '@/memory/project/dir/reticle-dir.js';
import { diskSource, readCloudState } from './sync-disk.js';

export interface UnsyncedRoot {
  root: string;
  /** Runs on disk the platform has not accepted. */
  runs: number;
  /** Flows on disk nothing will send: see `unsentFlowCount`. */
  flows: number;
  /** Whether this folder holds a link. False is the case nothing will ever send. */
  linked: boolean;
}

const RUN_SUFFIX = '.json';
/** The folder the command is run from, named when it is the one the person is already in. */
const HERE = 'this folder';

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
      .filter((file) => file.endsWith(RUN_SUFFIX) && !file.endsWith(DRIVE_RECORD_SUFFIX))
      .filter((file) => !sent.has(file.slice(0, -RUN_SUFFIX.length))).length;
  } catch {
    return 0;
  }
}

/**
 * Flows in `root` that will not reach the platform: all of them when nothing sends them (the root is
 * not linked, has no key for its host, or has flow sync switched off), else the ones the platform
 * refused. A flow waiting on a root that does send them is not counted: a save wakes the next cycle.
 * Never throws.
 */
export function unsentFlowCount(root: string, sendsFlows: boolean): number {
  try {
    if (!sendsFlows) return diskSource(root).flows().length;
    return readCloudState(root).refusedSets?.flow?.count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Every root here with runs or flows the platform does not have. Roots are deduped; order is kept.
 * `sendsFlows` defaults to `isLinked`: a linked root sends its flows unless flow sync is off.
 */
export async function unsyncedRoots(
  roots: readonly string[],
  isLinked: (root: string) => Promise<boolean>,
  sendsFlows: (root: string) => Promise<boolean> = isLinked,
): Promise<UnsyncedRoot[]> {
  const out: UnsyncedRoot[] = [];
  for (const root of new Set(roots)) {
    const runs = unsentRunCount(root);
    const linked = await isLinked(root).catch(() => false);
    const flows = unsentFlowCount(root, linked && (await sendsFlows(root).catch(() => false)));
    if (0 === runs && 0 === flows) continue;
    out.push({ root, runs, flows, linked });
  }
  return out;
}

/**
 * The buckets under `~/.reticle/unmatched/` — evidence no project claimed, which nothing sends. After
 * the first warning nothing named them again: not `status`, not `connect`, not the dashboard's
 * unsent list. Never throws.
 */
export function unmatchedRoots(home: string): string[] {
  const dir = join(home, ReticleDir.ROOT, UNMATCHED_SUBDIR);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/** Whether a root is one of those buckets. */
function isUnmatchedRoot(root: string): boolean {
  const parent = dirname(root);
  return UNMATCHED_SUBDIR === basename(parent) && ReticleDir.ROOT === basename(dirname(parent));
}

/** The project a `.reticle` folder belongs to: where a person runs the command that sends it. */
export function projectFolderOf(root: string): string {
  return ReticleDir.ROOT === basename(root) ? dirname(root) : root;
}

/** One line a person can act on: where the runs are, and the command that sends them. */
export function describeUnsynced(entry: UnsyncedRoot, from: string): string {
  // Forward slashes on every platform, as the platform report writes `~/...`: one spelling of a
  // folder whether it is read in a Windows terminal, the HUD or the dashboard.
  const folder = projectFolderOf(entry.root);
  const where =
    0 === relative(from, folder).length ? HERE : relative(from, folder).split(sep).join('/');
  const what = [
    ...(0 < entry.runs ? [`${String(entry.runs)} run(s)`] : []),
    ...(0 < entry.flows ? [`${String(entry.flows)} flow(s)`] : []),
  ].join(' and ');
  if (isUnmatchedRoot(entry.root)) {
    return (
      `${what} in ${entry.root.split(sep).join('/')} are not on your dashboard: no project claimed ` +
      'them — the checkout that made them shares its project id with another, or has none. They stay ' +
      'on this machine; serve the app from the checkout that owns the id, or give this one its own, so new work reaches it'
    );
  }
  // `connect`, not `link`: it signs in first when it has to, so it is the one command that works.
  if (!entry.linked)
    return `${what} in ${where} are not on your dashboard: run \`reticle connect\` there`;
  // A linked root counts flows only when flow sync is off or the platform refused them.
  return 0 < entry.flows
    ? `${what} in ${where} are not on your dashboard: \`reticle config --flows on\` there if flow ` +
        'sync is off; `reticle sync` names any the platform refused'
    : `${what} in ${where} are waiting to be sent: run \`reticle sync\` there`;
}
