import { join } from 'node:path';
import type { FileSystemPort } from '../../project/fs/fs-port.js';
import { reticleDirPaths, visualDir } from '../../project/dir/reticle-dir.js';

/** Keep at most this many session journals on disk; older ones are pruned by recency. */
export const DEFAULT_SESSION_RETENTION = 20;

/**
 * Keep at most this many overlay diffs. Small on purpose: a diff is looked at in the minute after
 * the comparison that produced it, or never.
 */
export const DEFAULT_DIFF_RETENTION = 10;

/**
 * Keep at most this many local feedback copies. The outbox is the record; these are a convenience
 * for the one case where delivery was refused and somebody has to file the report by hand.
 */
export const DEFAULT_FEEDBACK_RETENTION = 20;

const DIFF_SUFFIX = '.diff.png';

/** Where refused feedback reports are copied. Named here because the writer lives in another area. */
const FEEDBACK_SUBDIR = 'feedback';

interface DatedDir {
  name: string;
  mtimeMs: number;
}

/**
 * Pure: given session dirs with their mtimes, the names to remove so only the `retention` most-recent
 * remain. Oldest-first. Exported for testing (no IO).
 */
export function selectPrunable(dirs: readonly DatedDir[], retention: number): string[] {
  if (dirs.length <= retention) return [];
  return [...dirs]
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, dirs.length - retention)
    .map((d) => d.name);
}

/**
 * Keep the `retention` most-recent entries of `dir`, remove the rest by mtime.
 *
 * The one rule behind all three callers below — journals, overlay diffs, feedback copies. Never
 * throws: retention is maintenance, and maintenance must never be the reason a daemon fails to come
 * up or a session dies. A missing directory, an unstattable entry and a failed remove are all just
 * "nothing to do here".
 *
 * @param keep an entry this returns false for is not a candidate and is never counted, so a
 * directory holding two kinds of file can have one of them capped.
 */
async function pruneByRecency(
  fs: FileSystemPort,
  dir: string,
  retention: number,
  keep: (name: string) => boolean = () => true,
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return; // nothing written here yet
  }
  const dated: DatedDir[] = [];
  for (const name of names) {
    if (!keep(name)) continue;
    try {
      const { mtimeMs } = await fs.stat(join(dir, name));
      dated.push({ name, mtimeMs });
    } catch {
      /* unstattable entry — skip */
    }
  }
  for (const name of selectPrunable(dated, retention)) {
    try {
      await fs.rm(join(dir, name));
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Bound the journal on disk: keep the `retention` most-recent session directories under
 * `.reticle/sessions/`, remove the rest by mtime. Never throws — retention is best-effort maintenance,
 * so a stat/rm failure on one dir (or a missing sessions/ dir) is swallowed, never crashing a session.
 * Mirrors RunStore's amortized pruning; run on daemon start.
 */
export async function pruneSessions(
  fs: FileSystemPort,
  root: string,
  retention: number = DEFAULT_SESSION_RETENTION,
): Promise<void> {
  await pruneByRecency(fs, reticleDirPaths(root).sessions, retention);
}

/**
 * Bound `.reticle/visual/` — the largest thing in the workspace, and the only one with no delete
 * path at all.
 *
 * Only the overlay DIFFS are pruned. Nothing reads a diff back: it is written, its path is handed
 * to the caller, and a human opens it immediately or not at all — it is derived from a baseline and
 * a screenshot, both of which outlive it. A BASELINE is the reference that makes a comparison mean
 * anything, so deleting one to save disk turns the next run's verdict into `baseline-missing`, which
 * is worse than a large directory.
 *
 * Walks one level into the per-runtime subdirectories (`visual/electron/`), because a desktop run's
 * diffs are the same kind of garbage in a different folder. Best-effort throughout, like
 * `pruneSessions`: this is maintenance, and maintenance must never be the reason a daemon fails.
 */
export async function pruneVisualDiffs(
  fs: FileSystemPort,
  root: string,
  retention: number = DEFAULT_DIFF_RETENTION,
): Promise<void> {
  const top = visualDir(root);
  const dirs = [top];
  try {
    // A per-runtime subdirectory is anything here that is not itself a PNG.
    for (const entry of await fs.readdir(top)) {
      if (!entry.endsWith('.png')) dirs.push(join(top, entry));
    }
  } catch {
    return; // no visual dir yet
  }
  for (const dir of dirs) {
    await pruneByRecency(fs, dir, retention, (name) => name.endsWith(DIFF_SUFFIX));
  }
}

/**
 * Bound `.reticle/feedback/` — local copies of reports that were already sent.
 *
 * Nothing reads the directory back: no readdir, no consumer. It exists so a report refused delivery
 * is not lost and the receipt can hand somebody a path. That makes the recent ones useful and the
 * rest dead weight. The outbox remains the record.
 *
 * Capped from here rather than from the writer, which lives in an area this file does not own. A
 * retention rule is the same rule whether the directory holds journals, diffs or reports.
 */
export async function pruneFeedback(
  fs: FileSystemPort,
  root: string,
  retention: number = DEFAULT_FEEDBACK_RETENTION,
): Promise<void> {
  await pruneByRecency(fs, join(root, FEEDBACK_SUBDIR), retention);
}
