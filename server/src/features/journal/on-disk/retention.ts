import { join } from 'node:path';
import type { FileSystemPort } from '../../project/fs/fs-port.js';
import { reticleDirPaths, sessionDirPath, visualDir } from '../../project/dir/reticle-dir.js';

/** Keep at most this many session journals on disk; older ones are pruned by recency. */
export const DEFAULT_SESSION_RETENTION = 20;

/**
 * Keep at most this many overlay diffs. Small on purpose: a diff is looked at in the minute after
 * the comparison that produced it, or never.
 */
export const DEFAULT_DIFF_RETENTION = 10;

const DIFF_SUFFIX = '.diff.png';

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
  const sessionsDir = reticleDirPaths(root).sessions;
  let names: string[];
  try {
    names = await fs.readdir(sessionsDir);
  } catch {
    return; // no sessions dir yet
  }
  const dated: DatedDir[] = [];
  for (const name of names) {
    try {
      const { mtimeMs } = await fs.stat(sessionDirPath(root, name));
      dated.push({ name, mtimeMs });
    } catch {
      /* unstattable entry — skip */
    }
  }
  for (const name of selectPrunable(dated, retention)) {
    try {
      await fs.rm(sessionDirPath(root, name));
    } catch {
      /* best-effort */
    }
  }
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
    const dated: DatedDir[] = [];
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(DIFF_SUFFIX)) continue;
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
}
