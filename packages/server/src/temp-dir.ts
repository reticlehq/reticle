/**
 * Removing a temp directory on Windows, without inventing a product failure.
 *
 * `rm(dir, { recursive: true, force: true })` is the obvious teardown and it is not enough on
 * Windows. Deletion there is not immediate: a handle the OS, the indexer or a virus scanner still
 * holds keeps the entry alive for a moment after the last close, so the directory is observed
 * non-empty at the instant `rmdir` runs and Node throws `ENOTEMPTY`. `force` does not cover it —
 * that suppresses "missing", not "busy".
 *
 * The failure lands in `afterEach`, so it is reported against the test that just PASSED, and the
 * leftover directory then bleeds state into what runs next. On CI this presented as five failures in
 * one file, four of them consequential and one of them the wonderfully misleading "expected length 1
 * but got 2" — a fake production bug manufactured entirely by teardown. This repo already has that
 * exact story written up in `project-store.test.ts` about a timed-out test's stray writes; this is the
 * same failure arriving through the filesystem instead of through the clock.
 *
 * `maxRetries`/`retryDelay` exist in Node for precisely this, and are documented as Windows-oriented.
 * They are a no-op on POSIX, where the first attempt already succeeds.
 */

import { rm } from 'node:fs/promises';

/**
 * Retries and backoff. Small and bounded: this is covering a millisecond-scale handle release, so if
 * it has not gone in half a second the cause is not a race and a slower retry would only hide it.
 */
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 50;

/**
 * Delete a temp directory tree, tolerating Windows' delayed handle release.
 *
 * Never throws: a temp directory that outlives the test is the operating system's problem, not a
 * reason to fail a run or to report a defect the product does not have. What must not happen is the
 * opposite — a red that says nothing about the code under test.
 */
export async function removeTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: MAX_RETRIES,
      retryDelay: RETRY_DELAY_MS,
    });
  } catch {
    // Deliberately swallowed — see above. The OS reclaims the temp directory regardless.
  }
}
