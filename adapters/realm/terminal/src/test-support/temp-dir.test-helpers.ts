import { rmSync } from 'node:fs';

/**
 * Remove a temp folder that a test made.
 *
 * On Windows, a folder can stay locked for a short time after a test closes its last handle in it.
 * An antivirus scan, the indexer or a child process that is still exiting can hold it. `rmSync` then
 * throws `EBUSY`, `ENOTEMPTY` or `EPERM`, and the cleanup fails a test that passed (#2158). Node
 * retries exactly these errors when the call passes `maxRetries`.
 */
export function removeTempDirSync(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
