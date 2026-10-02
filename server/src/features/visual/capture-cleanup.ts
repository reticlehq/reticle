import { rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { RETICLE_CAPTURE_FILE_PREFIX } from '@reticlehq/core';

/** Private shell directories whose captures this daemon has successfully consumed. */
const captureDirectories = new Set<string>();

/**
 * Remember the private parent of a capture after the daemon has read it.
 *
 * Legacy captures live directly in `tmpdir()` and therefore have no directory to reclaim. The
 * caller has already applied the capture-path trust-boundary check; this second exact parent check
 * keeps the cleanup set limited to the one-level private layout.
 */
export function trackCaptureDirectory(path: string): void {
  const parent = dirname(path);
  if (dirname(parent) === tmpdir() && basename(parent).startsWith(RETICLE_CAPTURE_FILE_PREFIX)) {
    captureDirectories.add(parent);
  }
}

/**
 * Remove empty private capture directories during the daemon's existing awaited shutdown path.
 *
 * Deliberately `rmdir`, never recursive removal: captures are unlinked after reading, so a genuine
 * directory is empty by shutdown. If anything unexpected remains, refusing to remove the directory
 * is safer than widening a renderer-supplied path into a recursive delete.
 */
export async function cleanupCaptureDirectories(): Promise<void> {
  await Promise.all(
    [...captureDirectories].map(async (dir) => {
      try {
        await rmdir(dir);
      } catch {
        // Best-effort shutdown housekeeping. A non-empty or already-removed directory is harmless.
      } finally {
        captureDirectories.delete(dir);
      }
    }),
  );
}
