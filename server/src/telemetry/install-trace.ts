import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OnboardingStepSchema } from '@reticlehq/core/telemetry';
import { reportOnboardingStep } from './onboarding-funnel.js';

/**
 * What the one-line installer could not report itself.
 *
 * `install.sh` runs before there is a CLI, so the three steps that can fail before Reticle exists —
 * the script starting, the runtime check, the npm install — have nobody to emit them. It appends
 * them to a file instead, and this drains that file on the first CLI run.
 *
 * The alternative was POSTing from bash, which means a second copy of the envelope: the anonymous
 * id, the opt-out check, the event shape. That copy is a thing to keep in step with the original,
 * and this repository's own history is a list of what happens when two lists must agree and one is
 * edited. One emitter, one envelope.
 *
 * THE LIMIT, stated rather than discovered: an install that dies before the CLI exists is never
 * reported at all. `runtime_ready failed no_node` is written and then nothing ever reads it. That
 * is the cost of not duplicating the envelope, and it is bounded — the machines it loses are the
 * ones with no Reticle on them.
 */
const TRACE_FILE = 'install-trace.jsonl';

/**
 * How many lines will ever be drained.
 *
 * The file is on disk, in a directory the user owns, and a runaway installer loop or a hand-edited
 * file must not turn into thousands of events. Far above any real install, which writes three.
 */
const MAX_LINES = 32;

/**
 * Drain the installer's breadcrumbs, once.
 *
 * Deleted whether or not every line parsed: a file that stays is a file that re-reports the same
 * install on every CLI invocation for the life of the machine, which would make the first funnel
 * step count users-times-commands instead of users.
 */
export function drainInstallTrace(stateDir: string): number {
  const path = join(stateDir, TRACE_FILE);
  if (!existsSync(path)) return 0;
  let drained = 0;
  try {
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    for (const line of lines.slice(0, MAX_LINES)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a truncated last write, or something that is not ours. Skip it, keep the rest.
      }
      // VALIDATED, because this came off disk. `reportOnboardingStep` validates too, and that is
      // deliberate belt-and-braces: this is the one path where the payload is a file a person can
      // edit, and rule 3 is that unvalidated text never reaches the wire.
      const step = OnboardingStepSchema.safeParse(parsed);
      if (!step.success) continue;
      void reportOnboardingStep(step.data);
      drained += 1;
    }
  } catch {
    /* unreadable trace is not worth a word to the user */
  }
  try {
    rmSync(path, { force: true });
  } catch {
    /* a trace we cannot delete would re-report; nothing we can do about it here */
  }
  return drained;
}
