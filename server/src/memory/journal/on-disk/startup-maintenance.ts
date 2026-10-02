/**
 * Everything Reticle prunes in ONE `.reticle/` workspace, in one place.
 *
 * Called from two moments and both matter: daemon start (the daemon's own tree) and session end
 * (the tree that SESSION wrote into). Those are usually different directories — a globally
 * registered daemon stands in `$HOME` — and the per-project one is where the bytes actually
 * accumulate, so sweeping only the first swept the wrong tree for the common case.
 *
 * The four bounds were inlined at the call site and one of them was simply missing:
 * `pruneEvidenceBudget` had been written, tested, and never called by anything. The three COUNT
 * bounds were wired and the BYTE bound was not, which is the combination the budget's own header
 * warns about -- "twenty session directories is twenty UNBOUNDED directories", beside a field
 * report of a multi-gigabyte `.reticle/sessions` with all three counts honoured throughout.
 *
 * Counts and bytes answer different questions and neither substitutes for the other. A count says
 * how MANY sessions are kept; it says nothing about how large one is allowed to get. A chatty app
 * writes one enormous journal and never trips a count.
 *
 * Gathered into a function rather than left as four statements so that "what maintenance runs at
 * startup" has one answer that can be TESTED. Inlined, the only way to check the budget was wired
 * was to grep the call site for its name -- and a grep passes on a comment that quotes the code,
 * which has already happened in this repository.
 *
 * Order: counts first, budget last. The counts are cheap and bounded; the budget walks and sizes
 * what the counts leave behind, so running it second means it sizes less.
 *
 * NEVER THROWS. Maintenance must not be the reason a daemon fails to come up, and each prune below
 * already swallows its own errors -- this only has to avoid adding a new way to fail.
 */
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import {
  pruneEvidenceBudget,
  pruneFeedback,
  pruneSessions,
  pruneVisualDiffs,
} from './retention.js';
import { DEFAULT_RETAIN, type RetainPolicy } from './retain-policy.js';

/**
 * What this sweep is allowed to keep. Every field optional, defaulting to the built-in bound.
 *
 * Partial rather than a whole `RetainPolicy` for two reasons that happen to agree: a test states
 * only the bound it is exercising instead of writing half a gigabyte to disk, and a project's
 * `.reticle.json` states only the bounds it cares about. Same reason the clock is injected
 * everywhere else here — a bound that can only be exercised by producing the real quantity is a
 * bound nothing exercises.
 */
export type PruneWorkspaceOptions = Partial<RetainPolicy>;

export async function pruneWorkspace(
  fs: FileSystemPort,
  root: string,
  live: ReadonlySet<string>,
  options: PruneWorkspaceOptions = {},
): Promise<void> {
  const retain: RetainPolicy = { ...DEFAULT_RETAIN, ...options };
  // Empty in the ordinary case (nothing has connected yet); this path also runs on a daemon that is
  // already serving sessions, which is why `live` is threaded rather than assumed empty.
  await pruneSessions(fs, root, { live, retention: retain.sessions });
  // The largest thing in the workspace, and for a long time the only one with no delete path.
  await pruneVisualDiffs(fs, root, retain.visual);
  // Write-only local copies of reports the outbox already carries.
  await pruneFeedback(fs, root, retain.feedback);
  // LAST, and the one that was missing: the only bound that limits SIZE rather than count.
  await pruneEvidenceBudget(fs, root, retain.budgetBytes, live);
}
