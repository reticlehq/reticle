/**
 * Install the one handler that turns a bug of ours into a sentence.
 *
 * Its own module because `cli.ts` is at the 1000-line cap and this is a whole idea rather than a
 * few lines of wiring: what a crash prints, where the trace goes, and what gets cleaned up on the
 * way out. The rules it obeys live in `setup/terminal/crash.ts`.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stopOnCrash } from '../setup/terminal/crash.js';
import { stopRunningDevServer } from '../setup/setup-command.js';

/** Where a crash of our own leaves its trace. Never a stream — see setup/terminal/crash.ts. */
export const CRASH_LOG_NAME = '.reticle-setup-crash.log';

/**
 * Catch our own faults for the whole process.
 *
 * At the entry point rather than inside the phase that owns the dev server, because a fault can
 * fire in any phase: the first attempt at this sat inside the runtime phase and caught nothing in
 * two different environments, because `init` had already returned by the time the handler existed.
 * The prototype this was ported from had it at module scope for exactly that reason.
 */
export function installCrashGuard(): () => void {
  return stopOnCrash(stopRunningDevServer, process, (message, stack) => {
    const crashLog = join(process.cwd(), CRASH_LOG_NAME);
    try {
      writeFileSync(crashLog, stack);
    } catch {
      /* an unwritable directory is not worth a second crash */
    }
    process.stderr.write(
      `reticle hit a bug of its own and stopped: ${message}. Anything it had already done is done, and re-running is safe. Please report it — the trace is in ${crashLog}.\n`,
    );
  });
}
