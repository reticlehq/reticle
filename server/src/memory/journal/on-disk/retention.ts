import { basename, join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { reticleDirPaths, visualDir } from '@/memory/project/dir/reticle-dir.js';
import { EVIDENCE_DIRS } from './workspace-tiers.js';

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
const PNG_SUFFIX = '.png';

/**
 * The TOTAL the evidence tier of one `.reticle/` may occupy, across sessions, runs, overlay diffs
 * and feedback copies together.
 *
 * Every bound above this line counts things, and a count cannot see a size: twenty session
 * directories is twenty UNBOUNDED directories. A workspace in the field grew to multiple gigabytes
 * with all three counts being honoured the whole time, because one drive against a chatty app
 * appends response bodies and DOM text for as long as the drive lasts, and nothing was looking at
 * the total.
 *
 * Why this number and not one an order of magnitude either side. An ordinary session journal is
 * hundreds of kilobytes to a few megabytes; a long drive against an app with large JSON responses
 * runs to tens. Twenty of the ordinary ones fit inside this budget outright, which is the working
 * set somebody plausibly wants — the evidence a person reads is from the drive they are looking at
 * and the two before it, and nobody has ever opened the twentieth. A tenth of this (~50 MB) is
 * smaller than a single bad session, so the budget would evict the newest evidence while it was
 * still being written and the count bound could never be reached; ten times it (~5 GB) is not a
 * bound a laptop notices, and 5 GB of untouched journals is the same abandoned-Reticle report with
 * a different number in it. This is roughly one node_modules: large enough to be invisible in a
 * project checkout, small enough that it can never be the reason a disk fills.
 *
 * Both bounds stay, and they are independent on purpose. The count is the cheap guard — it needs one
 * stat per entry and it keeps the directory listing readable. The budget is the guard that holds
 * when the counts are all satisfied and the bytes are not, which is the only situation anybody has
 * actually been hurt by. Either one alone leaves the other's failure unguarded.
 */
export const DEFAULT_EVIDENCE_BUDGET_BYTES = 512 * 1024 * 1024;

/**
 * One candidate entry inside a `.reticle/`, classified by the top-level directory it lives under.
 *
 * `under` is what decides the tier, and it is looked up in the workspace tier table's `durability`
 * axis — never in the gitignore's, which answers a different question. Anything not EVIDENCE is
 * MEMORY: flows, capsules, baselines, the contract, the intent ledger. Those are small, durable
 * and the reason the directory exists, so they are never evicted, never counted, and must keep
 * being written however full the disk is.
 */
export interface TierEntry {
  /** Absolute path, and what is removed. */
  path: string;
  /** The `.reticle/` top-level entry this lives under. */
  under: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** No session is open. The default everywhere, so an existing caller keeps its old behaviour. */
const NO_LIVE_SESSIONS: ReadonlySet<string> = new Set<string>();

/**
 * Is this entry the journal directory of a session that is STILL BEING WRITTEN?
 *
 * A session directory is named for its session id, so the id IS the basename. Scoped to the
 * sessions tier on purpose: a run artifact or a diff that happens to share a session's name is not
 * a journal, and nothing is holding it open.
 */
function isOpenSession(entry: TierEntry, live: ReadonlySet<string>): boolean {
  return ReticleDir.SESSIONS_SUBDIR === entry.under && live.has(basename(entry.path));
}

/**
 * Pure: the paths to remove so the EVIDENCE tier fits in `budgetBytes`. Oldest first, memory-tier
 * entries never selected and never counted. No IO — the call site stats and removes, exactly as
 * `selectPrunable` and `pruneByRecency` already split it.
 */
export function selectOverBudget(
  entries: readonly TierEntry[],
  budgetBytes: number,
  live: ReadonlySet<string> = NO_LIVE_SESSIONS,
): string[] {
  const evidence = entries.filter((entry) => EVIDENCE_DIRS.includes(entry.under));
  // Live sessions still COUNT — their bytes are on disk and the budget is about the disk. They are
  // only excluded from the eviction list, so a session over budget on its own is left alone rather
  // than deleted under its own writer.
  let total = evidence.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (total <= budgetBytes) return [];
  const doomed: string[] = [];
  for (const entry of [...evidence].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (isOpenSession(entry, live)) continue;
    if (total <= budgetBytes) break;
    doomed.push(entry.path);
    total -= entry.sizeBytes;
  }
  return doomed;
}

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

/** What a sweep is allowed to delete. Every field optional: omitting one keeps the old behaviour. */
export interface RetentionOptions {
  /** How many session directories survive the count bound. */
  retention?: number;
  /** The TOTAL the evidence tier may occupy. */
  budgetBytes?: number;
  /**
   * The ids of sessions that are STILL OPEN. Neither bound may evict one.
   *
   * Without this both bounds could delete the journal of the session currently being written, and
   * the long-running session was the FIRST candidate rather than the last: a directory's mtime is
   * stamped when it is created and never moves again — appending to a file inside it advances the
   * file's mtime, not the directory's — so an hour-long drive looks older than every short session
   * that started after it. The journal then latched its directory as ensured, every later append
   * failed ENOENT into a swallowed catch, and reads kept answering from the in-memory cache, so the
   * session reported healthy with nothing reaching disk.
   */
  live?: ReadonlySet<string> | undefined;
}

/**
 * Bound the journal on disk: keep the `retention` most-recent session directories under
 * `.reticle/sessions/`, remove the rest by mtime. Never throws — retention is best-effort maintenance,
 * so a stat/rm failure on one dir (or a missing sessions/ dir) is swallowed, never crashing a session.
 * Mirrors RunStore's amortized pruning; run on daemon start and at the end of every session.
 *
 * An open session is excluded from BOTH bounds — see `RetentionOptions.live`.
 *
 * ponytail: excluded via `keep`, so an open session is not COUNTED toward the retention cap either.
 * The directory can therefore hold `retention` + (concurrently open sessions) entries, which is a
 * handful. Count them separately only if somebody runs enough parallel sessions for it to matter.
 */
export async function pruneSessions(
  fs: FileSystemPort,
  root: string,
  options: RetentionOptions = {},
): Promise<void> {
  const live = options.live ?? NO_LIVE_SESSIONS;
  const retention = options.retention ?? DEFAULT_SESSION_RETENTION;
  await pruneByRecency(fs, reticleDirPaths(root).sessions, retention, (name) => !live.has(name));
  // The tier total is swept from here because this is the one sweep that runs on BOTH the daemon's
  // start path and the end of every session, and the end of a session is when the bytes arrive.
  await pruneEvidenceBudget(fs, root, options.budgetBytes ?? DEFAULT_EVIDENCE_BUDGET_BYTES, live);
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
  for (const dir of await visualDirs(fs, root)) {
    await pruneByRecency(fs, dir, retention, isDiff);
  }
}

/** `visual/` plus its per-runtime subdirectories. Empty when nothing has been captured yet. */
async function visualDirs(fs: FileSystemPort, root: string): Promise<string[]> {
  const top = visualDir(root);
  const dirs = [top];
  try {
    // A per-runtime subdirectory is anything here that is not itself a PNG.
    for (const entry of await fs.readdir(top)) {
      if (!entry.endsWith(PNG_SUFFIX)) dirs.push(join(top, entry));
    }
  } catch {
    return [];
  }
  return dirs;
}

const isDiff = (name: string): boolean => name.endsWith(DIFF_SUFFIX);

/**
 * Bytes under `path`, summed recursively. A session journal is a DIRECTORY, and `stat` on one
 * reports the dirent, not the megabytes of JSONL inside it.
 *
 * readdir-first because the port exposes no `isDirectory`: a readdir that fails is a file, and its
 * own stat answers. Never throws — an unreadable entry contributes nothing, which can only make the
 * sweep evict less than it should, never more.
 */
async function sizeOf(fs: FileSystemPort, path: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(path);
  } catch {
    try {
      return (await fs.stat(path)).size;
    } catch {
      return 0;
    }
  }
  let total = 0;
  for (const name of names) total += await sizeOf(fs, join(path, name));
  return total;
}

/**
 * Every evidence entry in this `.reticle/`, sized and dated. The IO half of the byte budget.
 *
 * `visual/` is the one evidence directory holding something that is not evidence — the PNG
 * BASELINES a comparison means anything against — so the same `.diff.png` filter `pruneVisualDiffs`
 * applies is applied here. The tier list is the coarse rule; that filter is the finer one, and
 * deleting a baseline to save disk turns the next run's verdict into `baseline-missing`.
 */
async function collectEvidence(fs: FileSystemPort, root: string): Promise<TierEntry[]> {
  const entries: TierEntry[] = [];
  for (const under of EVIDENCE_DIRS) {
    const isVisual = ReticleDir.VISUAL_SUBDIR === under;
    const dirs = isVisual ? await visualDirs(fs, root) : [join(root, under)];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue; // nothing written here yet
      }
      for (const name of names) {
        if (isVisual && !isDiff(name)) continue;
        const path = join(dir, name);
        try {
          const { mtimeMs } = await fs.stat(path);
          entries.push({ path, under, sizeBytes: await sizeOf(fs, path), mtimeMs });
        } catch {
          /* unreadable entry — skip */
        }
      }
    }
  }
  return entries;
}

/**
 * Hold the evidence tier of one `.reticle/` under a TOTAL byte budget, evicting oldest-first.
 *
 * The memory tier is not read, not counted and not touched: the maintainer's constraint is a cap
 * that never stops memory and flows being created, so a full disk costs somebody their session
 * journals and never their flows.
 *
 * Never throws, like everything else here. Retention is maintenance, and maintenance must never be
 * the reason a daemon fails to come up or a session dies.
 */
export async function pruneEvidenceBudget(
  fs: FileSystemPort,
  root: string,
  budgetBytes: number = DEFAULT_EVIDENCE_BUDGET_BYTES,
  live: ReadonlySet<string> = NO_LIVE_SESSIONS,
): Promise<void> {
  try {
    for (const path of selectOverBudget(await collectEvidence(fs, root), budgetBytes, live)) {
      try {
        await fs.rm(path);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* maintenance never fails a daemon */
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
  await pruneByRecency(fs, join(root, ReticleDir.FEEDBACK_SUBDIR), retention);
}
