/**
 * Write a file so a reader never sees a half-written one, and two writers never see each other's.
 *
 * Write to a temporary sibling, then rename. The rename is what makes it atomic: on a POSIX
 * filesystem it either replaces the destination entirely or does not happen, so a reader gets the
 * old file or the new one and never a truncated middle.
 *
 * TWO properties, and the second is the one that was missing. Five stores in this package built
 * this by hand and named the temp file after the DESTINATION — `${path}.tmp` — which is shared by
 * every process writing that path. Two daemons on one repository then write the same temp file:
 * one truncates the other mid-write and renames the remains into place, and the survivor is a file
 * neither of them produced. Two other stores already pid-suffixed theirs, so the fix was known and
 * had simply never been carried to the rest.
 *
 * Running parallel agent sessions against one checkout is the ordinary way to reach this, not an
 * exotic one.
 *
 * The temp file stays BESIDE its destination rather than in the system temp directory, because a
 * rename across devices is not atomic and `/tmp` is routinely a different device.
 *
 * One helper rather than five corrected copies: the sixth store gets this for free and cannot get
 * it wrong, which is the only version of this fix that stays fixed.
 */
import type { FileSystemPort } from './fs-port.js';

/**
 * Unique per WRITE, not per process.
 *
 * The pid separates two daemons. It does not separate two concurrent writes inside ONE daemon —
 * `Promise.all` over two store saves, or two scheduled flushes of the same ledger — and those share
 * a pid, so a pid-only name puts them straight back on the same temp file. The first version of
 * this helper had exactly that hole and its own concurrency test found it.
 *
 * A counter rather than `Math.random()`: rule 7 keeps the clock and the random source out of pure
 * logic, and a monotonic counter is deterministic, collision-free within a process, and needs
 * neither.
 */
let writeSeq = 0;

export function tempNameFor(path: string, pid: number = process.pid, seq?: number): string {
  writeSeq += 1;
  return `${path}.${String(pid)}.${String(seq ?? writeSeq)}.tmp`;
}

/**
 * What Windows answers, for a moment, when another writer is still replacing the destination.
 * POSIX never refuses such a rename; Windows does, and the save has to wait it out rather than
 * fail. Seen on Windows CI with two writers on one path.
 */
const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MS = 15;

function isTransientRename(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return 'string' === typeof code && TRANSIENT_RENAME.has(code);
}

export async function writeFileAtomic(
  fs: FileSystemPort,
  path: string,
  contents: string,
): Promise<void> {
  const tmp = tempNameFor(path);
  await fs.writeFile(tmp, contents);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(tmp, path);
      return;
    } catch (error: unknown) {
      if (attempt < RENAME_ATTEMPTS && isTransientRename(error)) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * attempt));
        continue;
      }
      // The write failed; its temp file must not outlive it.
      await fs.rm(tmp).catch(() => undefined);
      throw error;
    }
  }
}
