/**
 * Can Reticle write the directory it keeps everything in?
 *
 * `~/.reticle` holds the pid files, the daemon logs, the telemetry id and outbox, and every saved
 * flow. A daemon that cannot write it does not start — and until now said nothing useful about why.
 *
 * Measured on 2.6.0 with `chmod 555 ~/.reticle`:
 *
 *   the daemon did not come up on :4415 — nothing is listening on :4415 — no daemon is running
 *   see /…/.reticle/daemon-4415.log
 *
 * The first line restates the symptom. The second points at a log **inside the unwritable
 * directory**, so the one diagnostic offered cannot exist. Someone hitting this — a locked-down home
 * directory, a container with a read-only mount, a managed corporate profile — has nothing to go on.
 *
 * Deliberately a PROBE, not a permission-bit read: `stat` says what the mode claims, and an ACL, a
 * read-only mount, SELinux or a full disk all produce a writable-looking mode and a failing write.
 * The only honest test of "can I write here" is writing.
 */
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Probe filename. Distinctive so a leftover is obviously ours, and unlinked immediately either way. */
const PROBE = '.reticle-write-probe';

/**
 * A sentence naming the problem, or `undefined` when the directory is usable.
 *
 * A directory that does not exist yet is NOT a problem: the daemon creates it, and the creation
 * failing is caught by the same probe on the parent path.
 */
export function stateDirProblem(dir: string): string | undefined {
  if (!existsSync(dir)) {
    // Not yet created is the ordinary first-run state. Only report if we cannot create it.
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return (
        `Reticle cannot create its state directory at ${dir}. Everything it keeps — the daemon ` +
        'log, the pid file, saved flows — lives there, so the daemon cannot start. Check the ' +
        'permissions on the parent directory, or point Reticle elsewhere with HOME.'
      );
    }
    return undefined;
  }
  const probe = join(dir, PROBE);
  try {
    writeFileSync(probe, '', 'utf8');
  } catch {
    return (
      `Reticle cannot write to its state directory at ${dir}. Everything it keeps — the daemon ` +
      'log, the pid file, saved flows — lives there, so the daemon cannot start. Make it writable ' +
      '(`chmod u+w`), or point Reticle elsewhere with HOME.'
    );
  }
  try {
    unlinkSync(probe);
  } catch {
    /* wrote but could not clean up: the directory IS writable, which is the question asked */
  }
  return undefined;
}
