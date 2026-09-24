/**
 * Everything the daemon prunes when it attaches, in one place.
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
  DEFAULT_EVIDENCE_BUDGET_BYTES,
} from './retention.js';

export interface StartupMaintenanceOptions {
  /**
   * Injected so a test can state its own bound instead of writing half a gigabyte to disk.
   *
   * Same reason the clock is injected everywhere else here: a bound that can only be exercised by
   * producing the real quantity is a bound nothing exercises.
   */
  budgetBytes?: number;
}

export async function pruneOnStartup(
  fs: FileSystemPort,
  root: string,
  live: ReadonlySet<string>,
  options: StartupMaintenanceOptions = {},
): Promise<void> {
  // Empty in the ordinary case (nothing has connected yet); this path also runs on a daemon that is
  // already serving sessions, which is why `live` is threaded rather than assumed empty.
  await pruneSessions(fs, root, { live });
  // The largest thing in the workspace, and for a long time the only one with no delete path.
  await pruneVisualDiffs(fs, root);
  // Write-only local copies of reports the outbox already carries.
  await pruneFeedback(fs, root);
  // LAST, and the one that was missing: the only bound that limits SIZE rather than count.
  await pruneEvidenceBudget(fs, root, options.budgetBytes ?? DEFAULT_EVIDENCE_BUDGET_BYTES, live);
}
