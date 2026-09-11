import type { FileSystemPort } from '../project/fs-port.js';
import { reticleDirPaths, sessionDirPath } from '../project/reticle-dir.js';

/** Keep at most this many session journals on disk; older ones are pruned by recency. */
export const DEFAULT_SESSION_RETENTION = 20;

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
