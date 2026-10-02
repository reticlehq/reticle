import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What was on disk, twice, and what moved between.
 *
 * This is the whole of the artifact channel's observation, and its honesty rests on one idea: the
 * filesystem is asked what is there, rather than the tool being asked what it did. A tool can
 * believe it wrote a file and be wrong; it cannot make `lstat` agree with it.
 *
 * Deliberately a BEFORE and AFTER pair rather than a watcher. A recursive watch was tried and
 * rejected: on macOS a write-to-temp-then-rename emits two rename events with no create and no
 * change, and a deletion is indistinguishable from a creation, so every anomaly built on it fires
 * on the atomic-write pattern that most careful tools use. The pair sees net effect only, which is
 * less, and is true.
 */

/** What is known about one path. A value object: two of these compare by their fields. */
export interface FileFact {
  /** Content hash, absent for a thing that has no content: a symlink, a directory entry. */
  readonly hash: string | undefined;
  readonly size: number;
  /** Permission bits only. A mode change leaves every byte identical and is still a change. */
  readonly mode: number;
  /** Where a symlink points. Absent for a regular file. */
  readonly linkTo: string | undefined;
}

export interface Snapshot {
  readonly files: ReadonlyMap<string, FileFact>;
  /**
   * Roots that could not be read.
   *
   * Reported rather than treated as empty. Silently reading a missing directory as an empty one
   * makes every `absent` claim over it true and every `present` claim false, for a reason that has
   * nothing to do with the subject -- which is the protocol's own distinction between "nothing was
   * watching" and "it did not happen", arriving as a filesystem error.
   */
  readonly unreadable: readonly string[];
}

export const ChangeKind = {
  WRITTEN: 'written',
  DELETED: 'deleted',
  MODIFIED: 'modified',
  /** The bytes are identical and what the world may do with them is not. */
  MODE_CHANGED: 'mode-changed',
} as const;
export type ChangeKind = (typeof ChangeKind)[keyof typeof ChangeKind];

export interface Change {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly before: FileFact | undefined;
  readonly after: FileFact | undefined;
}

/**
 * Directories whose contents are somebody else's, and are hashed at real cost.
 *
 * Measured rather than assumed: hashing one `node_modules` ran to tens of thousands of files and
 * more than a gigabyte, and every window takes TWO snapshots. Excluded by default and overridable,
 * because a tool whose job is to write `dist/` needs `dist/` watched.
 *
 * The exclusion is reported as coverage, never hidden. An empty blind-spot list is a positive
 * claim that nothing was hidden.
 */
export const EXCLUDED_BY_DEFAULT: readonly string[] = ['node_modules', '.git', 'dist', '.next'];

export interface SnapshotOptions {
  /** Directory names skipped wherever they appear. Defaults to `EXCLUDED_BY_DEFAULT`. */
  readonly exclude?: readonly string[];
}

/** What is under these roots right now. */
export function takeSnapshot(roots: readonly string[], options: SnapshotOptions = {}): Snapshot {
  const exclude = new Set(options.exclude ?? EXCLUDED_BY_DEFAULT);
  const files = new Map<string, FileFact>();
  const unreadable: string[] = [];
  for (const root of roots) walk(root, exclude, files, unreadable, root);
  return { files, unreadable };
}

/**
 * `lstat`, not `stat`, and the difference is the point.
 *
 * `stat` follows a symlink and reports the thing at the other end, so a link created where a file
 * used to be reads as the file, unchanged. `lstat` reports the link itself, which is what actually
 * appeared on disk.
 */
function walk(
  dir: string,
  exclude: ReadonlySet<string>,
  into: Map<string, FileFact>,
  unreadable: string[],
  root: string,
): void {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Only the root is worth naming: a directory that vanished mid-walk is a race, and reporting
    // every one of them would bury the case a reader can act on.
    if (dir === root) unreadable.push(dir);
    return;
  }
  for (const entry of entries) {
    if (exclude.has(entry)) continue;
    const path = join(dir, entry);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(path, exclude, into, unreadable, root);
      continue;
    }
    into.set(path, factOf(path, stat.size, stat.mode & 0o777, stat.isSymbolicLink()));
  }
}

function factOf(path: string, size: number, mode: number, isLink: boolean): FileFact {
  if (isLink) {
    // A link has no content of its own. What it POINTS AT is the fact worth holding: a link
    // repointed at a different target is a change, and its size on disk may not move.
    return { hash: undefined, size, mode, linkTo: readTarget(path) };
  }
  return { hash: hashOf(path), size, mode, linkTo: undefined };
}

function readTarget(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The content hash, which is the only thing that decides whether content changed.
 *
 * Size and mtime may decide when to LOOK and never what changed: two writes inside the same second
 * of equal length produce identical mtime, identical size and different bytes, and a comparison
 * that stopped at the cheap fields would report a rewritten file as untouched.
 */
function hashOf(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    // Unreadable is not unchanged, and it is not a hash either. `undefined` means nobody could
    // look, which `diffSnapshots` must not read as "the same".
    return undefined;
  }
}

/**
 * What moved between two snapshots.
 *
 * Pure: two snapshots in, a list out, no filesystem and no clock. That is what makes the
 * interesting comparisons testable without arranging for them on a real disk.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): readonly Change[] {
  const changes: Change[] = [];
  for (const [path, now] of after.files) {
    const then = before.files.get(path);
    if (then === undefined) {
      changes.push({ path, kind: ChangeKind.WRITTEN, before: undefined, after: now });
      continue;
    }
    const kind = changeBetween(then, now);
    if (kind !== undefined) changes.push({ path, kind, before: then, after: now });
  }
  for (const [path, then] of before.files) {
    if (!after.files.has(path)) {
      changes.push({ path, kind: ChangeKind.DELETED, before: then, after: undefined });
    }
  }
  return changes;
}

/**
 * How one path differs from itself, or undefined when it does not.
 *
 * Content outranks mode: a file whose bytes AND permissions both changed is reported as modified,
 * because that is the change a reader cares about and the mode is a detail of it. The reverse
 * ordering would file a rewritten executable under `mode-changed`.
 */
function changeBetween(before: FileFact, after: FileFact): ChangeKind | undefined {
  if (before.linkTo !== after.linkTo) return ChangeKind.MODIFIED;
  // An unreadable file on either side is NOT evidence of sameness. Two `undefined` hashes mean
  // nobody could look twice, which must not read as "identical".
  const unknown = before.hash === undefined || after.hash === undefined;
  if (unknown ? before.size !== after.size : before.hash !== after.hash) {
    return ChangeKind.MODIFIED;
  }
  if (before.mode !== after.mode) return ChangeKind.MODE_CHANGED;
  return undefined;
}
